-- 076_transport_sla.sql —— P1：B2 运送线补 SLA 字段
-- 背景（审查报告 20260908 🟡）：transport_order 此前无 sla_due_at/escalated_at，
-- SLA cron（slaScheduler）只扫 work_orders——运送单超时（实测卡 transporting 15 天）零告警。
-- 本迁移纯加法两列 + 部分索引；存量单 sla_due_at 为 NULL = 不纳入扫描（诚实：不回溯估时）。
-- 新单由 POST /transport/orders 的 sla_due_at 入参写入（不传 = 不纳入）。
-- 本迁移为 DDL，须以 superuser(postgres) 执行：
--   psql "$DATABASE_URL_POSTGRES" -f 076_transport_sla.sql

ALTER TABLE transport_order ADD COLUMN IF NOT EXISTS sla_due_at timestamptz;
ALTER TABLE transport_order ADD COLUMN IF NOT EXISTS escalated_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_transport_order_sla_due
  ON transport_order (tenant_id, sla_due_at)
  WHERE sla_due_at IS NOT NULL;
