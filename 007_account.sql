-- 007_account.sql —— 生产化④「自建账号」账户表（账户/登录体系）。
-- 与既有表一致：多租户隔离（app_tenant_id + RLS）、DDL 必须用 superuser(postgres) 执行
-- （youfu_app 无 DDL 权）。演示账户由 scripts/seed-accounts.ts 注入（运行时角色 youfu_app）。
-- 执行： psql "$DATABASE_URL_POSTGRES" -f 007_account.sql

-- 1) 账户表：租户内用户名唯一，密码用 scrypt 派生哈希（格式 scrypt$<saltHex>$<hashHex>）
CREATE TABLE IF NOT EXISTS account_user (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL,
  username       text NOT NULL,
  password_hash  text NOT NULL,                       -- 绝不存明文
  display_name   text,
  role           text NOT NULL DEFAULT 'operator'
                 CHECK (role IN ('admin', 'operator')),
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, username)
);

-- 2) RLS：与既有表一致，按租户隔离（TO youfu_app，连接层 SET ROLE youfu_app 后生效）
ALTER TABLE account_user ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_user_tenant_isolation ON account_user;
CREATE POLICY account_user_tenant_isolation ON account_user
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- 3) 业务角色授权（属主为 postgres，youfu_app 仅运行时读写）
GRANT SELECT, INSERT, UPDATE, DELETE ON account_user TO youfu_app;

-- 4) 索引：登录按租户+用户名定位；列表按租户过滤
CREATE INDEX IF NOT EXISTS idx_account_user_tenant_username
  ON account_user (tenant_id, username);
CREATE INDEX IF NOT EXISTS idx_account_user_tenant
  ON account_user (tenant_id);
