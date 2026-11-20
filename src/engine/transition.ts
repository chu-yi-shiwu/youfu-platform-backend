// 通用业务流流转（P3 横向克隆引擎原语）。
// 把 inspection.ts 的 transitionTask 抽象为通用助手，供 transport/emergency/cycle_check
// 等任意 entity_type 复用，避免逐模块硬编码状态机（红线：所有业务流必须过 workflow_def）。
// 表名经白名单校验（防注入），状态由 workflow_def 引擎 applyEvent 校验，data(jsonb) 合并 extra。
import { AppError } from '../middleware/error.js';
import { listPerms } from '../middleware/role.js';
import type { AuthLocals } from '../middleware/auth.js';
import { getWorkflowDefAtVersion } from './workflowDef.js';
import { isTransitionAllowed, type WorkflowDef } from './stateMachine.js';
import { emitDomainEvent } from '../db/eventBus.js';

/** 允许被通用流转改写的物理表（白名单，杜绝 SQL 注入）。 */
const ALLOWED_TABLES = new Set(['business_flow_tasks', 'inspection_task']);

export interface TransitionEntityOpts {
  /** 物理表名，必须在 ALLOWED_TABLES 白名单内。 */
  table: string;
  /** 主键列名，默认 id。 */
  idCol?: string;
  id: string;
  event: string;
  /** 额外字段，合并进 data(jsonb)；值为字符串 'now()' 时内联为 now()。 */
  extra?: Record<string, unknown>;
  /** workflow_def 的 entity_type（同时是业务流标识）。 */
  entityType: string;
  /** 租户无自定义 def 时回退的内置 starter（来自 themes.ts）。 */
  fallbackDef: WorkflowDef;
  /** 事件记账 actor。 */
  actor?: string;
  /** 执行者角色 code（P0-5：用于消费 allowedRoles 门禁）。 */
  actorRole?: string;
  /** 执行者生效权限集合；缺省且转移声明 allowedPerms 时才查库。 */
  actorPerms?: readonly string[];
  /** 权限查询口径；businessFlow 路由传 auth.authMode，缺省按 prod（与 ticket.ts 同口径）。 */
  actorAuthMode?: 'dev' | 'prod';
  /**
   * 系统动作（HMAC 验签的 webhook / 调度器）：无人类执行者，跳过角色/权限门禁。
   * 与 ticket.ts 的 systemAuto 同一语义；必须由调用方显式声明，默认不跳过。
   */
  systemAuto?: boolean;
}

/**
 * 读取实体当前 status → 用引擎校验 event 合法性 → 写入目标态，并把 extra 合并进 data。
 * 返回更新后的整行。非法流转抛 BAD_STATE(422)。
 */
/**
 * 构造 data(jsonb) 合并的 SET 子句。
 * 安全铁律：jsonb 路径键 k 直接来自用户 data（businessFlow 的 b.data 为 z.record(z.any())），
 * 必须以 text[] 参数化注入（ARRAY[$n]::text[]），严禁字符串插值进 '{${k}}'，否则单引号即 SQL 注入。
 * 等效 F-A2 纵深防御，但此处 key 完全用户可控，危害更高。
 */
export function buildDataSetClauses(extra: Record<string, unknown>, values: unknown[]): string[] {
  const extraKeys = Object.keys(extra);
  const nowKeys = extraKeys.filter((k) => extra[k] === 'now()');
  const dataKeys = extraKeys.filter((k) => extra[k] !== 'now()');
  const setClauses = ['status = $3', 'updated_at = now()'];
  if (dataKeys.length > 0) {
    const jsonObj: Record<string, unknown> = {};
    dataKeys.forEach((k) => {
      jsonObj[k] = extra[k];
    });
    values.push(JSON.stringify(jsonObj));
    setClauses.push(`data = data || $${values.length}::jsonb`);
  }
  nowKeys.forEach((k) => {
    values.push(k);
    setClauses.push(`data = jsonb_set(data, ARRAY[$${values.length}]::text[], to_json(now()), true)`);
  });
  return setClauses;
}

