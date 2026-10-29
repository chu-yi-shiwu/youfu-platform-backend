// workflow_def 仓储（T-①）：读/确保/保存每租户每业务流的状态图定义。
// 状态图存 DB，由可配置状态机引擎消费，实现"流程零代码配置"。
import type { PoolClient } from 'pg';
import { DEFAULT_WORK_ORDER_DEF, doneStates, terminalStates, type WorkflowDef, type WorkflowTransition } from './stateMachine.js';
import { ensureClaimHallState } from './claimHallEdges.js';
import { ensureTenantStateLabels } from './labelDictTenant.js';
import { AppError } from '../middleware/error.js';
import { PERMS, ROLES, ROLE_CODE_RE, isRetiredRole } from '../middleware/role.js';

/**
 * V2-F7（2026-09-14）：读路径幂等注入抢单大厅机制态（仅 work_order）。
 * 抢单大厅是引擎滴滴式兜底：派单未命中直接 UPDATE status='claim_hall'（旁路），
 * 但最小 4 态/部分租户 def 无此态 ⇒ transition() isKnownState 拒绝，出厅流转
 * 全 422（合法进、非法出，大厅卡死）。在读路径注入（而非写路径）的原因：
 * 存量已落库 def 与已落大厅的单无需迁移即修复；claim_hall 属引擎机制态，
 * 注入是"引擎真实行为空间"的诚实呈现。纯加法幂等，详见 engine/claimHallEdges.ts。
 */
function withMechanismStates(entityType: string, def: WorkflowDef): WorkflowDef {
  if (entityType !== 'work_order') return def;
  return ensureClaimHallState(def).def;
}

/**
 * 该业务文档的状态名应落在**哪个字典域**（label_dict_tenant.scope）。
 *
 * 【为什么巡检要单独一个 insp_status 域】
 *   巡检的状态集（pending / in_progress / done / exception）与工单的状态集（073 的 wo_status
 *   域那 19 条：draft / assigned / processing / completed ...）是**两套不相交的枚举**——
 *   两边唯一的"交集"是英文撞名（例如巡检的 done 与将来任何业务的 done），而不是同一个含义。
 *   混在一个域里的代价：
 *     · 保存巡检流程 ⇒ 巡检状态以裸 key 落进**工单域**，读侧 /meta/labels/me 按 scope 合并下发，
 *       界面拿到的是一张工单:巡检混编的状态表，无从分辨某行归属哪个业务文档；
 *     · 唯一键是 (tenant_id, scope, key)：一旦工单侧出现同名 key，两业务共享同一行，
 *       谁先占位谁定义译名，改巡检名会把工单名带跑（反之亦然），且**没有冲突提示**。
 *   ⇒ 分域不是洁癖，是把"这两件事本来就不是一件事"写进数据。
 *
 * 【为什么其余一律回落 wo_status（而不是未知类型就抛错）】
 *   entity_type 是开放集合（volunteer_activity / feedback / monitor_alert ...），当前只有
 *   inspection_task 被证实"枚举与工单不相交"。未知类型抛错会把"配一个还没白名单化的新业务流"
 *   变成 500 —— 展示层故障不该阻断写流程。回落默认域 = 与本次改动前逐字一致的行为。
 *
 * 【为什么 missed 不在这里】missed 属于**巡更/循环签到**（另一套闭环），不属于 inspection_task，
 *   不在本函数的工作范围内；它同样证明了"状态名不能靠字面猜归属"。
 */
export function scopeFor(entityType: string): string {
  if (entityType === 'inspection_task') return 'insp_status';
  return 'wo_status';
}

/**
 * 2026-09-14 纵切③ P0-2：状态图写入口校验收口（纯函数可单测）。
 * 此前 PUT /workflow/def 的校验只做 ①initial∈states ②transitions from/to∈states（optimize.ts 内联），
 * 漏掉第三项：autoRoutes.to 允许指向 doneStates/terminalStates——自动派单直达终态，
 * 绕过处理/验收全链路（派单目标态禁止是终态）。校验三违例均抛 422 BAD_REQUEST：
 *   ① initial ∈ states；
 *   ② 所有 transitions 的 from/to ∈ states；
 *   ③ def.config?.autoRoutes（若存在）：每个 route.to ∈ states 且不在 doneStates/terminalStates 中。
 */
export function validateWorkflowDef(def: WorkflowDef): void {
  if (!def.states.includes(def.initial)) {
    throw new AppError('BAD_REQUEST', `initial "${def.initial}" not in states`, 422);
  }
  const transitions = Array.isArray(def.transitions) ? def.transitions : [];
  const unknown = transitions.filter((t) => !def.states.includes(t.from) || !def.states.includes(t.to));
  if (unknown.length > 0) {
    throw new AppError('BAD_REQUEST', `transition references unknown state: ${JSON.stringify(unknown[0])}`, 422);
  }
  // 【地基第二步补漏：角色/权限 ↔ 流程的联动校验】
  // 此前只校验"状态拓扑"，完全不校验 allowedRoles / allowedPerms 里写的名字是否存在：
  //   租户把某条边的 allowedRoles 写成拼错的名字（或引用一个已删除的自定义岗位）→
  //   **这条边永久门死，没有任何人能走这条流转，且保存时不报错**（配错了连提示都没有）。
  //   角色可配置与流程可配置之间缺这道校验，两者就不算真正闭环。
  //
  // ① allowedPerms ∈ PERMS（同步，零存量风险）：allowedPerms 是本批新增字段，
  //    存量只可能是 091/092 回填的 'workflow.approve'（合法），写错即挡。
  for (const t of transitions) {
    const perms = (t as { allowedPerms?: string[] }).allowedPerms;
    if (!Array.isArray(perms)) continue;
    for (const p of perms) {
      if (!(PERMS as readonly string[]).includes(p)) {
        throw new AppError(
          'BAD_REQUEST',
          `transition ${t.from}--${t.event ?? ''}-->${t.to} 引用了未登记的权限点 "${p}"（可用清单见 GET /accounts/roles/perm-catalog）`,
          422,
        );
      }
    }
  }
  const routes = def.config?.autoRoutes;
  if (routes) {
    // 禁止自动派发直达的目标态 = 完成态 ∪ 终态（completed/closed/evaluated 等必须由显式事件驱动，
    // 与引擎红线一致："绝不自动把状态推进到终态"）。
    const forbidden = new Set<string>([...doneStates(def), ...terminalStates(def)]);
    for (const [fromState, route] of Object.entries(routes)) {
      const toState = route?.to;
      if (typeof toState !== 'string' || !def.states.includes(toState)) {
        throw new AppError('BAD_REQUEST', `autoRoutes.${fromState}.to "${String(toState)}" not in states`, 422);
      }
      if (forbidden.has(toState)) {
        throw new AppError(
          'BAD_REQUEST',
          `autoRoutes.${fromState}.to "${toState}" 是完成态/终态，禁止作为自动派单目标（派单目标态禁止直达终态）`,
          422,
        );
      }
    }
  }
}

