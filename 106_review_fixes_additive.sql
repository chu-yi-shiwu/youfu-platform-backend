-- 106_review_fixes_additive.sql —— 053b 中**可安全自动执行**的部分。
--
-- 背景：053b_review_fixes.sql 因文件名不匹配迁移正则，历史上从未被自动执行，
--   导致 templateEffects 使用的 platform_template_apply.refreshed_at 在部分环境缺失。
-- 本迁移只做加法（ADD COLUMN IF NOT EXISTS），可重复执行，不删除任何数据/列。
--
-- 053b 的另一半（DROP open_api_app.app_secret）属破坏性操作，已拆分到
--   pending-migrations/108_drop_open_api_app_secret.sql，需人工审批后单独执行。

ALTER TABLE platform_template_apply ADD COLUMN IF NOT EXISTS refreshed_at timestamptz;
