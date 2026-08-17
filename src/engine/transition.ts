// 通用业务流流转（P3 横向克隆引擎原语）。
// 把 inspection.ts 的 transitionTask 抽象为通用助手，供 transport/emergency/cycle_check
// 等任意 entity_type 复用，避免逐模块硬编码状态机（红线：所有业务流必须过 workflow_def）。
// 表名经白名单校验（防注入），状态由 workflow_def 引擎 applyEvent 校验，data(jsonb) 合并 extra。
import { AppError } from '../middleware/error.js';
import { getWorkflowDefOrDefault } from './workflowDef.js';
import { applyEvent, type WorkflowDef } from './stateMachine.js';
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
}

/**
 * 读取实体当前 status → 用引擎校验 event 合法性 → 写入目标态，并把 extra 合并进 data。
 * 返回更新后的整行。非法流转抛 BAD_STATE(422)。
 */
export async function transitionEntity(
  client: any,
  tenantId: string,
  opts: TransitionEntityOpts,
): Promise<any> {
  if (!ALLOWED_TABLES.has(opts.table)) {
    throw new AppError('BAD_REQUEST', `table not allowed: ${opts.table}`, 400);
  }
  const idCol = opts.idCol ?? 'id';
  const cur = await client.query(
    `SELECT * FROM ${opts.table} WHERE ${idCol} = $1 AND tenant_id = $2`,
    [opts.id, tenantId],
  );
  if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'entity not found', 404);
  const row = cur.rows[0];

  const def = await getWorkflowDefOrDefault(client, tenantId, opts.entityType, opts.fallbackDef);
  const target = applyEvent(def, row.status, opts.event);
  if (!target) {
    throw new AppError('BAD_STATE', `illegal transition ${row.status} --${opts.event}-->`, 422);
  }

  const extra = opts.extra ?? {};
  const extraKeys = Object.keys(extra);
  const nowKeys = extraKeys.filter((k) => extra[k] === 'now()');
  const dataKeys = extraKeys.filter((k) => extra[k] !== 'now()');

  const setClauses = ['status = $3', 'updated_at = now()'];
  const values: unknown[] = [opts.id, tenantId, target];

  if (dataKeys.length > 0) {
    const jsonObj: Record<string, unknown> = {};
    dataKeys.forEach((k) => {
      jsonObj[k] = extra[k];
    });
    values.push(JSON.stringify(jsonObj));
    setClauses.push(`data = data || $${values.length}::jsonb`);
  }
  nowKeys.forEach((k) => {
    setClauses.push(`data = jsonb_set(data, '{${k}}', to_json(now()), true)`);
  });

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