/**
 * 【地基第二步补漏】流程里 allowedRoles 引用的角色必须真实存在（异步，需查 role_def）。
 *
 * 为什么必须补：此前流程保存只校验状态拓扑，allowedRoles 写什么都能存 ——
 *   租户把某条边的 allowedRoles 写成拼错的名字（如 'weixiuzuzhang'），或引用一个已删掉的
 *   自定义岗位 → **这条边永久门死，谁都走不了，且保存时零提示**。
 *   角色可配置与流程可配置之间少了这道校验，两者就不算闭环。
 *
 * 【存量安全（关键设计）】只校验"本次新出现的角色名"：
 *   oldDef 里已存在的角色名一律豁免（哪怕它现在已不在 role_def 里）。
 *   否则存量 def 里若有历史脏角色名，租户一保存流程就被 422 挡住 = 生产事故。
 *   精准取舍：**拦增量错字，不翻存量旧账。**
 */
export async function assertWorkflowDefRolesUsable(
  client: PoolClient,
  tenantId: string,
  def: WorkflowDef,
  oldDef?: WorkflowDef | null,
): Promise<void> {
  const legacy = new Set<string>();
  for (const t of oldDef?.transitions ?? []) {
    for (const r of t.allowedRoles ?? []) legacy.add(r);
  }
  const need = new Set<string>();
  for (const t of def.transitions ?? []) {
    for (const r of t.allowedRoles ?? []) {
      if (legacy.has(r)) continue; // 存量既有 → 豁免，不翻旧账
      if ((ROLES as readonly string[]).includes(r)) {
        // 内置角色不查 role_def；但**退场角色一律不得新写进流程**。
        // 背景：096 迁移清的是 workflow_def.def（live），草稿行（workflow_def_change）没动；
        // 若此处沿用"内置即放行"，一份 096 之前的旧草稿审批通过就把 dispatcher/service_desk
        // 原样写回 live —— 退场清理被复活、死角色重新出现在门禁里。
        // 存量豁免（上一行 legacy）先于此判定，故已带退场角色的租户保存流程不受影响。
        if (isRetiredRole(r)) {
          throw new AppError(
            'BAD_REQUEST',
            `流程引用了已退场的内置角色 "${r}"（该岗位已停止新建，请改用内置在岗角色，或先在「自定义岗位」建岗后再引用）`,
            422,
          );
        }
        continue;
      }
      if (!ROLE_CODE_RE.test(r)) {
        throw new AppError(
          'BAD_REQUEST',
          `流程引用了形状非法的角色名 "${r}"（须 ^[a-z][a-z0-9_]{1,31}$，如 repair_lead）`,
          422,
        );
      }
      need.add(r);
    }
  }
  if (need.size === 0) return;
  const codes = [...need];
  const r = await client.query<{ code: string }>(
    `SELECT code FROM role_def WHERE tenant_id = $1 AND code = ANY($2::text[])`,
    [tenantId, codes],
  );
  const found = new Set(r.rows.map((x) => x.code));
  const missing = codes.filter((c) => !found.has(c));
  if (missing.length > 0) {
    throw new AppError(
      'BAD_REQUEST',
      `流程引用了本租户不存在的角色：${missing.join('、')}（请先在「角色管理」创建该岗位，或改回内置角色）`,
      422,
    );
  }
}

/** 读状态图；租户无定义时回退指定兜底（不写库，避免只读操作产生副作用）。 */
export async function getWorkflowDefOrDefault(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  fallback: WorkflowDef,
): Promise<WorkflowDef> {
  const r = await client.query<{ def: unknown }>(
    'SELECT def FROM workflow_def WHERE tenant_id = $1 AND entity_type = $2',
    [tenantId, entityType],
  );
  const raw = r.rows[0]?.def;
  if (!raw) return withMechanismStates(entityType, cloneDef(fallback));
  return withMechanismStates(entityType, normalizeDef(typeof raw === 'string' ? JSON.parse(raw) : raw));
}

/** 读状态图；租户无定义时回退默认（不写库，避免只读操作产生副作用）。 */
export async function getWorkflowDef(
  client: PoolClient,
  tenantId: string,
  entityType: string,
): Promise<WorkflowDef> {
  return getWorkflowDefOrDefault(client, tenantId, entityType, DEFAULT_WORK_ORDER_DEF);
}

/**
 * 确保状态图存在：无则 upsert 默认定义并返回；有则原样返回。
 * @param actor 变更人（T0）：自动补建默认流程也是一次配置写入，同样要留变更人。
 */
export async function ensureWorkflowDef(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  actor?: string,
): Promise<WorkflowDef> {
  const existing = await client.query<{ def: unknown }>(
    'SELECT def FROM workflow_def WHERE tenant_id = $1 AND entity_type = $2',
    [tenantId, entityType],
  );
  if (existing.rows[0]) {
    const raw = existing.rows[0].def;
    return withMechanismStates(entityType, normalizeDef(typeof raw === 'string' ? JSON.parse(raw) : raw));
  }
  const def = withMechanismStates(entityType, cloneDef(DEFAULT_WORK_ORDER_DEF));
  await client.query(
    `INSERT INTO workflow_def (tenant_id, entity_type, def, version, updated_by) VALUES ($1,$2,$3,1,$4)`,
    [tenantId, entityType, JSON.stringify(def), actor ?? null],
  );
  return def;
}

