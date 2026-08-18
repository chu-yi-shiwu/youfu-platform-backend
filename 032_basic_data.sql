-- 032 基础数据：区域 / 联系人 / 供应商 三类主数据（P1 回归修复，幂等可重跑）。
-- RLS 铁底线：所有表带 tenant_id，启用行级安全 + youfu_app 策略；写操作经 requireConfigRole。
-- 注：线上库已存在这三张表（命名 region/contact/supplier），本文件仅作版本化基线；全 IF NOT EXISTS/IF EXISTS 保证重跑安全。

CREATE TABLE IF NOT EXISTS region (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  name text NOT NULL,
  code text,
  parent_id text,
  remark text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  name text NOT NULL,
  phone text,
  email text,
  org text,
  dept text,
  remark text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS supplier (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  name text NOT NULL,
  contact_person text,
  phone text,
  address text,
  category text,
  remark text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 租户隔离索引
CREATE INDEX IF NOT EXISTS idx_region_tenant ON region (tenant_id);
CREATE INDEX IF NOT EXISTS idx_contact_tenant ON contact (tenant_id);
CREATE INDEX IF NOT EXISTS idx_supplier_tenant ON supplier (tenant_id);

-- RLS
ALTER TABLE region ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS region_tenant_policy ON region;
CREATE POLICY region_tenant_policy ON region FOR ALL TO youfu_app USING (tenant_id = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS contact_tenant_policy ON contact;
CREATE POLICY contact_tenant_policy ON contact FOR ALL TO youfu_app USING (tenant_id = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS supplier_tenant_policy ON supplier;
CREATE POLICY supplier_tenant_policy ON supplier FOR ALL TO youfu_app USING (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON region, contact, supplier TO youfu_app;
