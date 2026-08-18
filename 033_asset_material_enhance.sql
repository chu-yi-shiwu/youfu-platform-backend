-- 033_asset_material_enhance.sql —— P1 资产/耗材完整化
-- 资产补：财务分类 / 购置日期 / 购置金额 / 供应商；新增维保历史表。
-- 耗材补：文档说明(doc)。
-- DDL 以 superuser(postgres) 执行；ADD COLUMN IF NOT EXISTS 保证幂等可重跑。
-- （本脚本由 node dist/db/migrate.js 扫描执行；首次走基线初始化后仅新增迁移会被执行。）

-- 资产增强列
ALTER TABLE asset ADD COLUMN IF NOT EXISTS financial_category text;
ALTER TABLE asset ADD COLUMN IF NOT EXISTS purchase_date date;
ALTER TABLE asset ADD COLUMN IF NOT EXISTS price numeric(12,2);
ALTER TABLE asset ADD COLUMN IF NOT EXISTS supplier text;

-- 维保历史（一台资产多条）
CREATE TABLE IF NOT EXISTS asset_maintenance (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  asset_id      uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  maintain_date date,
  type          text,            -- 保养 / 维修 / 校准 / 其他
  cost          numeric(12,2),
  vendor        text,            -- 维保厂商
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE asset_maintenance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS asset_maintenance_tenant_isolation ON asset_maintenance;
CREATE POLICY asset_maintenance_tenant_isolation ON asset_maintenance
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON asset_maintenance TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_asset_maintenance_tenant_asset ON asset_maintenance(tenant_id, asset_id);

-- 耗材文档列
ALTER TABLE material ADD COLUMN IF NOT EXISTS doc text;