/** upsert 状态图（版本自增，记录变更历史）。
 *  S2：保存前把「当前旧版」快照写入 workflow_def_history（append-only，S3 版本回滚地基）；
 *  reason 为来源标记（手工保存/模板应用/回滚，G5：模板应用与自优化不互斥）。
 *
 *  V3-D5（2026-09-14）：opts 从可选改必填——TS 编译期强制所有直写调用点留痕
 *  （operator/reason 缺失或空串运行期 422，防 `?? null` 式静默）。live 写边收敛为五条：
 *  approve / rollback / template / auto-tune / provision，全部可归因。
 *
 *  V3-D4（2026-09-14）：删态硬闸——removed = 旧 states − 新 states 非空时，
 *  先按实体表映射清点在途单；有在途且未显式 allowInflightLoss → 409 INFLIGHT_STATE_LOSS
 *  （改 def 不触碰业务表 status，删掉有在途单的状态即永久 422 失联，默认必须拒绝）。
 *  逃生口 allowInflightLoss 仅供 approve/rollback 端点在显式二次确认参数下传入。 */
export interface SaveWorkflowDefOpts {
  /** 留痕：操作者（审计 history.operator），必填非空。 */
  operator: string;
  /** 留痕：写入原因（审计 history.reason），必填非空。 */
  reason: string;
  /** V3-D4 逃生口：仅 approve/rollback 在请求体显式二次确认（confirm_inflight_loss:true）下传入。 */
  allowInflightLoss?: boolean;
  /**
   * T0 并发锚：我这次写入是**基于哪个版本**改的。
   *   传了 ⇒ 单语句锚定版本，版本已被别人推进则 409 DRAFT_STALE，**绝不静默覆盖**；
   *   不传 ⇒ 保持 T0 前的无条件覆盖写（向后兼容，现有调用点零改动即可继续跑）。
   * 想让"防竞态"真正生效，写边**必须**传它；不传只能说明这条边被显式豁免（豁免理由写进调用点注释）。
   */
  expectVersion?: number;
}

/** 在途单按状态清点（V3-D4 纯查询函数）：扫描面按 entity_type 映射（与 transition.ts ALLOWED_TABLES 同源思想）。 */
const ENTITY_STATE_TABLE: Record<string, string> = {
  work_order: 'work_orders',
  inspection_task: 'inspection_task',
  transport_task: 'transport_order',
};

export async function countInflightByStates(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  states: string[],
): Promise<{ total: number; byState: Record<string, number> }> {
  const byState: Record<string, number> = {};
  let total = 0;
  if (states.length === 0) return { total, byState };
  const table = ENTITY_STATE_TABLE[entityType];
  const sql =
    table !== undefined
      ? `SELECT status, COUNT(*)::int AS n FROM ${table} WHERE tenant_id = $1 AND status = ANY($2) GROUP BY status`
      : `SELECT status, COUNT(*)::int AS n FROM business_flow_tasks WHERE tenant_id = $1 AND entity_type = $2 AND status = ANY($3) GROUP BY status`;
  const params = table !== undefined ? [tenantId, states] : [tenantId, entityType, states];
  const r = await client.query<{ status: string; n: number }>(sql, params);
  for (const row of r.rows) {
    byState[row.status] = Number(row.n);
    total += Number(row.n);
  }
  return { total, byState };
}

/** 一个「会让在途单走不下去」的改动面：lead/summary 进错误 message，states 是要清点的状态集合。 */
interface InflightTransitionRisk {
  /** 场景名（运营一眼看懂是哪种改动）。 */
  lead: string;
  /** 改动摘要（哪条边、踢掉了谁、新增了什么）。 */
  summary: string;
  /** 需要清点在途单的状态 = 被改动边的 from（单正卡在这些态上）。 */
  states: string[];
}

/** 流转边身份键：引擎两侧消费口径都落在这个三元组里（applyEvent 用 from+event、canTransition 用 from+to）。 */
function transitionKey(t: WorkflowTransition): string {
  return `${t.from}|${t.event ?? ''}|${t.to}`;
}

/**
 * T1-A（2026-10-25）：在途单防呆**第二道**——V3-D4 只挡「删状态」，下面三种改动同样
 * 会让在途单走不下去，且改前**零报错**（改完日志干净、单子卡死，属静默失败）：
 *   ① 删流转边          ：在途单所在状态再也走不到原目标态；
 *   ② 收紧 allowedRoles  ：原本能操作这条边的人被踢掉；
 *   ③ 新增 requiredFields：在途单没有这个字段，提交必 422。
 *
 * 【判定面为什么是 diff，不是全量】只比对旧 def 与新 def，**只对受影响状态**调
 * countInflightByStates（与删态硬闸同一支清点，不另写 SQL）；无 diff ⇒ 一条查询都不发
 * （v3WorkflowLocks ④「新增态/改边不发清点查询」这条既有锚点因此继续绿）。
 *
 * 【①为什么按 from→to 判，而不是按 from|event|to 判】引擎 canTransition 认的是 from+to，
 * applyEvent 认的是 from+event；客户把 receive 改名成 accept 属于**重组**（单照样走得通），
 * 按三元组判会把它误报成删边 ⇒ 误伤正当编辑。按 from→to 判则精准命中「这条通路没了」。
 *
 * 【已知边界（诚实声明，不装作全知）】②只看 allowedRoles，不建模 allowedPerms 的补偿：
 * 若客户踢掉角色的同时补了 allowedPerms，理论上有人仍能走，本闸按「宁可拦下让人确认」
 * 处理（逃生口 allowInflightLoss 仍在）。要更精细需引入执行者集合，超出本批范围。
 */

