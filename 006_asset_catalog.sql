-- 006_asset_catalog.sql —— 生产化②：资产台账数据库化（替换 scan.ts 写死账本）。
-- 目的：把 M3 写死在代码里的"目录码/资产码"账本搬进 DB，运维改资产/目录只改数据不改代码。
--  - asset_catalog ：业务目录（电工/水工/标本护送/病人陪检…），含展示名与技能线索
--  - asset_registry：资产台账（3F-空调-01 等），关联目录码 + 技能线索
-- 设计：复合主键 (tenant_id, code) 支持真正多租户（同 code 不同租户可各自覆盖）；
--       RLS 沿用既有范式（app_tenant_id() + SET ROLE youfu_app）；模板(template)由代码常量推导，不在 DB 冗余。
-- 执行：本迁移为 DDL，**必须用 superuser(postgres) 执行**（youfu_app 无 DDL 权）。
--   PGPASSWORD=youfu2026 psql -U postgres -h 127.0.0.1 -p 5432 -d youfu -f 006_asset_catalog.sql

-- 1) 业务目录表
CREATE TABLE IF NOT EXISTS asset_catalog (
  tenant_id    text NOT NULL,
  catalog_code text NOT NULL,
  label        text NOT NULL,
  skill_tags   text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, catalog_code)
);

-- 2) 资产登记表
CREATE TABLE IF NOT EXISTS asset_registry (
  tenant_id    text NOT NULL,
  asset_code   text NOT NULL,
  label        text NOT NULL,
  catalog_code text NOT NULL,                      -- 关联 asset_catalog.catalog_code
  skill_tags   text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, asset_code)
);

-- 3) RLS：按租户隔离（与既有表一致）
ALTER TABLE asset_catalog  ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_registry ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS asset_catalog_tenant_isolation ON asset_catalog;
CREATE POLICY asset_catalog_tenant_isolation ON asset_catalog
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

DROP POLICY IF EXISTS asset_registry_tenant_isolation ON asset_registry;
CREATE POLICY asset_registry_tenant_isolation ON asset_registry
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- 4) 业务角色授权（属主为 postgres，youfu_app 仅运行时读写）
GRANT SELECT, INSERT, UPDATE ON asset_catalog  TO youfu_app;
GRANT SELECT, INSERT, UPDATE ON asset_registry TO youfu_app;

-- 5) 索引：资产按目录反查（同租户下某目录的资产集合）
CREATE INDEX IF NOT EXISTS idx_asset_registry_tenant_catalog
  ON asset_registry (tenant_id, catalog_code);

-- 6) 种子：把 scan.ts 现有 4 目录 + 3 资产 导入 t-verification（演示租户，与 seed_workers 一致）。
--    幂等：ON CONFLICT 跳过已存在的同租户同 code，避免污染真实环境。真实多租户部署时按需复制此块。
INSERT INTO asset_catalog (tenant_id, catalog_code, label, skill_tags) VALUES
  ('t-verification', 'ELECTRICIAN',   '电工维修', '{electric}'),
  ('t-verification', 'PLUMBER',       '水工维修', '{plumbing}'),
  ('t-verification', 'SPECIMEN',      '标本护送', '{transport}'),
  ('t-verification', 'PATIENT_ESCORT','病人陪检', '{escort}')
ON CONFLICT (tenant_id, catalog_code) DO NOTHING;

INSERT INTO asset_registry (tenant_id, asset_code, label, catalog_code, skill_tags) VALUES
  ('t-verification', '3F-AIRCON-01', '3F-空调-01',   'ELECTRICIAN',   '{electric}'),
  ('t-verification', '5F-PUMP-02',   '5F-水泵-02',   'PLUMBER',       '{plumbing}'),
  ('t-verification', '2F-CRT-07',    '2F-离心机-07', 'SPECIMEN',      '{transport}')
ON CONFLICT (tenant_id, asset_code) DO NOTHING;
