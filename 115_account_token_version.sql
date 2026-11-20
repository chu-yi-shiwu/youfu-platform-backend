-- 115_account_token_version.sql —— 账号变更后旧 JWT 即时失效。
--
-- 背景：JWT 是无状态的，改角色/停用账号/改密码后，旧 token 在 TTL 内仍可用；
--   主站把 w_* operator 改成 worker 后，旧 token 仍带旧 role，是明确的越权窗口。
--
-- 方案：
--   1) account_user 增加 token_version（默认 0）；
--   2) 角色 / 启用状态 / 密码哈希变化时，BEFORE UPDATE 触发器自增；
--   3) 新签发 JWT 带 tv；鉴权中间件在 tv 存在时回查并比对，不一致 → 401。
--   旧 token 没有 tv（兼容）→ 不查库、不拦，等 TTL 自然过期。
--
-- 执行：sudo -u postgres psql -d <db> -v ON_ERROR_STOP=1 -f 115_account_token_version.sql

ALTER TABLE account_user ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION bump_account_token_version() RETURNS trigger AS $$
BEGIN
  IF NEW.role IS DISTINCT FROM OLD.role
     OR NEW.active IS DISTINCT FROM OLD.active
     OR NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN
    NEW.token_version := OLD.token_version + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_account_token_version ON account_user;
CREATE TRIGGER trg_account_token_version
  BEFORE UPDATE ON account_user
  FOR EACH ROW EXECUTE FUNCTION bump_account_token_version();

COMMENT ON COLUMN account_user.token_version IS
  'JWT 版本号：角色/启用状态/密码变化时自增，旧 token 失效';