/** ① 删流转边：旧 def 的 from→to 通路在新 def 里不复存在（换 event 名不算丢）。 */
function diffLostEdges(oldDef: WorkflowDef, newDef: WorkflowDef): InflightTransitionRisk | null {
  const newStates = new Set<string>(newDef.states ?? []);
  const stillHasPath = new Set<string>();
  for (const t of newDef.transitions ?? []) stillHasPath.add(`${t.from}->${t.to}`);
  const seen = new Set<string>();
  const lost: string[] = [];
  const states = new Set<string>();
  for (const t of oldDef.transitions ?? []) {
    // from 态本身已被删 ⇒ 归删态硬闸管，此处不重复计（避免同一批单被报两遍）
    if (!newStates.has(t.from)) continue;
    const pair = `${t.from}->${t.to}`;
    if (stillHasPath.has(pair) || seen.has(pair)) continue;
    seen.add(pair);
    lost.push(`${t.from} --${t.event ?? ''}--> ${t.to}`);
    states.add(t.from);
  }
  if (lost.length === 0) return null;
  return { lead: '删流转边', summary: `删除流转边 [${lost.join('；')}]`, states: [...states] };
}

/** ② 收紧 allowedRoles：同一条边上旧允许、新不允许的角色；含「原不限角色 → 现限定」这一最狠的收紧。 */
function diffTightenedRoles(oldDef: WorkflowDef, newDef: WorkflowDef): InflightTransitionRisk | null {
  const newByKey = new Map<string, WorkflowTransition>();
  for (const t of newDef.transitions ?? []) newByKey.set(transitionKey(t), t);
  const parts: string[] = [];
  const states = new Set<string>();
  for (const ot of oldDef.transitions ?? []) {
    const nt = newByKey.get(transitionKey(ot));
    if (!nt) continue; // 边整个没了 ⇒ 归 ① 管，不重复报
    const oldRoles = ot.allowedRoles ?? [];
    const newRoles = nt.allowedRoles ?? [];
    const kicked = oldRoles.filter((r) => !newRoles.includes(r));
    const closedGate = oldRoles.length === 0 && newRoles.length > 0;
    if (kicked.length === 0 && !closedGate) continue;
    const desc = `${ot.from} --${ot.event ?? ''}--> ${ot.to}`;
    parts.push(
      closedGate
        ? `${desc}（原不限角色 → 现仅限 [${newRoles.join(',')}]）`
        : `${desc} 去掉 [${kicked.join(',')}]`,
    );
    states.add(ot.from);
  }
  if (parts.length === 0) return null;
  return { lead: '收紧角色', summary: `收紧操作角色：${parts.join('；')}`, states: [...states] };
}

/** ③ 新增 requiredFields：同一条边上新出现、旧没有的必填字段（存量单没有 ⇒ 提交必失败）。 */
function diffAddedRequiredFields(oldDef: WorkflowDef, newDef: WorkflowDef): InflightTransitionRisk | null {
  const newByKey = new Map<string, WorkflowTransition>();
  for (const t of newDef.transitions ?? []) newByKey.set(transitionKey(t), t);
  const parts: string[] = [];
  const states = new Set<string>();
  for (const ot of oldDef.transitions ?? []) {
    const nt = newByKey.get(transitionKey(ot));
    if (!nt) continue; // 新边（原本就走不通 ⇒ 不存在被卡的在途单）与删边都不在此计
    const oldFields = ot.requiredFields ?? [];
    const added = (nt.requiredFields ?? []).filter((f) => !oldFields.includes(f));
    if (added.length === 0) continue;
    parts.push(`${ot.from} --${ot.event ?? ''}--> ${ot.to} 新增 [${added.join(',')}]`);
    states.add(ot.from);
  }
  if (parts.length === 0) return null;
  return { lead: '新增必填', summary: `新增必填字段：${parts.join('；')}`, states: [...states] };
}

/**
 * 三场景在途单硬闸：按 ①删边 → ②收紧角色 → ③新增必填 顺序判定，命中即 409。
 * 与删态硬闸**同码同逃生口**（INFLIGHT_STATE_LOSS / opts.allowInflightLoss），不另设开关。
 *
 * 【🔴 为什么「有了版本锁」也绝不许删掉本闸】（T1-B 设计 §6 明令保留；本段即该要求的落地留痕）
 *   ① 分析口径**仍读 live def** ⇒ 删边 / 收紧角色 / 新增必填会让历史数据被重新归类，报表当天跳变：
 *       · src/repo/stats.ts:59（ticketStats）/ :211（processMetrics）/ :307（workerLoadDrift）
 *         走 getDefsAcrossAllVersions，而它固定把 `def_version = 0` 也放进探测集（本文件 :744）
 *         ⇒ 0 号版本**恒等于 live def**，live 一改这三个口径当天就变；
 *       · src/repo/processMining.ts:343 直接 getWorkflowDef（= live def），同理。
 *       即：这三类改动不只是「挡住未来的单」，它还会**改写已经发生的统计**。
 *   ② def_version = 0（**未记录**）的存量行仍**跟随 live def**，版本锁覆盖不到它们：
 *       版本锁只对「建单时写了 > 0 版本号」的新单生效；存量 0 行没有快照可回、永远跟着 live。
 *       ⇒ **本闸是这部分单唯一的保护伞**。
 *   ⚠️ 不要因为「有了版本锁」就删掉本闸 —— 删掉的是**未被版本锁覆盖的那部分单**的保护伞。
 *   ⚠️ 反向约束：也不要在本批扩展本闸的能力面（加新场景 / 改阈值 / 改逃生口）—— 那是独立
 *       变量，须单独成批、单独评审，不搭本批的车。
 */
