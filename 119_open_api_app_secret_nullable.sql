-- 119_open_api_app_secret_nullable.sql（2026-11-14 深度探针，2026-11-15 兼容性修订）
--
-- 问题：`open_api_app.app_secret` 在 052 建表时为 NOT NULL，但 053b/#4 之后
--   `POST /platform/apps` 只写 `secret_hash`（明文密钥仅在创建响应里返回一次，不落库）。
--   于是「创建开放应用」必然触发 23502 → 400「缺少必填字段（app_secret）」，功能整体不可用。
--
-- 修复边界：只解除 NOT NULL，不删列。彻底删列仍按 pending-migrations/108
--   的人工流程执行（保留备份窗口）；本迁移保证任何环境在删列前也能正常创建应用。
--
-- 兼容性（2026-11-15 主站同步实测）：部分环境已人工执行 108，`app_secret` 列已不存在；
--   此时 ALTER COLUMN 会报 undefined_column。改为先判列存在，不存在则跳过（幂等）。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'open_api_app'
      AND column_name = 'app_secret'
  ) THEN
    ALTER TABLE open_api_app ALTER COLUMN app_secret DROP NOT NULL;
    COMMENT ON COLUMN open_api_app.app_secret IS
      'DEPRECATED（2026-11-14）：明文密钥不再落库，仅 secret_hash；本列保留兼容，待 108 人工删除。';
  ELSE
    RAISE NOTICE '119: open_api_app.app_secret 已不存在（108 已人工执行），跳过';
  END IF;
END $$;
