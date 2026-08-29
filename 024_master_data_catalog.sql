-- 024_master_data_catalog.sql —— ② 主数据补全：新增「商品目录」(product_catalog) 主数据表。
-- 与既有表一致：多租户隔离（app_tenant_id + RLS）、DDL 必须用 superuser(postgres) 执行
-- （youfu_app 无 DDL 权）。
-- 说明：既有 asset_catalog 是「业务技能目录」（电工/水工…，用于派单技能匹配），本表是
--       「商品/服务目录」（可计价的标准服务项/耗材目录，供工单报价、服务台引用），二者职责不同。
-- 执行： psql "$DATABASE_URL_POSTGRES" -f 024_master_data_catalog.sql
--       （migrate.ts 按序加载所有 NNN_*.sql，已存在库可重复执行，本迁移幂等）

-- 1) 商品目录表：租户内编码唯一；RLS 按租户隔离
CREATE TABLE IF NOT EXISTS product_catalog (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL,
  code         text NOT NULL,
  name         text NOT NULL,
  category     text,
  unit         text,
  price        numeric(12, 2) NOT NULL DEFAULT 0,
  enabled      boolean NOT NULL DEFAULT true,
  description  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

-- 2) RLS：按租户隔离（与既有表一致，TO youfu_app，连接层 SET ROLE youfu_app 后生效）
ALTER TABLE product_catalog ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_catalog_tenant_isolation ON product_catalog;
CREATE POLICY product_catalog_tenant_isolation ON product_catalog
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- 3) 业务角色授权（属主为 postgres，youfu_app 仅运行时读写）
GRANT SELECT, INSERT, UPDATE, DELETE ON product_catalog TO youfu_app;

-- 4) 索引：列表按租户过滤；按租户+编码快速定位（唯一约束已隐含索引，但显式补充便于排序/反查）
CREATE INDEX IF NOT EXISTS idx_product_catalog_tenant ON product_catalog (tenant_id);
CREATE INDEX IF NOT EXISTS idx_product_catalog_tenant_cat ON product_catalog (tenant_id, category);