async function assertNoInflightTransitionLoss(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  oldDef: WorkflowDef,
  newDef: WorkflowDef,
): Promise<void> {
  const risks: InflightTransitionRisk[] = [];
  for (const r of [
    diffLostEdges(oldDef, newDef),
    diffTightenedRoles(oldDef, newDef),
    diffAddedRequiredFields(oldDef, newDef),
  ]) {
    if (r) risks.push(r);
  }
  for (const risk of risks) {
    if (risk.states.length === 0) continue;
    const hits = await countInflightByStates(client, tenantId, entityType, risk.states);
    if (hits.total <= 0) continue; // 受影响的态上确实没有在途单 ⇒ 放行，不误伤
    const detail = Object.entries(hits.byState)
      .map(([st, n]) => `${st}:${n}`)
      .join(',');
    throw new AppError(
      'INFLIGHT_STATE_LOSS',
      `【${risk.lead}】${risk.summary} 将使 ${hits.total} 张在途单走不下去（${detail}）；确认请走审批流并显式 allowInflightLoss`,
      409,
    );
  }
}

export async function saveWorkflowDef(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  def: WorkflowDef,
  opts: SaveWorkflowDefOpts,
): Promise<void> {
  // V3-D5：operator/reason 必填非空（运行期兜底，防调用点传空串静默丢审计）。
  if (!opts?.operator?.trim() || !opts?.reason?.trim()) {
    throw new AppError('BAD_REQUEST', 'saveWorkflowDef requires non-empty operator and reason (audit trail)', 422);
  }
  // 2026-09-14 纵切③ P0-2：写入口统一校验收口（initial/transition 拓扑/autoRoutes 目标态非终态）。
  // 违例 422，坏 def 不落库、不产生 history 快照。开通注入（tenantProvision.ts 直 INSERT 内置 def）
  // 不经本函数、不动；optimize.ts 内联校验保留（幂等冗余，减少 diff）。
  validateWorkflowDef(def);
  const cur = await client.query<{ version: number; def: unknown }>(
    'SELECT version, def FROM workflow_def WHERE tenant_id = $1 AND entity_type = $2',
    [tenantId, entityType],
  );
  // V3-D4 删态硬闸：旧 def 存在且新 def 删掉了状态 → 清点在途单（escape hatch 见 opts.allowInflightLoss）。
  //
  // 【🔴 为什么「有了版本锁」也绝不许删掉本闸】（T1-B 设计 §6 明令保留；本段即该要求的落地留痕）
  //   ① 分析口径**仍读 live def** ⇒ 删状态会让历史数据被重新归类，报表口径当天跳变：
  //       · src/repo/stats.ts:59 / :211 / :307 走 getDefsAcrossAllVersions，而它固定把
  //         `def_version = 0` 也放进探测集（本文件 :744）⇒ 0 号版本**恒等于 live def**；
  //       · src/repo/processMining.ts:343 直接 getWorkflowDef（= live def）。
  //       状态一删，「哪些状态算活跃 / 完成 / 终态」当天就变 ⇒ 老单被重新归类，报表当天跳变。
  //   ② def_version = 0（**未记录**）的存量行仍**跟随 live def**，版本锁覆盖不到它们：
  //       版本锁只对「建单时写了 > 0 版本号」的新单生效；存量 0 行没有快照可回、永远跟着 live。
  //       ⇒ **本闸是这部分单唯一的保护伞**。
  //   ⚠️ 不要因为「有了版本锁」就删掉本闸 —— 删掉的是**未被版本锁覆盖的那部分单**的保护伞。
  //   ⚠️ 反向约束：也不要在本批扩展本闸的能力面（加新场景 / 改阈值 / 改逃生口）—— 那是独立
  //       变量，须单独成批、单独评审，不搭本批的车。
  if (cur.rows[0]) {
    const oldRaw = cur.rows[0].def;
    const oldDef = normalizeDef(typeof oldRaw === 'string' ? JSON.parse(oldRaw) : oldRaw);
    // 地基第二步补漏：allowedRoles 存在性校验（只挡"本次新写错的角色"，见函数注释）
    await assertWorkflowDefRolesUsable(client, tenantId, def, oldDef);
    const removed = (oldDef.states ?? []).filter((s: string) => !def.states.includes(s));
    if (removed.length > 0 && !opts.allowInflightLoss) {
      const hits = await countInflightByStates(client, tenantId, entityType, removed);
      if (hits.total > 0) {
        const detail = Object.entries(hits.byState)
          .map(([st, n]) => `${st}:${n}`)
          .join(',');
        throw new AppError(
          'INFLIGHT_STATE_LOSS',
          `删除状态 [${removed.join(',')}] 将使 ${hits.total} 张在途单失联（${detail}）；确认请走审批流并显式 allowInflightLoss`,
          409,
        );
      }
    }
    // T1-A：删态之外的三场景在途单防呆（删流转边 / 收紧 allowedRoles / 新增 requiredFields）。
    // 与删态硬闸同码（INFLIGHT_STATE_LOSS）、同逃生口（opts.allowInflightLoss），不另设开关。
    if (!opts.allowInflightLoss) {
      await assertNoInflightTransitionLoss(client, tenantId, entityType, oldDef, def);
    }
  }
  if (cur.rows[0]) {
    await client.query(
      `INSERT INTO workflow_def_history (tenant_id, entity_type, version, def, operator, reason)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, entity_type, version) DO NOTHING`,
      [
        tenantId,
        entityType,
        cur.rows[0].version,
        JSON.stringify(cur.rows[0].def),
        opts?.operator ?? null,
        opts?.reason ?? null,
      ],
    );
  }
  // ── T0 条件更新（防竞态）───────────────────────────────────────────────────
  // 单语句锚定版本：`WHERE ($5::int IS NULL OR workflow_def.version = $5)`。
  //   · 不传 expectVersion（$5 = NULL）⇒ 条件恒真 ⇒ 与 T0 前行为一致（向后兼容）；
  //   · 传了但 live 已被别人推进 ⇒ UPDATE 分支不命中、INSERT 因冲突也不落 ⇒ rowCount = 0 ⇒ 409。
  // 【为什么必须单语句】原 approve 路径是 check-then-act（先 getWorkflowDefVersion 比对、再写）：
  //   两条语句之间没有锁，两个并发审批可以读到同一 liveVersion 然后双双通过。
  //   单语句 WHERE 把这个 TOCTOU 窗口彻底消掉——这是 T0 选它的唯一理由。
  const expectVersion = typeof opts.expectVersion === 'number' ? opts.expectVersion : null;
  if (expectVersion !== null && !cur.rows[0]) {
    // 期望某版本但该流程根本不存在 ⇒ 调用方看到的是过期事实，按冲突处理（不静默凭空创建一行）
    throw new AppError(
      'DRAFT_STALE',
      `expected version ${expectVersion} but no def exists for ${entityType}; re-read and retry`,
      409,
    );
  }
  const r = await client.query(
    `INSERT INTO workflow_def (tenant_id, entity_type, def, version, updated_by)
     VALUES ($1,$2,$3,1,$4)
     ON CONFLICT (tenant_id, entity_type)
     DO UPDATE SET def = EXCLUDED.def,
                   version = workflow_def.version + 1,
                   updated_by = EXCLUDED.updated_by,
                   updated_at = now()
     WHERE ($5::int IS NULL OR workflow_def.version = $5)`,
    [tenantId, entityType, JSON.stringify(def), opts.operator, expectVersion],
  );
  const affectedRaw =
    (r as { rowCount?: number | null }).rowCount ?? (r as { affectedRows?: number | null }).affectedRows;
  if (expectVersion !== null && Number(affectedRaw ?? -1) === 0) {
    throw new AppError(
      'DRAFT_STALE',
      `expected version ${expectVersion} but live version is ${cur.rows[0]?.version}; re-read and retry`,
      409,
    );
  }
  // #938-B：流程生效即把该 def 的状态名补进租户覆盖字典（098 label_dict_tenant，只补不覆盖既有译名），
  // 让租户自定义状态（如 rated）有中文名可改，而不是在界面上显示裸 key；读侧 GET /api/v1/meta/labels/me。
  //
  // 【为什么挂这里而不是挂在某条路由】live 写边有五条（approve / rollback / template / auto-tune /
  // provision，见上方 SaveWorkflowDefOpts 注释），**全部收敛到本函数**；挂在此处 = 五条路全覆盖，
  // 挂在任一单条路由 = 其余几条路保存的流程状态继续显示裸 key。
  //
  // 【为什么失败只告警不抛出】标签是**展示层**关注点：098 未应用（滚动发布期代码先于迁移）
  // 或权限缺失时，让"配不了流程"这种业务阻断去背展示层的锅是不可接受的降级顺序。
  // 此处失败 ⇒ 界面退化为裸 key（= 本次改动前的行为），流程照常生效。
  try {
    // T0：落字典也留变更人（本次保存的操作人，与 live 行的 updated_by 同源）
    // scope 按**业务文档**走（巡检 → insp_status，其余 → wo_status，见 scopeFor）：
    //   entityType 就在本函数作用域里，此前没往下传 ⇒ 巡检的 pending / in_progress / done /
    //   exception 一律以裸 key 落进**工单域**，读侧 /meta/labels/me 拿到一张工单:巡检混编的
    //   状态表，且 (tenant_id, scope, key) 唯一键让同名 key 两边互相抢译名。
    await ensureTenantStateLabels(client, tenantId, def.states ?? [], opts.operator, scopeFor(entityType));
  } catch (e) {
    console.warn(
      '[workflowDef] 状态名落租户覆盖字典失败（展示层退化为裸 key，流程已生效）:',
      e instanceof Error ? e.message : e,
    );
  }
}

