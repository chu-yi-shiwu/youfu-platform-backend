// 洞①「工人退回自动回派」执行器（2026-10-28）
//
// 【消灭的洞】
//   审计实测（`docs/00_现行/自动派单_必经人工排查.md` V3）：
//     `stateMachine.ts` 退回边 `assigned --return--> pending_dispatch` 存在，
//     但退回后**没有任何自动回派**：单停在 `pending_dispatch`，出边只有
//     dispatch（人工派单）/ claim（工人自抢）/ cancel（撤销）。
//   ⇒ 「工人一退回，这单就死在那儿，非得有人来派」—— 初一铁律正面违反。
//
// 【初一 2026-10-28 三条裁定，本文件逐条实现】
//   D-1：派不出去 ⇒ **继续挂着 + 自动升级喊人**（喊多次、喊更广），**单子永不自己消失**；
//        ❌ 不引入组织架构（上级/科室）——现在库里不一定有这份数据，硬加就是凭空造关系表。
//   D-2：**不自动关单**。任何分支都不得把工单推进 cancelled 或任何终态。
//   D-5：回派次数上限 **3 次**，超限后按 D-1 处理（落池 + 喊人）。
//
// 【排除谁】排除集 = 显式 opts.excludeWorkerId ∪ row.assignee_id。
//   依据：审计实证——退回**不清** `assignee_id`
//   （`repo/ticket.ts:264` → `:290`（空则不更新该列）→ `:308` `assignee ?? cur.assignee_id`）
//   ⇒ 退回后原工人仍挂在单上，这就是"要排除谁"的现成答案，无需另存"上次谁退的"。
//
// 【为什么挂在路由层、不进 transition() 内核】见设计文档 §1.1：
//   ① 内核拿不到"是谁退的"（opts.actor 是角色字符串）；
//   ② 内核已被 systemAuto 路径复用，在内核里回派 ⇒ 链式失控；
//   ③ 项目有两处同构先例：runIncrementalLearnStep（workOrder.ts:566）、runAutoSettleStep（:583）。
//
// 【红线】本文件绝不允许出现自动关单/自动撤销/自动取消的分支（D-2）。
import type { PoolClient } from 'pg';
import {
  RETURN_EVENT,
  DEFAULT_WORK_ORDER_DEF,
  resolveDispatchTarget,
  claimableStates,
  type WorkflowDef,
} from '../engine/stateMachine.js';
import { getWorkflowDefAtVersion } from '../engine/workflowDef.js';
import { pickWorker, resolveDispatch, getActiveRules, type WorkerRow } from '../engine/dispatch.js';
import { resolveNeed } from '../engine/dispatch/needResolver.js';
import { StatsModelBackend, type ModelBackend } from '../engine/model/ModelBackend.js';
import { transition } from '../repo/ticket.js';
import { insertNotification } from './notify.js';
import { safeParseJsonb } from '../util/jsonb.js';
import type { WorkOrderStatus } from '../engine/stateMachine.js';

/** 回派次数上限默认值（初一 D-5 裁定：3 次）。可用 system_config 覆盖，无需改代码。 */
export const DEFAULT_REDISPATCH_LIMIT = 3;

/** system_config 键名（零 DDL，沿用本项目 key-value 约定）。 */
export const REDISPATCH_LIMIT_KEY = 'redispatch_limit';

/**
 * 放宽级别（与设计方案 §1.3 对齐）：
 *  - 0 = 规则严格匹配命中（dispatch_rule）
 *  - 1 = 规则未命中，least_load 兜底命中
 * 失败时不产生级别（null）。
 */
export type RelaxedLevel = 0 | 1 | null;

export interface AutoRedispatchResult {
  /** 是否认定为一次退回（return 事件）并进入回派流程。 */
  attempted: boolean;
  /** 是否真的回派成功（状态已流转且有新承接人）。 */
  redispatch: boolean;
  /** 新承接人 worker.id；失败为 null。 */
  assignee: string | null;
  /** 结果原因码，落事件 payload，供 stats 聚合。 */
  reason: string;
  /** 回派目标状态（成功时 = 实际落到的状态；失败为 null）。供调用方回写响应，避免返回过期状态。 */
  target: string | null;
  /** 放宽级别（成功时 0/1）。 */
  relaxedLevel: RelaxedLevel;
  /** 本次排除掉的工人（退回人 + 显式排除）。 */
  excludeWorkerIds: string[];
}

