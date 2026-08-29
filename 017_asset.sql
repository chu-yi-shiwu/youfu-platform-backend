-- 017_asset.sql —— 批次 C：资产档案（资产管理模块）
-- 与既有表一致：tenant_id text + RLS(app_tenant_id) + GRANT youfu_app。
-- DDL 须以 superuser(postgres) 执行。
--   psql "$DATABASE_URL_POSTGRES" -f 017_asset.sql
-- 契约（防错位）：DB status 枚举 = in_use/repairing/standby/disabled；
--   前端显示中文（在用/维修中/备用/停用），禁止中文直接入库。

CREATE TABLE IF NOT EXISTS asset (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  asset_no    text,                           -- 资产编号（可空，建档后生成）
  name        text NOT NULL,
  model       text,
  pinyin      text,                           -- 首拼（搜索用）
  location    text,                           -- 绑定区域
  status      text NOT NULL DEFAULT 'in_use'
                CHECK (status IN ('in_use','repairing','standby','disabled')),
  has_sno     boolean DEFAULT false,
  sno         text,
  qr_code     text,                           -- 二维码内容（建档时生成）
  linked_order_ids uuid[],                    -- 关联维修/巡检工单（只读聚合，不在此写）
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE asset ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS asset_tenant_isolation ON asset;
CREATE POLICY asset_tenant_isolation ON asset
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON asset TO youfu_app;

CREATE INDEX IF NOT EXISTS idx_asset_tenant ON asset(tenant_id);