/** 当前版本号（无定义返回 0）。 */
export async function getWorkflowDefVersion(
  client: PoolClient,
  tenantId: string,
  entityType: string,
): Promise<number> {
  const r = await client.query<{ version: number }>(
    'SELECT version FROM workflow_def WHERE tenant_id = $1 AND entity_type = $2',
    [tenantId, entityType],
  );
  return r.rows[0]?.version ?? 0;
}

/** 版本历史列表（倒序，含快照，供前端查看/回滚）。def 保留原始快照（不 normalize，避免 passthrough 字段丢失）。 */
export async function listWorkflowDefHistory(
  client: PoolClient,
  tenantId: string,
  entityType: string,
): Promise<Array<{ version: number; def: WorkflowDef; operator: string | null; reason: string | null; createdAt: string }>> {
  const r = await client.query(
    `SELECT version, def, operator, reason, created_at
     FROM workflow_def_history
     WHERE tenant_id = $1 AND entity_type = $2
     ORDER BY version DESC`,
    [tenantId, entityType],
  );
  return r.rows.map((row) => ({
    version: row.version,
    def: (typeof row.def === 'string' ? JSON.parse(row.def) : row.def) as WorkflowDef,
    operator: row.operator,
    reason: row.reason,
    createdAt: row.created_at,
  }));
}

/** 按版本号读历史快照（回滚/查看用）；不存在返回 null。保留原始快照（回滚=逐字节还原，不丢字段）。 */
export async function getWorkflowDefHistoryVersion(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  version: number,
): Promise<WorkflowDef | null> {
  const r = await client.query<{ def: unknown }>(
    `SELECT def FROM workflow_def_history
     WHERE tenant_id = $1 AND entity_type = $2 AND version = $3`,
    [tenantId, entityType, version],
  );
  if (!r.rows[0]) return null;
  const raw = r.rows[0].def;
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as WorkflowDef;
}

/**
 * 按「行上已锁定的版本号」取 def（version > 0 的分支；<= 0 的由各入口自己短路）。
 * @param liveVersion 已算好的当前版本号 —— 由调用方传入以避免逐行重复查（getDefsForVersions 用）。
 */
async function resolveLockedDef(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  version: number,
  fallback: WorkflowDef,
  liveVersion: number,
): Promise<WorkflowDef> {
  const live = () => getWorkflowDefOrDefault(client, tenantId, entityType, fallback);
  // 锁的就是当前 live 版本：live 版本本身**不在 history 里**（saveWorkflowDef 只在被覆盖
  // 那一刻才写 history，见 :441-455）⇒ 这条分支不补，锁定到当前版本的单会被误判成"查不到"。
  if (liveVersion === version) return live();
  const snap = await getWorkflowDefHistoryVersion(client, tenantId, entityType, version);
  if (snap) return withMechanismStates(entityType, normalizeDef(snap));
  // 🔴 刻意不抛：见 getWorkflowDefAtVersion 的 JSDoc。
  console.warn(
    '[workflowDef] def_version 指向的历史版本不存在，降级到 live def',
    { tenantId, entityType, version, liveVersion },
  );
  return live();
}

