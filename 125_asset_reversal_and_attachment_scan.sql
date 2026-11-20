-- 125_asset_reversal_and_attachment_scan.sql（2026-11-20）
-- 1) 提醒忽略可恢复：保留忽略历史，不物理删除。
-- 2) 处置撤销：审批表 + 资产撤销留痕（不直接改 disposed 终态为可编辑）。
-- 3) 附件扫描状态：可插拔 AV 引擎的结果留痕；未配置引擎时明确 unscanned。
-- 4) 附件 URL 索引：下载链路可按 URL 拦截 infected 附件。
--
-- 幂等：可重复执行。

ALTER TABLE asset_reminder_dismissal ADD COLUMN IF NOT EXISTS restored_at timestamptz;
ALTER TABLE asset_reminder_dismissal ADD COLUMN IF NOT EXISTS restored_by text;

ALTER TABLE asset ADD COLUMN IF NOT EXISTS disposal_reversed_at timestamptz;
ALTER TABLE asset ADD COLUMN IF NOT EXISTS disposal_reversed_by text;
ALTER TABLE asset ADD COLUMN IF NOT EXISTS disposal_reversal_reason text;

ALTER TABLE asset_attachment ADD COLUMN IF NOT EXISTS scan_status text NOT NULL DEFAULT 'unscanned';
ALTER TABLE asset_attachment ADD COLUMN IF NOT EXISTS scan_engine text;
ALTER TABLE asset_attachment ADD COLUMN IF NOT EXISTS scan_detail text;
ALTER TABLE asset_attachment ADD COLUMN IF NOT EXISTS scanned_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'asset_attachment_scan_status_check'
  ) THEN
    ALTER TABLE asset_attachment
      ADD CONSTRAINT asset_attachment_scan_status_check
      CHECK (scan_status = ANY (ARRAY['unscanned'::text, 'clean'::text, 'infected'::text, 'error'::text]));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_asset_attachment_url
  ON asset_attachment (tenant_id, url);

CREATE TABLE IF NOT EXISTS asset_disposal_reversal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  asset_id uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  reason text NOT NULL,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by text,
  decided_at timestamptz,
  decision_note text
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'asset_disposal_reversal_status_check'
  ) THEN
    ALTER TABLE asset_disposal_reversal
      ADD CONSTRAINT asset_disposal_reversal_status_check
      CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]));
  END IF;
END $$;

-- 兼容已存在的旧表（CREATE TABLE IF NOT EXISTS 不会补列）
ALTER TABLE asset_disposal_reversal ADD COLUMN IF NOT EXISTS requested_by_id text;
ALTER TABLE asset_disposal_reversal ADD COLUMN IF NOT EXISTS decided_by_id text;

CREATE UNIQUE INDEX IF NOT EXISTS ux_asset_disposal_reversal_pending
  ON asset_disposal_reversal (tenant_id, asset_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_asset_disposal_reversal_tenant_status
  ON asset_disposal_reversal (tenant_id, status, requested_at DESC);

ALTER TABLE asset_disposal_reversal ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS asset_disposal_reversal_tenant_isolation ON asset_disposal_reversal;
CREATE POLICY asset_disposal_reversal_tenant_isolation
  ON asset_disposal_reversal
  TO youfu_app
  USING ((tenant_id = app_tenant_id()))
  WITH CHECK ((tenant_id = app_tenant_id()));

GRANT SELECT, INSERT, UPDATE, DELETE ON asset_disposal_reversal TO youfu_app;
