-- 020_domain_event.sql —— 统一事件总线（B1 · 横切优化带·事件总线扩展）
-- 建 domain_event 表（统一领域事件，租户隔离），供工单/志愿者/巡检/反馈/监控 等业务流 emit。
-- 它是"过程挖掘"的统一数据源：B2 度量层 + B3 看板均消费本表。
-- 幂等（migrate.ts 按文件名序重复执行全部 NNN_*.sql）；
-- 须以 superuser(postgres) 执行（youfu_app 无 DDL 权，见 005/008/019 注释）。

CREATE TABLE IF NOT EXISTS domain_event (
  id          bigserial PRIMARY KEY,
  tenant_id   text NOT NULL,
  entity_type text NOT NULL,        -- 'work_order' / 'volunteer_activity' / 'volunteer_record' / 'inspection_task' / 'feedback' / 'monitor_device' / 'monitor_alert'
  entity_id   text,
  type        text NOT NULL,        -- 业务动作：create / assign / complete / checkin / checkout / exception / convert / submit / reply / alert / resolve / sla_escalated ...
  actor       text,                 -- 触发者：'system' / 'auto_dispatch' / 'config_role' / 'user' ...
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE domain_event ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS domain_event_tenant_isolation ON domain_event;
CREATE POLICY domain_event_tenant_isolation ON domain_event
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON domain_event TO youfu_app;
GRANT USAGE, SELECT ON SEQUENCE domain_event_id_seq TO youfu_app;  -- bigserial 自增需序列 USAGE 权（同 019 修复）

CREATE INDEX IF NOT EXISTS idx_domain_event_tenant_type
  ON domain_event (tenant_id, entity_type, type);
CREATE INDEX IF NOT EXISTS idx_domain_event_tenant_created
  ON domain_event (tenant_id, created_at);
