-- 121_asset_qr_lifecycle.sql（2026-11-17 资产模块 P1）
--
-- 1) 统一资产二维码编码：AST-<asset_no>；回填历史空码/旧 ASSET: 编码。
-- 2) 资产报废/处置字段（不物理删除，保留审计）。
-- 3) 资产号/序列号唯一性约束（当前两库均无重复；导入先逐行校验，避免 500）。
--
-- 幂等：可重复执行。
ALTER TABLE asset ADD COLUMN IF NOT EXISTS disposed_at timestamptz;
ALTER TABLE asset ADD COLUMN IF NOT EXISTS disposed_by text;
ALTER TABLE asset ADD COLUMN IF NOT EXISTS dispose_reason text;
ALTER TABLE asset ADD COLUMN IF NOT EXISTS dispose_method text;
ALTER TABLE asset ADD COLUMN IF NOT EXISTS residual_value numeric;

UPDATE asset
   SET qr_code = 'AST-' || asset_no
 WHERE asset_no IS NOT NULL
   AND asset_no <> ''
   AND (qr_code IS NULL OR qr_code = '' OR qr_code LIKE 'ASSET:%' OR qr_code LIKE 'ASSET-%');

CREATE UNIQUE INDEX IF NOT EXISTS ux_asset_tenant_asset_no
  ON asset (tenant_id, asset_no)
  WHERE asset_no IS NOT NULL AND asset_no <> '';

CREATE UNIQUE INDEX IF NOT EXISTS ux_asset_tenant_sno
  ON asset (tenant_id, sno)
  WHERE sno IS NOT NULL AND sno <> '';