/**
 * T1-B：取「第 N 版」的流程定义 —— 在途单锁版本的读路径。
 *
 * @param version 行上的 def_version。
 *   <= 0  ⇒ 「未记录」，走 getWorkflowDefOrDefault（= **今天的逐字节行为**，含取不到的兜底）
 *   >  0  ⇒ 锁定到该版本：live.version === version 读 live，否则回查 history
 *
 * 【为什么不因为 version <= 0 报错】102 迁移跑完后**所有存量行都是 0**；
 *   把它们变成 500 就是生产事故。0 的语义是「我们没记录」，不是「数据坏了」——
 *   凡 0 一律按 live 走，行为与改动前逐字节一致（102 迁移因此是"零行为变化可单独上线"）。
 *
 * 【为什么必须补 live 那条分支】saveWorkflowDef 只在 def 被覆盖那一刻才把**被覆盖的旧版本**
 *   写进 history（:441-455）⇒ 当前 live 版本本身不在 history 里。
 *   只查 history 的话，「锁定到当前版本」的单会全部掉进降级 + warn（静默地把正确路径当异常）。
 *
 * 【找不到版本号时 —— 刻意不抛，降级到 live + console.warn】
 *   ① T1-B 是"让行为更稳定"的改动；读不到版本就 500，等于把稳定性改动做成了可用性风险。
 *   ② 版本缺失的唯一已知成因是「live 被绕过 saveWorkflowDef 直改」——
 *      tenantProvision.ts:140 直 INSERT version=1 且不带 history 行。那时按 live 走
 *      **正是今天的行为** ⇒ 降级 = 回到改动前，不是新增错误。
 *   这条 warn 是 E3「不静默失败」的具体落实：日志必须能被打点告警抓到。
 *
 * 【为什么必须落在本文件、不能新开文件】withMechanismStates（:18-21）目前是**私有**函数，
 *   版本化读取必须同样注入它，否则历史快照里没有 claim_hall ⇒ 工单出厅流转重新 422
 *   （:11-16 注释记载的正是这个历史事故）。若新开文件就得把 withMechanismStates export
 *   ⇒ 注入逻辑出现第二份真源。
 *
 * 【⚠️ 已知的版本链缺口（不装作全知）】见 §4.3：tenantProvision.ts:140 直 INSERT 时不带
 *   history 行 ⇒ "版本号存在而快照不存在"。靠上面的降级 + warn 兜住，不让它变成 500。
 */
export async function getWorkflowDefAtVersion(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  version: number,
  fallback: WorkflowDef,
): Promise<WorkflowDef> {
  if (!version || version <= 0) {
    return getWorkflowDefOrDefault(client, tenantId, entityType, fallback);
  }
  const liveVersion = await getWorkflowDefVersion(client, tenantId, entityType);
  return resolveLockedDef(client, tenantId, entityType, version, fallback, liveVersion);
}

/**
 * T1-B：批量版 —— 把 rows 按 def_version 分组，**每个不同版本只查一次**。
 *
 * 【为什么不能逐行读】列表口（businessFlow.ts:169-180 / energyCollection.ts:275-286 /
 *   transportAdapter.ts:158-161）现状都是"先读一次 def 再 .map() 套到 N 行"。
 *   每行可能锁不同版本 ⇒ 那个写法在版本化之后**本质上不成立**（R-2）。
 *   分组后实测代价：租户在跑的版本数通常为 1~2 ⇒ 与原来 1 次查询基本同代价。
 *
 * 【返回 Map 的 key = 行上的原始 def_version】失效版本（查不到快照的）也保留自己的 key，
 *   值 = 降级后的 live def ⇒ 调用侧 `defs.get(r.def_version ?? 0)` 永远命中，不会 undefined。
 *
 * 【为什么要先算一次 liveVersion】否则每个版本各查一次 live ⇒ 版本数 N 变成 2N。
 *   若这批行全是 0（未记录），连这一次都省掉。
 */
export async function getDefsForVersions(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  rows: Array<{ def_version?: number | null }>,
  fallback: WorkflowDef,
): Promise<Map<number, WorkflowDef>> {
  const versions = new Set<number>();
  for (const r of rows) {
    // null / undefined / NaN 一律按 0（未记录）处理，不引入第三态。
    versions.add(Number(r?.def_version) || 0);
  }
  const hasLocked = [...versions].some((v) => v > 0);
  const liveVersion = hasLocked ? await getWorkflowDefVersion(client, tenantId, entityType) : 0;
  const out = new Map<number, WorkflowDef>();
  for (const v of versions) {
    out.set(
      v,
      v <= 0
        ? await getWorkflowDefOrDefault(client, tenantId, entityType, fallback)
        : await resolveLockedDef(client, tenantId, entityType, v, fallback, liveVersion),
    );
  }
  return out;
}

// 补全式规范化：保留 def 所有原始字段（含 passthrough 额外字段），仅对缺失的
// initial/states/transitions/config 补默认值——避免剥离字段导致「读→存」二次保存洗掉字段。
function normalizeDef(d: any): WorkflowDef {
  return {
    ...d,
    initial: d?.initial ?? 'draft',
    states: Array.isArray(d?.states) ? d.states : ['draft', 'assigned', 'processing', 'completed'],
    transitions: Array.isArray(d?.transitions) ? d.transitions : [],
    config: d?.config ?? {},
  } as WorkflowDef;
}

// 深拷贝：用 JSON 往返而非 structuredClone，兼容 ECS Node16（structuredClone 为 Node17+ 全局）。
function cloneDef(d: WorkflowDef): WorkflowDef {
  return JSON.parse(JSON.stringify(d));
}