export interface AutoRedispatchRow {
  id: string;
  order_no: string;
  /** 退回后仍未清空 ⇒ 即"要排除的人"。 */
  assignee_id: string | null;
  business_type: string;
  priority?: string | null;
  catalog?: string | null;
  status: string;
  def_version?: number | string | null;
  /**
   * 回派次数存在 `work_orders.ext` jsonb 里（零 DDL，沿用本项目约定）。
   * 类型取 `unknown`：上游 `WorkOrderRow.ext` 本就是 `unknown`（jsonb 列），
   * 此处不假设结构，取值时用 `readRedispatchCount` 防御性收窄。
   */
  ext?: unknown;
}

/** 防御性读取 ext.redispatch_count：非对象/非数字/脏数据一律当 0（不让脏数据卡住回派）。 */
export function readRedispatchCount(ext: unknown): number {
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) return 0;
  const n = Number((ext as Record<string, unknown>).redispatch_count);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export interface AutoRedispatchOptions {
  /** 本次流转的事件名（来自 transition 结果 r.transition?.event）。 */
  event?: string | null;
  /** 操作人（留痕用，不参与门禁）。 */
  actor?: string | null;
  /** 额外要排除的工人（如调用方已知某人不可用）。 */
  excludeWorkerId?: string | null;
  /** 次数上限覆盖（缺省读 DEFAULT_REDISPATCH_LIMIT）。 */
  limit?: number;
}

/**
 * 触发器判定（纯函数，可单测）：只有 return 事件才进入自动回派。
 *
 * 保守口径：**事件缺失/为空一律不触发**。
 * 宁可不自动派（保持现状，单子在池里等人/等人抢），也不在信息不全时误派——
 * 误派会把单推进 assigned 并 +1 load，比"不派"更难回滚、更难观测。
 */
export function shouldTriggerAutoRedispatch(opts: { event?: string | null } = {}): boolean {
  return opts?.event === RETURN_EVENT;
}

