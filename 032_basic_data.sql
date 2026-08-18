-- 032_basic_data.sql —— P1 基础数据：区域 / 联系人 / 供应商
-- 与既有表一致：tenant_id text + RLS(app_tenant_id) + GRANT youfu_app。
-- DDL 以 superuser(postgres) 执行；部署时由 node dist/db/migrate.js 扫描根目录幂等执行。
--   （CREATE TABLE IF NOT EXISTS + DROP POLICY IF EXISTS + CREATE POLICY，可重复跑）

-- 区域
CREATE TABLE IF NOT EXISTS region (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  name        text NOT NULL,
  code        text,
  parent_id   text,
  remark      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE region ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS region_tenant_isolation ON region;
CREATE POLICY region_tenant_isolation ON region
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON region TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_region_tenant ON region(tenant_id);

-- 联系人
CREATE TABLE IF NOT EXISTS contact (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  name        text NOT NULL,
  phone       text,
  email       text,
  org         text,
  dept        text,
  remark      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE contact ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_tenant_isolation ON contact;
CREATE POLICY contact_tenant_isolation ON contact
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON contact TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_contact_tenant ON contact(tenant_id);

-- 供应商
CREATE TABLE IF NOT EXISTS supplier (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL,
  name            text NOT NULL,
  contact_person  text,
  phone           text,
  address         text,
  category        text,
  remark          text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE supplier ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS supplier_tenant_isolation ON supplier;
CREATE POLICY supplier_tenant_isolation ON supplier
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON supplier TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_supplier_tenant ON supplier(tenant_id);
