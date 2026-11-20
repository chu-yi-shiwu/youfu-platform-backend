-- 122_asset_disposed_status.sql（2026-11-17 资产模块 P1）
-- asset_status_check 仍只允许 in_use/repairing/standby/disabled；补 disposed（已处置）。
-- 幂等：先 DROP IF EXISTS 再 ADD。
ALTER TABLE asset DROP CONSTRAINT IF EXISTS asset_status_check;
ALTER TABLE asset
  ADD CONSTRAINT asset_status_check
  CHECK (status = ANY (ARRAY['in_use'::text, 'repairing'::text, 'standby'::text, 'disabled'::text, 'disposed'::text]));
