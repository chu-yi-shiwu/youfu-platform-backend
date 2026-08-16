// 统一事件总线（B1）：在业务事务内 emit 领域事件到 domain_event 表。
// 与工单 ticket_event 同模式，但覆盖所有业务流（工单/志愿者/巡检/反馈/监控），
// 作为"过程挖掘"的统一数据源（B2 度量层 + B3 看板均消费本表）。
// 必须在同一事务 client 内调用，保证租户隔离与原子性。
import type { PoolClient } from 'pg';

export interface DomainEvent {
  tenantId: string;
  entityType: string; // 'work_order' | 'volunteer_activity' | 'volunteer_record' | 'inspection_task' | 'feedback' | 'monitor_device' | 'monitor_alert'
  entityId?: string | null;
  type: string; // 'create' | 'assign' | 'complete' | 'checkin' | 'checkout' | 'exception' | 'convert' | 'submit' | 'reply' | 'alert' | 'resolve' ...
  actor?: string | null;
  payload?: unknown;
}

export async function emitDomainEvent(client: PoolClient, evt: DomainEvent): Promise<void> {
  await client.query(
    `INSERT INTO domain_event (tenant_id, entity_type, entity_id, type, actor, payload)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      evt.tenantId,
      evt.entityType,
      evt.entityId ?? null,
      evt.type,
      evt.actor ?? null,
      JSON.stringify(evt.payload ?? {}),
    ],
  );
}
