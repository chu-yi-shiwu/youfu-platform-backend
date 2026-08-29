-- 016_inventory.sql —— 批次 C：库存台账 + 出入库流水（仓库物资模块）
-- 与既有表一致：tenant_id text + RLS(app_tenant_id) + GRANT youfu_app。
-- DDL 须以 superuser(postgres) 执行。
--   psql "$DATABASE_URL_POSTGRES" -f 016_inventory.sql
-- 注意：出库防超卖靠路由层 SELECT ... FOR UPDATE（见 routes/material.ts），
--       本 SQL 只定义结构，不在此处加事务约束。

CREATE TABLE IF NOT EXISTS inventory (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  text NOT NULL,
  material_id uuid NOT NULL REFERENCES material(id) ON DELETE RESTRICT,
  warehouse  text NOT NULL DEFAULT '中心库',  -- 仓库维度用 text（本批次不单独建 warehouse 表，降复杂度）
  qty        integer NOT NULL DEFAULT 0,      -- 实时库存
  min_qty    integer DEFAULT 0,               -- 预警阈值
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  text NOT NULL,
  material_id uuid NOT NULL,
  type       text NOT NULL CHECK (type IN ('in','out','adjust')),
  qty        integer NOT NULL,                -- 正数，方向由 type 决定
  ref_no     text,                            -- 关联单号（工单号/RK单号）
  note       text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_tenant_isolation ON inventory;
CREATE POLICY inventory_tenant_isolation ON inventory
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE inventory_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_log_tenant_isolation ON inventory_log;
CREATE POLICY inventory_log_tenant_isolation ON inventory_log
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON inventory TO youfu_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_log TO youfu_app;

CREATE INDEX IF NOT EXISTS idx_inventory_tenant_mat ON inventory(tenant_id, material_id);
CREATE INDEX IF NOT EXISTS idx_invlog_tenant ON inventory_log(tenant_id);
