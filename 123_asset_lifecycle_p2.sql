-- 123_asset_lifecycle_p2.sql（2026-11-17 资产模块 P2/P3）
-- 1) 资产责任人/部门/保修/折旧年限：让台账具备运营归属与财务口径。
-- 2) 维保计划：asset_maintenance.next_due，支持到期提醒。
-- 3) 资产附件：独立表 + 租户 RLS（文件本体走既有 /upload，表只存元数据）。
-- 4) 资产事件时间线查询索引：复用 domain_event 作为唯一事实源，不新建重复事件表。
--
-- 幂等：可重复执行。

ALTER TABLE asset ADD COLUMN IF NOT EXISTS responsible_user text;
ALTER TABLE asset ADD COLUMN IF NOT EXISTS department text;
ALTER TABLE asset ADD COLUMN IF NOT EXISTS warranty_until date;
ALTER TABLE asset ADD COLUMN IF NOT EXISTS warranty_vendor text;
ALTER TABLE asset ADD COLUMN IF NOT EXISTS useful_life_months integer;

ALTER TABLE asset_maintenance ADD COLUMN IF NOT EXISTS next_due date;

CREATE INDEX IF NOT EXISTS idx_asset_tenant_department ON asset (tenant_id, department);
CREATE INDEX IF NOT EXISTS idx_asset_tenant_warranty ON asset (tenant_id, warranty_until);
CREATE INDEX IF NOT EXISTS idx_asset_maintenance_next_due ON asset_maintenance (tenant_id, next_due);

CREATE TABLE IF NOT EXISTS asset_attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  asset_id uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  name text NOT NULL,
  url text NOT NULL,
  content_type text,
  size bigint,
  uploaded_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_asset_attachment_asset ON asset_attachment (tenant_id, asset_id, created_at DESC);

ALTER TABLE asset_attachment ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS asset_attachment_tenant_isolation ON asset_attachment;
CREATE POLICY asset_attachment_tenant_isolation
  ON asset_attachment
  TO youfu_app
  USING ((tenant_id = app_tenant_id()))
  WITH CHECK ((tenant_id = app_tenant_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON asset_attachment TO youfu_app;

CREATE INDEX IF NOT EXISTS idx_domain_event_asset_timeline
  ON domain_event (tenant_id, entity_type, entity_id, created_at DESC);
