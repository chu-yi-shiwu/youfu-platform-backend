-- 124_asset_reminder_dismissal.sql（2026-11-17）
-- 到期提醒的“手动忽略”必须可追溯、租户内持久化，不能只靠前端 localStorage。
-- kind: warranty（ref_id=asset.id）| maintenance（ref_id=asset_maintenance.id）
CREATE TABLE IF NOT EXISTS asset_reminder_dismissal (
  tenant_id text NOT NULL,
  kind text NOT NULL CHECK (kind = ANY (ARRAY['warranty'::text, 'maintenance'::text])),
  ref_id uuid NOT NULL,
  dismissed_by text,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind, ref_id)
);

ALTER TABLE asset_reminder_dismissal ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS asset_reminder_dismissal_tenant_isolation ON asset_reminder_dismissal;
CREATE POLICY asset_reminder_dismissal_tenant_isolation
  ON asset_reminder_dismissal
  TO youfu_app
  USING ((tenant_id = app_tenant_id()))
  WITH CHECK ((tenant_id = app_tenant_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON asset_reminder_dismissal TO youfu_app;

CREATE INDEX IF NOT EXISTS idx_asset_reminder_dismissal_tenant
  ON asset_reminder_dismissal (tenant_id, kind);
