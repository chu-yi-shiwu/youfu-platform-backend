-- 036_asset_material_granularity.sql —— P1 资产/耗材颗粒度补齐（固化已落库但未入库的增强）。
-- 对齐 UOne A4（资产档案/财务分类/标签打印）与 B（文档/导入导出）：
--   asset 补 financial_category/price/supplier；asset_maintenance 维保台账；material 补 doc。
-- 全部 IF NOT EXISTS / DROP POLICY IF EXISTS 幂等，可重复执行；与线上 DB 现状对齐，保证全新库可复现部署。
-- 须以 superuser(postgres) 执行：psql "$DATABASE_URL_POSTGRES" -f 036_asset_material_granularity.sql

-- ============ asset 补列（财务分类/价格/供应商） ============
ALTER TABLE asset ADD COLUMN IF NOT EXISTS financial_category text;
ALTER TABLE asset ADD COLUMN IF NOT EXISTS price numeric(12,2);
ALTER TABLE asset ADD COLUMN IF NOT EXISTS supplier text;

-- ============ asset_maintenance 维保台账 ============
CREATE TABLE IF NOT EXISTS asset_maintenance (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL,
  asset_id        uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  maintain_date   date,
  type            text,            -- 保养|维修|巡检|校准...
  cost            numeric(12,2),
  vendor          text,            -- 维保厂商
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE asset_maintenance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS asset_maintenance_tenant_isolation ON asset_maintenance;
CREATE POLICY asset_maintenance_tenant_isolation ON asset_maintenance
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON asset_maintenance TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_asset_maintenance_tenant_asset ON asset_maintenance (tenant_id, asset_id);

-- ============ material 补列（文档） ============
ALTER TABLE material ADD COLUMN IF NOT EXISTS doc text;
GRANT SELECT, INSERT, UPDATE, DELETE ON material TO youfu_app;
