-- 056_wx_openid_bind.sql
-- 小程序 worker/管理员微信 openid 绑定（P0 登录鉴权底座）
-- 2026-08-23 v5.0 冻结后开发：一次绑定终身免密
-- 幂等：可重复执行；DDL 以 postgres 身份应用（migrate-as-owner 契约）

-- 1) account_user 加 wx_openid（微信 openid 唯一，未绑定时为 NULL）
ALTER TABLE account_user ADD COLUMN IF NOT EXISTS wx_openid text;
CREATE UNIQUE INDEX IF NOT EXISTS ux_account_wx_openid ON account_user(wx_openid) WHERE wx_openid IS NOT NULL;