export async function transitionEntity(
  client: any,
  tenantId: string,
  opts: TransitionEntityOpts,
): Promise<any> {
  if (!ALLOWED_TABLES.has(opts.table)) {
    throw new AppError('BAD_REQUEST', `table not allowed: ${opts.table}`, 400);
  }
  const idCol = opts.idCol ?? 'id';
  // 审查修复（横切⑦ B-2）：SELECT 补 FOR UPDATE 行锁。transitionEntity 的「读状态→
  // 校验转移→写回」是跨语句序列，无行锁时两个并发请求可同时读到同一 status、双双通过
  // applyEvent 校验、先后 UPDATE 同一目标（竞态：状态机非法转移/事件重复生效）。
  // 与 ticket.ts findOneForUpdate 同款模式；该锁仅在事务内生效（withTenantClient 事务调用方
  // 持锁至提交），非事务连接下 FOR UPDATE 退化为普通读、行为不变。
  const cur = await client.query(
    `SELECT * FROM ${opts.table} WHERE ${idCol} = $1 AND tenant_id = $2 FOR UPDATE`,
    [opts.id, tenantId],
  );
  if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'entity not found', 404);
  const row = cur.rows[0];

  // T1-B 批3：在途单按建单时锁定的流程版本流转（def_version=0 ⇒ 未记录 ⇒ 走 live，逐字节等价）。
  // 【E7 决策留痕：为什么用「内部自取」而不是设计文档推荐的「外层可选 def 参数」】
  //   设计 §5 批3 推荐 `TransitionEntityOpts` 加可选 `def?: WorkflowDef` 由调用方传入。
  //   没采用，是因为「不传则保持读 live」这条兼容语义本身是 E3 反面教材：
  //   三个调用点（businessFlow.ts:306 / energyCollection.ts:130 / :378）漏传任何一个，
  //   版本锁就**静默失效**（不报错、不告警，测不出来）。
  //   内部自取则不可能漏：这里 :74-77 已是 `SELECT *` ⇒ `row.def_version` 必然在位；
  //   且 ALLOWED_TABLES 两张表（business_flow_tasks / inspection_task）都有 102 的那一列。
  const def = await getWorkflowDefAtVersion(client, tenantId, opts.entityType, row.def_version, opts.fallbackDef, true);
  const tdef = def.transitions.find((t) => t.from === row.status && t.event === opts.event) ?? null;
  if (!tdef) {
    throw new AppError('BAD_STATE', `illegal transition ${row.status} --${opts.event}-->`, 422);
  }
  const target = tdef.to;
  // P0-5（2026-11-07）：通用流转此前只校验拓扑，workflow_def 里配的 allowedRoles /
  //   allowedPerms 对未进代理注册表的实体完全无效（「取消只有管理员能点」形同虚设）。
  //   现与 ticket.ts / inspection.transitionTask 共用 isTransitionAllowed（allowedRoles ∪ allowedPerms）。
  //   系统动作（energy webhook 等）由调用方显式 systemAuto 跳过——安全性由验签/调度前置保证。
  if (!opts.systemAuto) {
    const role = opts.actorRole;
    const needsPerms = Array.isArray(tdef.allowedPerms) && tdef.allowedPerms.length > 0;
    const perms = needsPerms
      ? opts.actorPerms ??
        (await listPerms(
          { tenantId, requestId: '', role, authMode: opts.actorAuthMode ?? 'prod' } as AuthLocals,
          client,
        ))
      : undefined;
    if (!isTransitionAllowed(tdef, { role, perms })) {
      throw new AppError(
        'FORBIDDEN',
        `role ${role ?? '(none)'} not allowed for ${row.status} --${opts.event}-->`,
        403,
      );
    }
  }
  // P0-5：requiredFields 与门禁同一版本 def，缺一即 422（与 businessFlow 路由原有校验一致）。
  const extra = opts.extra ?? {};
  if (tdef.requiredFields && tdef.requiredFields.length > 0) {
    const missing = tdef.requiredFields.filter(
      (f) => extra[f] === undefined || extra[f] === null || extra[f] === '',
    );
    if (missing.length > 0) {
      throw new AppError('BAD_REQUEST', `missing required fields: ${missing.join(',')}`, 422);
    }
  }

  const values: unknown[] = [opts.id, tenantId, target];
  const setClauses = buildDataSetClauses(extra, values);

  const r = await client.query(
    `UPDATE ${opts.table} SET ${setClauses.join(', ')} WHERE ${idCol} = $1 AND tenant_id = $2 RETURNING *`,
    values,
  );
  await emitDomainEvent(client, {
    tenantId,
    entityType: opts.entityType,
    entityId: opts.id,
    type: opts.event,
    actor: opts.actor ?? 'user',
  });
  return r.rows[0];
}
