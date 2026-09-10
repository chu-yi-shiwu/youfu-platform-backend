-- 077_invite_codes.sql —— 八件增量 BE-1：邀请码域（admin 生成码 → mp 扫码激活建号）。
-- 设计（架构文档 2026-09-10 §二/§七）：
--   - 码明文绝不落库，仅存 HMAC-SHA256(code, INVITE_SALT)（盐在服务端 env，DB 泄露不可离线爆破）；
--   - 熵：crypto.randomBytes(12) → base32 分组 YF-xxxx-xxxx-xxxx（≥60 bit，72h 时效 + 一次性）；
--   - 重发 = 代码先作废同 (tenant_id, username) 旧码；下方部分唯一索引兜底并发；
--   - 诚实边界：本表【不启用 RLS】——redeem 凭 code_hash 定位租户（查库时租户未知），
--     属平台级跨租户表（与 tenant_registry 同域）；表内无明文码，username/display_name 由
--     服务端鉴权端点独占访问（invite 路由挂 authMiddleware，redeem 仅凭全表 hash 等值命中）。
-- DDL 须以属主(postgres)执行：pssql "$DATABASE_URL_POSTGRES" -f 077_invite_codes.sql；全 IF NOT EXISTS 幂等。

CREATE TABLE IF NOT EXISTS invite_codes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL,
  code_hash    text NOT NULL,              -- HMAC-SHA256(大写规范化 code, INVITE_SALT)，不存明文
  username     text NOT NULL,              -- 预定账号名（激活时在 account_user 建号）
  display_name text,
  role         text NOT NULL DEFAULT 'operator',
  created_by   text,                       -- 生成者（admin username；架构定案 text 口径）
  expires_at   timestamptz NOT NULL,       -- created_at + 72h
  used_at      timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_tenant ON invite_codes (tenant_id, created_at DESC);
-- redeem 按码哈希等值定位（跨租户），哈希索引兜底全表扫
CREATE INDEX IF NOT EXISTS idx_invite_codes_hash ON invite_codes (code_hash);

-- 同账号同时仅 1 个有效码（重发即作废旧码由代码先 UPDATE revoked_at，此部分索引兜底并发）
-- ⚠️ 谓词不可含 expires_at > now()：now() 非 IMMUTABLE，PG 拒建索引（2026-09-11 生产实锤 077:32 ERROR）。
--    过期判定由代码路径兜住：①redeem claim UPDATE 带 expires_at > now() 条件（过期码 claim 落空→INVITE_INVALID）；
--    ②重发先作废同账号全部在途码（含已过期未作废行，invite.ts 重发路径），过期行不会滞留索引。
CREATE UNIQUE INDEX IF NOT EXISTS uq_invite_codes_one_active
  ON invite_codes (tenant_id, username)
  WHERE used_at IS NULL AND revoked_at IS NULL;

-- 运行时角色授权（属主为 postgres，youfu_app 仅运行时读写）
GRANT SELECT, INSERT, UPDATE, DELETE ON invite_codes TO youfu_app;
