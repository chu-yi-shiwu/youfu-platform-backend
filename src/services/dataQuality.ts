// C2 数据质量治理层（设计第 0 层）：事件/工单写入 gate —— 语义归一/校验/去噪/完整性。
//
// 作用（封死 n3「低质数据喂模型」隐患）：
//   - 纯函数 validateEvent / validateOrder / assessQuality 用于度量接口与单测。
//   - 在 modelTrainer 消费事件前，丢弃无法归因（缺 business_type）或异常的事件，避免污染模型。
//   - /stats/data-quality 接口给出租户数据质量评分与问题分布（诚实：无数据时返回 1.0 + note，不编造）。
import type { PoolClient } from 'pg';

export interface QualityIssue {
  entity: string;
  field: string;
  problem: string;
}

export interface QualityReport {
  score: number;
  total: number;
  by_type: Record<string, number>;
  note: string;
}

const KNOWN_EVENT_TYPES = new Set([
  'create', 'signup', 'checkin', 'checkout', 'approve', 'complete', 'exception',
  'convert', 'submit', 'reply', 'status_change', 'alert', 'resolve', 'assign', 'sla_escalated',
]);
const KNOWN_ENTITY_TYPES = new Set([
  'work_order', 'volunteer_activity', 'volunteer_record', 'inspection_task',
  'inspection_point', 'feedback', 'monitor_device', 'monitor_alert',
]);

/** 纯函数：校验单条统一事件总线的事件。 */
export function validateEvent(ev: {
  entity_type?: string;
  entity_id?: string | null;
  type?: string;
  created_at?: string;
  payload?: unknown;
}): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const et = String(ev.entity_type ?? '?');
  if (!ev.entity_type || !KNOWN_ENTITY_TYPES.has(ev.entity_type))
    issues.push({ entity: et, field: 'entity_type', problem: '未知/缺失实体类型' });
  if (ev.entity_id == null)
    issues.push({ entity: et, field: 'entity_id', problem: '缺失 entity_id' });
  if (!ev.type || !KNOWN_EVENT_TYPES.has(ev.type))
    issues.push({ entity: et, field: 'type', problem: '未知/缺失事件类型' });
  if (ev.created_at) {
    const t = new Date(ev.created_at).getTime();
    if (Number.isNaN(t)) issues.push({ entity: et, field: 'created_at', problem: '日期格式不可解析' });
    else if (t > Date.now() + 60_000) issues.push({ entity: et, field: 'created_at', problem: '未来时间戳' });
  }
  if (ev.payload == null)
    issues.push({ entity: et, field: 'payload', problem: '空 payload' });
  return issues;
}

/** 纯函数：校验工单（模型归因维度 + SLA 合理性）。 */
export function validateOrder(o: {
  id: string;
  business_type?: string | null;
  sla_due_at?: string | null;
  created_at?: string;
}): QualityIssue[] {
  const issues: QualityIssue[] = [];
  if (!o.business_type)
    issues.push({ entity: o.id, field: 'business_type', problem: '缺失 business_type（模型维度缺失）' });
  if (o.sla_due_at && o.created_at) {
    const due = new Date(o.sla_due_at).getTime();
    const crt = new Date(o.created_at).getTime();
    if (!Number.isNaN(due) && !Number.isNaN(crt) && due < crt)
      issues.push({ entity: o.id, field: 'sla_due_at', problem: 'SLA 截止早于创建时间' });
  }
  return issues;
}

/** 纯函数：由事件+工单集合评估数据质量（启发式评分 = 1 - 问题数/实体数）。 */
export function assessQuality(
  events: Parameters<typeof validateEvent>[0][],
  orders: Parameters<typeof validateOrder>[0][],
): QualityReport {
  const all: QualityIssue[] = [];
  for (const e of events) all.push(...validateEvent(e));
  for (const o of orders) all.push(...validateOrder(o));
  const by_type: Record<string, number> = {};
  for (const i of all) by_type[i.problem] = (by_type[i.problem] ?? 0) + 1;
  const total = events.length + orders.length;
  const raw = total ? 1 - all.length / total : 1;
  const score = Number(Math.max(0, Math.min(1, raw)).toFixed(4));
  const note = total
    ? ''
    : '当前租户无事件/工单数据，质量评分无数据可算（返回 1.0，不编造问题）';
  return { score, total, by_type, note };
}

/** DB 聚合：读 domain_event + work_orders 评估数据质量。 */
export async function qualityReport(client: PoolClient, tenantId: string): Promise<QualityReport> {
  const ev = await client.query<{
    entity_type: string; entity_id: string | null; type: string;
    created_at: string; payload: unknown;
  }>(
    `SELECT entity_type, entity_id, type, created_at, payload
     FROM domain_event WHERE tenant_id = $1`,
    [tenantId],
  );
  const wo = await client.query<{
    id: string; business_type: string | null; sla_due_at: string | null; created_at: string;
  }>(
    `SELECT id, business_type, sla_due_at, created_at FROM work_orders WHERE tenant_id = $1`,
    [tenantId],
  );
  return assessQuality(
    ev.rows.map((r) => ({
      entity_type: r.entity_type, entity_id: r.entity_id, type: r.type,
      created_at: r.created_at, payload: r.payload,
    })),
    wo.rows.map((r) => ({
      id: r.id, business_type: r.business_type, sla_due_at: r.sla_due_at, created_at: r.created_at,
    })),
  );
}