// 已加 def_version 列的业务表白名单 —— 下面那条 SQL 的表名只能从这里取，
// 不接受调用侧直接拼字符串（表名不可参数化，白名单是唯一能挡住注入的写法）。
const VERSIONED_TABLES: Record<string, string> = {
  work_orders: 'work_orders',
  transport_order: 'transport_order',
  business_flow_tasks: 'business_flow_tasks',
  inspection_task: 'inspection_task',
};

/**
 * 该表是否已加 `def_version` 列（即能否做版本探测）。
 *
 * 【为什么必须导出而不是让调用方自己抄一份名单】白名单是 `getDefsAcrossAllVersions`
 *   **会 throw** 的硬约束；调用方若手抄一份副本，名单增减时两边不同步 ⇒ 要么退化成
 *   "少采"（静默），要么撞 throw。此前 src/routes/aiPreview.ts 就抄过一份本地副本，
 *   那是第二真源，本次导出谓词后已删除。
 *   用谓词而非导出常量本体：调用方只能问"能不能探"，拿不到可拼接的表名 ⇒ 注入面不扩大。
 */
export function isVersionedTable(table: string): boolean {
  return Object.prototype.hasOwnProperty.call(VERSIONED_TABLES, table);
}

/**
 * 【多版本并存的名单兜底】取该租户该实体「当前还有行在用」的**全部版本**的 def。
 *
 * 【为什么需要它】凡「先按状态集合拼 SQL / 过滤条件、再去查行」的写法（超时扫描、
 *   结算入账、各类统计、抢单大厅……），此刻手上还没有具体行，只能读 live def ⇒
 *   租户改流程后，老单（锁着 v1）可能既不在 v2 的「包含集」里、也不在 v2 的「排除集」里
 *   ⇒ **这批老单从名单里凭空消失**（单还在库里，但没人看得到、没人告警）。
 *   这是版本化改造**自己引入**的洞 —— 改造前只有一份 def，谁也不会掉队。
 *
 * 【兜底原则】宁可多显示，绝不静默丢单：
 *   - 用于「包含」的集合（活跃态 / 完成态 / 池态…）⇒ 取各版本**并集**（unionStates）
 *   - 用于「排除」的集合（终态 / 完成态…）⇒ 取各版本**交集**（intersectStates）
 *   两者都让"老单掉队"变成"老单多显示一次"，而不是消失。
 *
 * 【为什么连 0 一起探测】def_version = 0 是哨兵（建单时未记录版本）⇒ 走 live def。
 *   存量单全是 0，不探 0 就会把改造前的所有老单整批漏掉。
 */
export async function getDefsAcrossAllVersions(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  table: string,
  fallback: WorkflowDef,
): Promise<WorkflowDef[]> {
  return (await getDefEntriesAcrossAllVersions(client, tenantId, entityType, table, fallback)).map((e) => e.def);
}

/**
 * 同 getDefsAcrossAllVersions，但**连版本号一起给**（`version → def` 配对）。
 *
 * 【为什么必须另出一个而不是让调用方自己再探一次版本】
 *   「哪些版本还在用」这条探测（含哨兵 0）是唯一的真源，写在 getDefEntriesAcrossAllVersions 里；
 *   getDefsAcrossAllVersions 只是它的薄壳。调用方若为了拿版本号自己手抄一份
 *   `SELECT DISTINCT def_version`，名单/哨兵约定一变就两边不同步 ⇒ 又造一个第二真源。
 *
 * 【给谁用】凡「**按行自己的 def_version** 取该版 def」的读路径（例如逐行判定终态的列表筛选）——
 *   这类调用方需要的正好是 (version, def) 配对，而不是去掉键的 def 列表。
 */
export async function getDefEntriesAcrossAllVersions(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  table: string,
  fallback: WorkflowDef,
): Promise<Array<{ version: number; def: WorkflowDef }>> {
  const safeTable = VERSIONED_TABLES[table];
  // 【为什么是 422 不是裸 Error】裸 Error 会被 errorMiddleware 兜底成 500（"我们系统坏了"
  //   ⇒ 触发告警、排障当线上故障查）。而"表没登记进 VERSIONED_TABLES"是**开发期登记漏了 /
  //   调用方传错表名**，属请求侧问题 ⇒ 必须 422。消息里点明开发者该做什么。
  if (!safeTable)
    throw new AppError(
      'BAD_REQUEST',
      `版本探测: 表 ${table} 未登记在 VERSIONED_TABLES 里（未加 def_version 列）` +
        ` —— 若该表确需做版本探测，请先在 VERSIONED_TABLES 登记；` +
        `否则请改用 getWorkflowDefAtVersion / getDefsForVersions（按行上已有的 def_version 取 def）`,
      422,
    );
  const vr = await client.query<{ def_version: number }>(
    `SELECT DISTINCT def_version FROM ${safeTable} WHERE tenant_id = $1 AND def_version > 0`,
    [tenantId],
  );
  const probe = [{ def_version: 0 }, ...vr.rows.map((v) => ({ def_version: Number(v.def_version) || 0 }))];
  const defMap = await getDefsForVersions(client, tenantId, entityType, probe, fallback);
  return [...defMap.entries()].map(([version, def]) => ({ version, def }));
}

/** 并集：给「包含」型集合用（活跃态、完成态、池态…）——宁可多显示，不静默丢单。 */
export function unionStates(sets: string[][]): string[] {
  return [...new Set(sets.flat())];
}

/**
 * 交集：给「排除」型集合用（终态、完成态…）——只排除"所有版本都认为是终态"的状态。
 * 交集为空 = 不排除任何状态 = 全部保留（保守侧，符合"宁可多显示"）。
 */
export function intersectStates(sets: string[][]): string[] {
  if (sets.length === 0) return [];
  return [...sets.reduce<Set<string>>((acc, s) => {
    const next = new Set<string>();
    for (const x of s) if (acc.has(x)) next.add(x);
    return next;
  }, new Set(sets[0]))];
}
