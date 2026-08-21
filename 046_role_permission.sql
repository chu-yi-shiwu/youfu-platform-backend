-- 046_role_permission.sql —— RBAC 权限底座（批次 A2）
-- 1) account_user.role 扩为 4 档（admin/operator/dispatcher/worker）
-- 2) worker 表补 account_id 关联登录身份（消除两套身份体系，S6）
-- 3) role_permission 租户级权限点表（RBAC）
-- 全部幂等，可重复执行；DDL 须以 superuser(postgres) 执行。
-- 用法：
--   PGPASSWORD=youfu2026 psql -U postgres -h 127.0.0.1 -p 5432 -d youfu -f 046_role_permission.sql

-- ============ 1) 角色枚举扩为 4 档 ============
-- 幂等：删除 account_user.role 上已有的 CHECK 约束（无论命名），再加新约束
DO $$
DECLARE con text;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'account_user'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%admin%'
  LOOP
    EXECUTE format('ALTER TABLE account_user DROP CONSTRAINT %I', con);
  END LOOP;
END $$;

ALTER TABLE account_user ADD CONSTRAINT account_user_role_check
  CHECK (role IN ('admin','operator','dispatcher','worker'));

-- ============ 2) worker.account_id 关联登录身份 ============
ALTER TABLE worker ADD COLUMN IF NOT EXISTS account_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_account ON worker (account_id) WHERE account_id IS NOT NULL;

-- ============ 3) role_permission 权限点表（租户级 RBAC） ============
CREATE TABLE IF NOT EXISTS role_permission (
  tenant_id  TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('admin','operator','dispatcher','worker')),
  perm       TEXT NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, role, perm)
);

ALTER TABLE role_permission ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS role_permission_tenant_isolation ON role_permission;
CREATE POLICY role_permission_tenant_isolation ON role_permission
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON role_permission TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_role_permission_tenant ON role_permission (tenant_id);
