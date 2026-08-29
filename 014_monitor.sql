-- 014_monitor.sql —— 批次 B：网管监控模块（PRD §G）
-- 网管监控 = 独立监控引擎（展示设备/网络状态、异常提醒），异常可触发一条工单，
-- 但监控本身不是工单（不混流程）。真实采集由监控代理上报，原型期提供状态/告警录入与"生成工单"。
--   monitor_device：被监控设备/节点（状态、流量、最后可见）
--   monitor_alert ：告警（级别、消息、状态）
-- 与既有表一致：uuid 主键 + tenant_id + RLS + GRANT + 索引。
-- 本迁移为 DDL，须以 superuser(postgres) 执行：
--   psql "$DATABASE_URL_POSTGRES" -f 014_monitor.sql

CREATE TABLE IF NOT EXISTS monitor_device (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  name        text NOT NULL,
  ip          text,
  category    text,                          -- 网络 | 服务器 | 其他
  status      text NOT NULL DEFAULT 'online',-- online | offline | warning
  last_seen   timestamptz,                   -- 最后上报时间
  traffic_in  double precision DEFAULT 0,    -- 入流量（原型期可模拟）
  traffic_out double precision DEFAULT 0,    -- 出流量
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE monitor_device ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS monitor_device_tenant_isolation ON monitor_device;
CREATE POLICY monitor_device_tenant_isolation ON monitor_device
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON monitor_device TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_monitor_device_tenant ON monitor_device (tenant_id);
CREATE INDEX IF NOT EXISTS idx_monitor_device_tenant_status ON monitor_device (tenant_id, status);

CREATE TABLE IF NOT EXISTS monitor_alert (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  device_id   uuid NOT NULL,
  level       text NOT NULL DEFAULT 'warning', -- info | warning | critical
  message     text NOT NULL,
  status      text NOT NULL DEFAULT 'active',  -- active | resolved
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE monitor_alert ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS monitor_alert_tenant_isolation ON monitor_alert;
CREATE POLICY monitor_alert_tenant_isolation ON monitor_alert
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON monitor_alert TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_monitor_alert_tenant_device ON monitor_alert (tenant_id, device_id);
CREATE INDEX IF NOT EXISTS idx_monitor_alert_tenant_status ON monitor_alert (tenant_id, status);
