// workflow_def 仓储（T-①）：读/确保/保存每租户每业务流的状态图定义。
// 状态图存 DB，由可配置状态机引擎消费，实现"流程零代码配置"。
import type { PoolClient } from 'pg';
import { DEFAULT_WORK_ORDER_DEF, doneStates, terminalStates, type WorkflowDef } from './stateMachine.js';
import { ensureClaimHallState } from './claimHallEdges.js';
import { AppError } from '../middleware/error.js';

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

/** 确保状态图存在：无则 upsert 默认定义并返回；有则原样返回。 */
export async function ensureWorkflowDef(
  client: PoolClient,
  tenantId: string,
  entityType: string,
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
    `INSERT INTO workflow_def (tenant_id, entity_type, def, version) VALUES ($1,$2,$3,1)`,
    [tenantId, entityType, JSON.stringify(def)],
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
  if (cur.rows[0]) {
    const oldRaw = cur.rows[0].def;
    const oldDef = normalizeDef(typeof oldRaw === 'string' ? JSON.parse(oldRaw) : oldRaw);
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
  await client.query(
    `INSERT INTO workflow_def (tenant_id, entity_type, def, version)
     VALUES ($1,$2,$3,1)
     ON CONFLICT (tenant_id, entity_type)
     DO UPDATE SET def = EXCLUDED.def, version = workflow_def.version + 1, updated_at = now()`,
    [tenantId, entityType, JSON.stringify(def)],
  );
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
