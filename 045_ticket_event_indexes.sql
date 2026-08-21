-- 045_ticket_event_indexes.sql
-- P-2：ticket_event 性能索引（事件流水表，过程挖掘/统计下钻高频按租户+工单+时间查）。
-- 注意：本表列名为 work_order_id（非 ticket_id），此前审计误记为 ticket_id，此处以真实 DDL 为准。
--   - (tenant_id, work_order_id, created_at)：按工单反查事件时间线（modelTrainer / workOrder 事件流）。
--   - (tenant_id, created_at)：按租户全量事件时间线（过程挖掘 / 统计）。
-- 部署契约：以数据库属主（ECS 上 postgres）执行；youfu_app 为非属主无权 CREATE INDEX。
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 045_ticket_event_indexes.sql
-- 幂等：全部 IF NOT EXISTS，可安全重跑。

CREATE INDEX IF NOT EXISTS idx_ticket_event_tenant_wo_created
  ON ticket_event (tenant_id, work_order_id, created_at);

CREATE INDEX IF NOT EXISTS idx_ticket_event_tenant_created
  ON ticket_event (tenant_id, created_at);
