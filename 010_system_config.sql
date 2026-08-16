-- 010_system_config.sql —— 批次 A：系统 / 品牌配置（品牌名、LOGO 等）
-- key-value 存储，按租户隔离；运营可自助改品牌名 / LOGO，无需改代码。
-- 执行：psql "$DATABASE_URL_POSTGRES" -f 010_system_config.sql

CREATE TABLE IF NOT EXISTS system_config (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  key         text NOT NULL,                         -- 如 brand_name / brand_logo_url
  value       text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

ALTER TABLE system_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_config_tenant_isolation ON system_config;
CREATE POLICY system_config_tenant_isolation ON system_config
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON system_config TO youfu_app;

CREATE INDEX IF NOT EXISTS idx_system_config_tenant_key
  ON system_config (tenant_id, key);
