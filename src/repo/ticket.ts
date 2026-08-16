// 工单仓储：所有 SQL 在已注入 tenant_id 的 client 内执行（RLS 自动隔离）。
// 双保险：每条读/写显式 WHERE tenant_id = $1（P1）。
import type { PoolClient } from 'pg';
import { AppError } from '../middleware/error.js';
import { canTransition, isKnownState, type WorkOrderStatus } from '../engine/stateMachine.js';
import { getWorkflowDef } from '../engine/workflowDef.js';
import { emitDomainEvent } from '../db/eventBus.js';

export interface CreateDto {
  id: string;
  tenantId: string;
  businessType: string;
  catalog?: string;
  priority?: string;
  location?: string;
  title?: string;
  description?: string;
  contact?: string;
  assets?: unknown[];
  idempotencyKey?: string;
}

export interface WorkOrderRow {
  id: string;
  tenant_id: string;
  order_no: string;        // 业务工单号（DEF-1/DEF-2 修复：真实可读工单号，非成功码）
  business_type: string;
  catalog: string | null;
  priority: string;
  location: string | null;
  title: string | null;
  description: string | null;
  contact: string | null;
  status: WorkOrderStatus;
  assignee_id: string | null;
  auto_flow: boolean;
  assets: unknown;
  created_at: string;
  updated_at: string;
}

/** 生成业务工单号：WO_YYYYMMDD_随机6位（同日不保证严格唯一，由唯一约束兜底）。 */
function genOrderNo(d: Date = new Date()): string {
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `WO_${ymd}_${rand}`;
}

/** 幂等创建：幂等键命中则返回原工单，否则插入 + 写幂等键 + 审计。 */
export async function createWithIdem(
  client: PoolClient,
  dto: CreateDto,
): Promise<{ row: WorkOrderRow; created: boolean }> {
  if (dto.idempotencyKey) {
    const hit = await client.query<{ work_order_id: string }>(
      'SELECT work_order_id FROM idempotency_key WHERE key = $1 AND tenant_id = $2',
      [dto.idempotencyKey, dto.tenantId],
    );
    if (hit.rows[0]?.work_order_id) {
      const existing = await findOne(client, dto.tenantId, hit.rows[0].work_order_id);
      if (existing) return { row: existing, created: false };
    }
  }
  const orderNo = genOrderNo();
  const ins = await client.query<WorkOrderRow>(
    `INSERT INTO work_orders
       (id, tenant_id, order_no, business_type, catalog, priority, location, title, description, contact, assets, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft')
     RETURNING *`,
    [
      dto.id, dto.tenantId, orderNo, dto.businessType, dto.catalog ?? null, dto.priority ?? 'normal',
      dto.location ?? null, dto.title ?? null, dto.description ?? null, dto.contact ?? null,
      JSON.stringify(dto.assets ?? []),
    ],
  );
  if (dto.idempotencyKey) {
    await client.query(
      'INSERT INTO idempotency_key (key, tenant_id, work_order_id) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING',
      [dto.idempotencyKey, dto.tenantId, dto.id],
    );
  }
  await client.query(
    `INSERT INTO ticket_event (tenant_id, work_order_id, type, from_status, to_status, actor)
     VALUES ($1,$2,'create',NULL,'draft','system')`,
    [dto.tenantId, dto.id],
  );
  await emitDomainEvent(client, { tenantId: dto.tenantId, entityType: 'work_order', entityId: dto.id, type: 'create', actor: 'system' });
  return { row: ins.rows[0], created: true };
}

/** 状态流转：校验合法跳转，更新状态 + 审计。 */
export async function transition(
  client: PoolClient,
  tenantId: string,
  id: string,
  to: WorkOrderStatus,
  actor = 'system',
): Promise<WorkOrderRow> {
  const cur = await findOne(client, tenantId, id);
  if (!cur) throw new AppError('NOT_FOUND', 'work order not found', 404);
  // T-①：状态合法性由 workflow_def（可配置状态机）校验，不再写死固定字典
  const def = await getWorkflowDef(client, tenantId, 'work_order');
  if (!isKnownState(def, cur.status) || !isKnownState(def, to)) {
    throw new AppError('CONFLICT', `unknown state: from=${cur.status} to=${to}`, 422);
  }
  if (!canTransition(def, cur.status, to)) {
    throw new AppError(
      'CONFLICT',
      `illegal transition ${cur.status} -> ${to}`,
      422,
    );
  }
  const upd = await client.query<WorkOrderRow>(
    `UPDATE work_orders SET status = $1, updated_at = now() WHERE id = $2 AND tenant_id = $3 RETURNING *`,
    [to, id, tenantId],
  );
  await client.query(
    `INSERT INTO ticket_event (tenant_id, work_order_id, type, from_status, to_status, actor)
     VALUES ($1,$2,'transition',$3,$4,$5)`,
    [tenantId, id, cur.status, to, actor],
  );
  // ④ 真实事件总线：每次状态流转自动记账到 domain_event（type=新状态=过程挖掘活动节点）。
  // 覆盖 processing/completed 及 T-①/T-② 注入的 recheck/escalated 等新状态，飞轮从此吃真数据；
  // create/assign 已在 createWithIdem / workOrder 建单路由内 emit，此处不重复。
  await emitDomainEvent(client, {
    tenantId,
    entityType: 'work_order',
    entityId: id,
    type: to,
    actor,
    payload: { from_status: cur.status, to_status: to },
  });
  return upd.rows[0];
}

export async function findOne(
  client: PoolClient,
  tenantId: string,
  id: string,
): Promise<WorkOrderRow | null> {
  const r = await client.query<WorkOrderRow>(
    'SELECT * FROM work_orders WHERE id = $1 AND tenant_id = $2',
    [id, tenantId],
  );
  return r.rows[0] ?? null;
}

export async function list(
  client: PoolClient,
  tenantId: string,
  filter: { status?: WorkOrderStatus; limit?: number; offset?: number },
): Promise<{ items: WorkOrderRow[]; total: number }> {
  const conds = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  if (filter.status) {
    params.push(filter.status);
    conds.push(`status = $${params.length}`);
  }
  const where = conds.join(' AND ');
  const totalR = await client.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM work_orders WHERE ${where}`,
    params,
  );
  const limit = filter.limit ?? 20;
  const offset = filter.offset ?? 0;
  const listR = await client.query<WorkOrderRow>(
    `SELECT * FROM work_orders WHERE ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return { items: listR.rows, total: Number(totalR.rows[0].c) };
}
