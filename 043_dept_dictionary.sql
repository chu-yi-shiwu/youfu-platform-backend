-- 043_dept_dictionary.sql
-- P3a 部门字典：新增 dept 表，供基础数据「部门」Tab 与工单/运送部门下拉使用（替换前端硬编码 A/B/C）。
-- 与 basicData 既有类型（region/contact/supplier）同构：id/tenant_id(name/code/remark)。
-- 部署契约：以数据库属主（ECS 上 postgres）执行。
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 043_dept_dictionary.sql
-- 幂等：全部 IF NOT EXISTS，可安全重跑。

CREATE TABLE IF NOT EXISTS dept (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  name text NOT NULL,
  code text,
  remark text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS：复用租户策略（与 region/contact/supplier 等基础数据表一致，tenant_id 为 text）
ALTER TABLE dept ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dept_tenant_isolation ON dept;
CREATE POLICY dept_tenant_isolation ON dept
  USING (tenant_id = current_setting('app.tenant_id'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id'));
