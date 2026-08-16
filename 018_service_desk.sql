-- 018_service_desk.sql —— 批次 C：服务台 + 客服人员（服务台模块）
-- 与既有表一致：tenant_id text + RLS(app_tenant_id) + GRANT youfu_app。
-- DDL 须以 superuser(postgres) 执行。
--   psql "$DATABASE_URL_POSTGRES" -f 018_service_desk.sql

CREATE TABLE IF NOT EXISTS service_desk (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  text NOT NULL,
  name       text NOT NULL,                   -- 服务台名称
  template   text,                            -- 关联工单模板（如 维修标准模板）
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS service_desk_agent (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  text NOT NULL,
  desk_id    uuid NOT NULL REFERENCES service_desk(id) ON DELETE CASCADE,
  user_id    text NOT NULL,                   -- 关联 account_user.id
  name       text NOT NULL,                   -- 客服人员姓名
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, desk_id, user_id)
);

ALTER TABLE service_desk ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_desk_tenant_isolation ON service_desk;
CREATE POLICY service_desk_tenant_isolation ON service_desk
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE service_desk_agent ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_desk_agent_tenant_isolation ON service_desk_agent;
CREATE POLICY service_desk_agent_tenant_isolation ON service_desk_agent
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON service_desk TO youfu_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON service_desk_agent TO youfu_app;

CREATE INDEX IF NOT EXISTS idx_desk_tenant ON service_desk(tenant_id);
CREATE INDEX IF NOT EXISTS idx_agent_desk ON service_desk_agent(desk_id);
