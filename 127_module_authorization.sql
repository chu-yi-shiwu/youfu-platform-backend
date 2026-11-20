-- 127_module_authorization.sql —— 租户 / 部门模块授权
--
-- 口径：
--   1) 模块是“管理面能力开关”，不是接口权限点；接口安全仍由 role_permission 负责。
--   2) 默认全开：表里没有行 = 启用，保证存量租户升级后行为不变。
--   3) 部门只能在租户已启用范围内收紧，不能扩展；行里只存覆盖值。
--   4) 移动端个人任务执行 / 志愿参与 / 扫码查询不读取本表，模块关闭不会阻断执行。
--
-- 执行：sudo -u postgres psql -d <db> -v ON_ERROR_STOP=1 -f 127_module_authorization.sql

CREATE TABLE IF NOT EXISTS tenant_module (
  tenant_id   text NOT NULL,
  module_key  text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  PRIMARY KEY (tenant_id, module_key)
);

ALTER TABLE tenant_module ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_module_tenant_isolation ON tenant_module;
CREATE POLICY tenant_module_tenant_isolation ON tenant_module
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_module TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_tenant_module_tenant ON tenant_module (tenant_id);

CREATE TABLE IF NOT EXISTS department_module (
  tenant_id     text NOT NULL,
  department_id uuid NOT NULL,
  module_key    text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  PRIMARY KEY (tenant_id, department_id, module_key)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'department_module_dept_fk'
      AND conrelid = 'department_module'::regclass
  ) THEN
    ALTER TABLE department_module
      ADD CONSTRAINT department_module_dept_fk
      FOREIGN KEY (tenant_id, department_id) REFERENCES dept(tenant_id, id)
      ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE department_module ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS department_module_tenant_isolation ON department_module;
CREATE POLICY department_module_tenant_isolation ON department_module
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON department_module TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_department_module_dept
  ON department_module (tenant_id, department_id);

COMMENT ON TABLE tenant_module IS '租户模块开关：无行=启用；仅存覆盖值';
COMMENT ON TABLE department_module IS '部门模块覆盖：只能在租户已启用范围内收紧；无行=继承租户';
