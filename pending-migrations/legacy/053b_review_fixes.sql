-- 053b_review_fixes.sql —— 代码审查修复补丁（#3/#4）：
--   #3: platform_template_apply 加 refreshed_at（7/30 天两次观测：7 天首刷、30 天复刷）
--   #4: DROP open_api_app.app_secret 明文列（只留 secret_hash，删泄密面）
-- 幂等；须 superuser 执行：sudo -u postgres psql -d youfu -f 053b_review_fixes.sql

ALTER TABLE platform_template_apply ADD COLUMN IF NOT EXISTS refreshed_at timestamptz;

ALTER TABLE open_api_app DROP COLUMN IF EXISTS app_secret;