/** 读取租户回派次数上限：system_config KV 优先，缺省/非法值回落默认 3。零 DDL。 */
async function resolveRedispatchLimit(client: PoolClient, tenantId: string): Promise<number> {
  try {
    const r = await client.query<{ value: unknown }>(
      'SELECT value FROM system_config WHERE tenant_id = $1 AND key = $2',
      [tenantId, REDISPATCH_LIMIT_KEY],
    );
    const raw = r.rows[0]?.value;
    const n = Number(typeof raw === 'string' ? JSON.parse(raw) : raw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  } catch (e) {
    // 缺表/权限/脏数据：一律回落默认值，绝不让配置读取失败变成 500 或阻断退回动作
    console.warn('[autoRedispatch] resolveRedispatchLimit failed, use default', {
      tenantId,
      err: e instanceof Error ? e.message : String(e),
    });
  }
  return DEFAULT_REDISPATCH_LIMIT;
}

/**
 * D-1：回派失败 ⇒ **继续挂着 + 自动升级喊人**。
 *
 * 实现口径（🔴 不引入组织架构，只用现有通知机制扩）：
 *  - **喊多次**：由既有 SLA 定时器重复通知（落池单本来就在 claim-hall 超时扫描范围内），
 *    间隔/次数走 system_config KV，本文件不另起调度器——避免出现第二份定时器真源。
 *  - **喊更广**：接收面 = 全部 active admin ∪ 持 `dispatch.override` 权限点的账号。
 *  - **永不消失**：本函数在任何失败分支**都不写状态**（连 UPDATE 都不发），
 *    单子原地停在池态，等 admin 处理或工人自抢。
 *
 * 通知段用 SAVEPOINT 隔离（照抄 `workOrder.ts:260` 的 `dispatch_notify_sp` 模式）：
 * SQL 一旦出错 PG 事务进入 aborted 态，单纯 try/catch 吞错后外层 COMMIT 实为 ROLLBACK，
 * 会导致退回动作静默消失但 API 谎报成功。
 */
async function notifyRedispatchFailed(
  client: PoolClient,
  tenantId: string,
  row: AutoRedispatchRow,
  reason: string,
  excludeWorkerIds: string[],
): Promise<void> {
  await client.query('SAVEPOINT redispatch_notify_sp');
  try {
    // 接收面：admin ∪ 持 dispatch.override 的账号（用现有两张表，不新增组织关系数据）
    const admins = await client.query<{ id: string }>(
      `SELECT id FROM account_user WHERE tenant_id=$1 AND active=true AND role='admin'`,
      [tenantId],
    );
    const dispatchers = await client.query<{ role: string }>(
      `SELECT DISTINCT role FROM role_permission WHERE tenant_id=$1 AND perm='dispatch.override'`,
      [tenantId],
    );
    const extraRoles = dispatchers.rows.map((r) => r.role).filter((r) => r !== 'admin');
    const recipients = new Set<string>(admins.rows.map((a) => a.id));
    if (extraRoles.length > 0) {
      const extra = await client.query<{ id: string }>(
        `SELECT id FROM account_user WHERE tenant_id=$1 AND active=true AND role = ANY($2::text[])`,
        [tenantId, extraRoles],
      );
      for (const e of extra.rows) recipients.add(e.id);
    }
    for (const recipient of recipients) {
      await insertNotification(client, {
        tenantId,
        recipient,
        recipientKind: 'account',
        type: 'dispatch',
        workOrderId: row.id,
        title: '工单退回后无法自动改派',
        body:
          reason === 'limit_reached'
            ? `工单 ${row.order_no} 退回后自动改派已达上限，请人工指派`
            : `工单 ${row.order_no} 退回后无其他在岗工人可派，请启用工人账号或人工指派`,
        payload: {
          order_no: row.order_no,
          from_status: row.status,
          reason,
          exclude_worker_ids: excludeWorkerIds,
        },
      });
    }
    // 事件留痕：reason 进 payload，供 stats 按 payload->>'reason' 聚合（与 claim_hall_reasons 同口径）
    await emitRedispatchFailedEvent(client, tenantId, row, reason, excludeWorkerIds);
    await client.query('RELEASE SAVEPOINT redispatch_notify_sp');
  } catch (notifyErr) {
    await client.query('ROLLBACK TO SAVEPOINT redispatch_notify_sp');
    console.error('[autoRedispatch] notification failed (non-blocking)', {
      workOrderId: row.id,
      err: notifyErr,
    });
  }
}

/** 失败事件落 ticket_event（type='return_redispatch_failed'），payload 携带 reason。 */
async function emitRedispatchFailedEvent(
  client: PoolClient,
  tenantId: string,
  row: AutoRedispatchRow,
  reason: string,
  excludeWorkerIds: string[],
): Promise<void> {
  await client.query(
    `INSERT INTO ticket_event (tenant_id, work_order_id, type, from_status, to_status, actor, payload)
     VALUES ($1,$2,'return_redispatch_failed',$3,$4,$5,$6)`,
    [
      tenantId,
      row.id,
      row.status,
      row.status,
      'auto_dispatch',
      JSON.stringify({
        transition_event: RETURN_EVENT,
        from_status: row.status,
        to_status: row.status,
        reason,
        exclude_worker_ids: excludeWorkerIds,
      }),
    ],
  );
}

/**
 * 退回后自动回派（**唯一对外入口**）：排除刚退回的那个工人，从其余在岗工人里按既有派单口径选人。
 *
 * 【为什么外面必须再包一层 SAVEPOINT】`withTenantClient` 是 BEGIN→fn→COMMIT。
 *   回派段 SQL 一旦真出错，PG 事务进入 aborted 态 —— 单纯 try/catch 吞错后外层 COMMIT
 *   实为 ROLLBACK，**用户刚点的"退回"会静默消失而 API 谎报成功**。
 *   这与 `workOrder.ts` 里 `dispatch_notify_sp`（:256-260 注释）是同一类事故，故用同一修法：
 *   SAVEPOINT 隔离回派段，失败只回滚回派段本身，退回动作保真。
 *
 * @returns 结果对象；**永不抛错打断退回动作**（失败一律降级为"落池 + 喊人"）。
 */
export async function autoRedispatchAfterReturn(
  client: PoolClient,
  tenantId: string,
  row: AutoRedispatchRow,
  opts: AutoRedispatchOptions = {},
): Promise<AutoRedispatchResult> {
  // 非退回事件：连 SAVEPOINT 都不必开（主路径零开销、零语句）
  if (!shouldTriggerAutoRedispatch({ event: opts.event })) {
    return performRedispatch(client, tenantId, row, opts);
  }
  await client.query('SAVEPOINT redispatch_sp');
  try {
    const result = await performRedispatch(client, tenantId, row, opts);
    await client.query('RELEASE SAVEPOINT redispatch_sp');
    return result;
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT redispatch_sp');
    console.error('[autoRedispatch] redispatch failed, return action preserved (non-blocking)', {
      workOrderId: row.id,
      tenantId,
      err: err instanceof Error ? err.message : String(err),
    });
    const excluded: string[] = [];
    if (typeof row.assignee_id === 'string' && row.assignee_id) excluded.push(row.assignee_id);
    if (typeof opts.excludeWorkerId === 'string' && opts.excludeWorkerId) excluded.push(opts.excludeWorkerId);
    return {
      attempted: true,
      redispatch: false,
      assignee: null,
      reason: 'redispatch_error',
      relaxedLevel: null,
      target: null,
      excludeWorkerIds: [...new Set(excluded)].sort(),
    };
  }
}

/** 回派的实际逻辑（内部实现，由 `autoRedispatchAfterReturn` 用 SAVEPOINT 包住调用）。 */
async function performRedispatch(
  client: PoolClient,
  tenantId: string,
  row: AutoRedispatchRow,
  opts: AutoRedispatchOptions = {},
): Promise<AutoRedispatchResult> {
  // ① 排除集：退回人（assignee_id 未被清空）+ 调用方显式排除
  const excludeSet = new Set<string>();
  if (typeof row.assignee_id === 'string' && row.assignee_id) excludeSet.add(row.assignee_id);
  if (typeof opts.excludeWorkerId === 'string' && opts.excludeWorkerId) excludeSet.add(opts.excludeWorkerId);
  const excludeWorkerIds = [...excludeSet].sort();

  // ② 触发器：非 return 事件直接返回（主路径零干扰）
  if (!shouldTriggerAutoRedispatch({ event: opts.event })) {
    return {
      attempted: false,
      redispatch: false,
      assignee: null,
      reason: 'not_return_event',
      relaxedLevel: null,
      target: null,
      excludeWorkerIds,
    };
  }

  // ③ 次数上限（D-5，默认 3；可经 system_config 覆盖）
  const limit = Number.isFinite(opts.limit as number) && (opts.limit as number) >= 0
    ? Math.floor(opts.limit as number)
    : await resolveRedispatchLimit(client, tenantId);
  const current = readRedispatchCount(row.ext);
  if (current >= limit) {
    await notifyRedispatchFailed(client, tenantId, row, 'limit_reached', excludeWorkerIds);
    return {
      attempted: true,
      redispatch: false,
      assignee: null,
      reason: 'limit_reached',
      relaxedLevel: null,
      target: null,
      excludeWorkerIds,
    };
  }

  // ④ 流程版本：与 transition() 同源取在途单锁定版本（T1-B 纪律，:207）
  const def: WorkflowDef = await getWorkflowDefAtVersion(
    client,
    tenantId,
    'work_order',
    Number(row.def_version) || 0,
    DEFAULT_WORK_ORDER_DEF,
  );

  // ⑤ 安全栏：只在单子确实落在「池态」时才回派。
  //    否则自定义 def 里 `return` 指向非池态（如 pending_review）时，
  //    resolveDispatchTarget 会顺着首条非终态边把单推进无关状态 —— 宁可不派，不可误派。
  if (!claimableStates(def).includes(row.status)) {
    return {
      attempted: true,
      redispatch: false,
      assignee: null,
      reason: 'not_in_pool_state',
      relaxedLevel: null,
      target: null,
      excludeWorkerIds,
    };
  }

  // ⑥ 派单目标：与 autoDispatchAfterCreate 同一口径（fail-closed，绝不硬编码 'assigned'）
  const target = resolveDispatchTarget(def, row.status);
  if (!target) {
    await notifyRedispatchFailed(client, tenantId, row, 'no_dispatch_path', excludeWorkerIds);
    return {
      attempted: true,
      redispatch: false,
      assignee: null,
      reason: 'no_dispatch_path',
      relaxedLevel: null,
      target: null,
      excludeWorkerIds,
    };
  }
  const edge = (def.transitions ?? []).find((t) => t.from === row.status && t.to === target);
  // 系统派单唯一能自带的是 assignee；边若要求其他必填 ⇒ 明确放弃回派，绝不静默跳过门禁
  const unmet = (edge?.requiredFields ?? []).filter((f) => f !== 'assignee');
  if (unmet.length > 0) {
    await notifyRedispatchFailed(client, tenantId, row, 'unmet_required_fields', excludeWorkerIds);
    return {
      attempted: true,
      redispatch: false,
      assignee: null,
      reason: 'unmet_required_fields',
      relaxedLevel: null,
      target: null,
      excludeWorkerIds,
    };
  }

  // ⑦ 候选池：与 workOrder.ts:142 逐字同一条 SQL；排除集在此生效（规则链路与兜底链路同口径）
  const w = await client.query('SELECT id, skill_tags, load, active FROM worker WHERE tenant_id = $1', [tenantId]);
  const workerRows: WorkerRow[] = w.rows.map((x: any) => ({ ...x, skill_tags: safeParseJsonb(x.skill_tags) ?? [] }));
  const pool = workerRows.filter((x) => !excludeSet.has(x.id));

  // ⑧ 需求口径：与 resolveDispatch 共用同一个 resolveNeed（不只用调用方传的 skill_tags）
  const prio = row.priority === 'urgent' || row.priority === 'normal' ? row.priority : undefined;
  const needPayload = await resolveNeed(
    {
      tenantId,
      entityType: 'work_order',
      business_type: row.business_type,
      priority: prio,
      catalog: row.catalog ?? undefined,
    },
    client,
  );
  const rules = await getActiveRules(client, tenantId);
  const modelParams = await client.query<{ params: any }>(
    'SELECT params FROM model_state WHERE tenant_id = $1 AND model_key = $2',
    [tenantId, 'dispatch_score'],
  );
  const loadedParams = safeParseJsonb(modelParams.rows[0]?.params) ?? undefined;
  const model: ModelBackend = new StatsModelBackend(loadedParams);
  const resolved = resolveDispatch(pool, rules, needPayload as any, model);
  const picked = resolved ? resolved.worker : pickWorker(pool, { skillTags: needPayload.skill_tags ?? undefined });

  if (!picked) {
    // 🔴 L3 / D-1：真没人 ⇒ 不派、不关单、原地挂着 + 升级喊人
    await notifyRedispatchFailed(client, tenantId, row, 'no_available_worker', excludeWorkerIds);
    return {
      attempted: true,
      redispatch: false,
      assignee: null,
      reason: 'no_available_worker',
      relaxedLevel: null,
      target: null,
      excludeWorkerIds,
    };
  }

  // ⑨ 回派走 transition() 主通道（与 F4 自动派单:213-220 完全同口径）：
  //    拓扑 / requiredFields / sideEffects / 自动审核一个不跳；只跳过人类角色/权限门禁。
  await transition(client, tenantId, row.id, target as WorkOrderStatus, {
    actor: 'auto_dispatch',
    fields: { assignee: picked.id },
    autoFlow: true,
    systemAuto: true,
    eventLogType: 'assign',
    eventOverride: edge?.event,
    payloadExtra: {
      redispatch: true,
      relaxed_level: resolved ? 0 : 1,
      exclude_worker_ids: excludeWorkerIds,
      from_assignee: row.assignee_id,
    },
  });
  // ⑩ 计数递增（jsonb，零 DDL）：只在**回派成功**时 +1
  await client.query(
    `UPDATE work_orders SET ext = COALESCE(ext, '{}'::jsonb) || jsonb_build_object('redispatch_count', $1::int) WHERE id = $2 AND tenant_id = $3`,
    [current + 1, row.id, tenantId],
  );
  // ⑪ 通知新承接人
  await insertNotification(client, {
    tenantId,
    recipient: picked.id,
    recipientKind: 'worker',
    type: 'dispatch',
    workOrderId: row.id,
    title: '您有一条退回改派的工单',
    body: `工单 ${row.order_no} 已被其他工人退回，现自动改派给您`,
    payload: {
      order_no: row.order_no,
      from_status: row.status,
      to_status: target,
      redispatch: true,
      page: `pages/worker/task-detail/task-detail?id=${row.id}`,
    },
  });

  return {
    attempted: true,
    redispatch: true,
    assignee: picked.id,
    reason: resolved ? `auto redispatched by rule "${resolved.ruleId}"` : 'auto redispatched by least_load fallback',
    relaxedLevel: resolved ? 0 : 1,
    target,
    excludeWorkerIds,
  };
}
