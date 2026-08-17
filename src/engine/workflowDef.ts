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

/** upsert 状态图（版本自增，记录变更历史）。 */
export async function saveWorkflowDef(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  def: WorkflowDef,
): Promise<void> {
  await client.query(
    `INSERT INTO workflow_def (tenant_id, entity_type, def, version)
     VALUES ($1,$2,$3,1)
     ON CONFLICT (tenant_id, entity_type)
     DO UPDATE SET def = EXCLUDED.def, version = workflow_def.version + 1, updated_at = now()`,
    [tenantId, entityType, JSON.stringify(def)],
  );
}

function normalizeDef(d: any): WorkflowDef {
  return {
    initial: d?.initial ?? 'draft',
    states: Array.isArray(d?.states) ? d.states : ['draft', 'assigned', 'processing', 'completed'],
    transitions: Array.isArray(d?.transitions) ? d.transitions : [],
    config: d?.config ?? {},
  };
}

// 深拷贝：用 JSON 往返而非 structuredClone，兼容 ECS Node16（structuredClone 为 Node17+ 全局）。
function cloneDef(d: WorkflowDef): WorkflowDef {
  return JSON.parse(JSON.stringify(d));
}
