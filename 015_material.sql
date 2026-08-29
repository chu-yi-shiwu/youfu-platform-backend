-- 015_material.sql —— 批次 C：材料档案（仓库物资模块）
-- 与全部既有表一致：tenant_id text + RLS(app_tenant_id) + GRANT youfu_app。
-- 注意：本迁移为 DDL，须以 superuser(postgres) 执行（youfu_app 无 DDL 权，见 005 注释）。
--   psql "$DATABASE_URL_POSTGRES" -f 015_material.sql

CREATE TABLE IF NOT EXISTS material (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  text NOT NULL,
  code       text NOT NULL,                 -- 材料编码（租户内唯一）
  name       text NOT NULL,                 -- 材料名称
  category   text,                          -- 分类（如 电气照明）
  spec       text,                          -- 规格型号
  unit       text,                          -- 单位（支/个/米）
  price      numeric(12,2) DEFAULT 0,       -- 默认单价
  enabled    boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, code)
);

ALTER TABLE material ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS material_tenant_isolation ON material;
CREATE POLICY material_tenant_isolation ON material
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON material TO youfu_app;

CREATE INDEX IF NOT EXISTS idx_material_tenant ON material(tenant_id);
