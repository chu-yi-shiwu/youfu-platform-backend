// workflow_def 仓储（T-①）：读/确保/保存每租户每业务流的状态图定义。
// 状态图存 DB，由可配置状态机引擎消费，实现"流程零代码配置"。
import type { PoolClient } from 'pg';
import { DEFAULT_WORK_ORDER_DEF, type WorkflowDef } from './stateMachine.js';

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
  if (!raw) return cloneDef(fallback);
  return normalizeDef(typeof raw === 'string' ? JSON.parse(raw) : raw);
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
    return normalizeDef(typeof raw === 'string' ? JSON.parse(raw) : raw);
  }
  const def = cloneDef(DEFAULT_WORK_ORDER_DEF);
  await client.query(
    `INSERT INTO workflow_def (tenant_id, entity_type, def, version) VALUES ($1,$2,$3,1)`,
    [tenantId, entityType, JSON.stringify(def)],
  );
  return def;
}

/** upsert 状态图（版本自增，记录变更历史）。
 *  S2：保存前把「当前旧版」快照写入 workflow_def_history（append-only，S3 版本回滚地基）；
 *  reason 为来源标记（手工保存/模板应用/回滚，G5：模板应用与自优化不互斥）。 */
export async function saveWorkflowDef(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  def: WorkflowDef,
  opts?: { operator?: string; reason?: string },
): Promise<void> {
  const cur = await client.query<{ version: number; def: unknown }>(
    'SELECT version, def FROM workflow_def WHERE tenant_id = $1 AND entity_type = $2',
    [tenantId, entityType],
  );
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
