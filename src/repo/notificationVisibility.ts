// notificationVisibility.ts —— 通知列表「孤儿过滤」的单一事实源。
//
// 背景：notification.work_order_id 是 NOT NULL text 列且无外键。工单通知存 work_orders.id；
// 运送单通知没有专属列，按约定「借位」存 transport_order.id，并用 payload.entity_type
// 标记真实实体（见 routes/transport.ts、scheduler/slaScheduler.ts）。
//
// 旧过滤 `EXISTS (SELECT 1 FROM work_orders ...)` 会把整类运送通知当成孤儿丢弃，
// 导致工人收不到派单 / SLA 提醒。这里按 entity_type 分流，两个分支都对齐 tenant_id，
// 防止跨租户 id 碰撞把已删通知误判为「存活」。
//
// payload 缺省或不是 transport_order ⇒ 仍走 work_orders，与改造前行为完全一致。
// 🔴 2026-11-08 生产实锤：transport_order.id 是 uuid，notification.work_order_id 是 text，
//    直接 `t.id = n.work_order_id` 会 500（operator does not exist: uuid = text）。
//    必须 `t.id::text = n.work_order_id`；不要在通知表上改类型（会波及全部借位写入方）。

/**
 * 孤儿通知过滤 SQL 片段（用于 `FROM notification n` 查询的 WHERE）。
 * 纯字符串、无参数占位，调用方可直接拼进已有的 AND 条件数组。
 */
export function notificationOrphanGuardSql(): string {
  return `(
    (n.payload->>'entity_type' = 'transport_order'
      AND EXISTS (SELECT 1 FROM transport_order t WHERE t.id::text = n.work_order_id AND t.tenant_id = n.tenant_id))
    OR
    (n.payload->>'entity_type' = 'volunteer_activity'
      AND EXISTS (SELECT 1 FROM volunteer_activity va WHERE va.id::text = n.work_order_id AND va.tenant_id = n.tenant_id))
    OR
    ((n.payload->>'entity_type' IS DISTINCT FROM 'transport_order'
      AND n.payload->>'entity_type' IS DISTINCT FROM 'volunteer_activity')
      AND EXISTS (SELECT 1 FROM work_orders wo WHERE wo.id = n.work_order_id AND wo.tenant_id = n.tenant_id))
  )`;
}
