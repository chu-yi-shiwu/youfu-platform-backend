-- 111_department_model.sql —— 部门（二级机构）成为派单/归属的一等模型。
--
-- 目标：
--   1) dept 增加 is_default（每租户唯一默认部门，识别不到时兜底）；
--   2) 新增 department_route_rule（自动识别责任部门，避免运营逐单选）；
--   3) work_orders/worker 增加 department_id（复合外键，防跨租户悬空）；
--   4) 存量行回填默认部门；department_id 先 nullable，待新后端稳定后再由 112 收紧 NOT NULL；
--   5) 保留旧 work_orders.department / service_desk 列到 112 再删，避免主站旧进程先炸。
--
-- 执行：sudo -u postgres psql -d <db> -v ON_ERROR_STOP=1 -f 111_department_model.sql

-- ============ dept：默认部门 + 复合唯一键 ============
ALTER TABLE dept ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dept_tenant_id_uq' AND conrelid = 'dept'::regclass
  ) THEN
    ALTER TABLE dept ADD CONSTRAINT dept_tenant_id_uq UNIQUE (tenant_id, id);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS dept_one_default_per_tenant
  ON dept(tenant_id) WHERE is_default;

-- 每个已有部门的租户：把最早的一条设为默认（没有默认时）
UPDATE dept d
SET is_default = true
WHERE d.id = (
  SELECT d2.id FROM dept d2
  WHERE d2.tenant_id = d.tenant_id
  ORDER BY d2.created_at ASC, d2.id ASC
  LIMIT 1
)
AND NOT EXISTS (
  SELECT 1 FROM dept d3
  WHERE d3.tenant_id = d.tenant_id AND d3.is_default = true
);

-- 有人员/工单但完全没有部门的租户：补一个“调度中心”默认部门
INSERT INTO dept (tenant_id, name, code, is_default)
SELECT DISTINCT t.tenant_id, '调度中心', 'DEFAULT', true
FROM (
  SELECT tenant_id FROM worker
  UNION
  SELECT tenant_id FROM work_orders
) t
WHERE NOT EXISTS (SELECT 1 FROM dept d WHERE d.tenant_id = t.tenant_id)
ON CONFLICT DO NOTHING;

-- ============ department_route_rule ============
CREATE TABLE IF NOT EXISTS department_route_rule (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  name          text NOT NULL,
  priority      int  NOT NULL DEFAULT 100,
  enabled       boolean NOT NULL DEFAULT true,
  match_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
  department_id uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE department_route_rule ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS department_route_rule_tenant_isolation ON department_route_rule;
CREATE POLICY department_route_rule_tenant_isolation ON department_route_rule
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON department_route_rule TO youfu_app;

CREATE INDEX IF NOT EXISTS idx_dept_route_rule_tenant_priority
  ON department_route_rule (tenant_id, enabled, priority DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'department_route_rule_dept_fk'
      AND conrelid = 'department_route_rule'::regclass
  ) THEN
    ALTER TABLE department_route_rule
      ADD CONSTRAINT department_route_rule_dept_fk
      FOREIGN KEY (tenant_id, department_id) REFERENCES dept(tenant_id, id)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- ============ worker.department_id ============
ALTER TABLE worker ADD COLUMN IF NOT EXISTS department_id uuid;
CREATE INDEX IF NOT EXISTS idx_worker_tenant_department ON worker(tenant_id, department_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'worker_department_fk' AND conrelid = 'worker'::regclass
  ) THEN
    ALTER TABLE worker
      ADD CONSTRAINT worker_department_fk
      FOREIGN KEY (tenant_id, department_id) REFERENCES dept(tenant_id, id)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- 存量人员先归默认部门（可空=机动；这里只给已有部门且未指定的）
UPDATE worker w
SET department_id = d.id
FROM dept d
WHERE w.department_id IS NULL
  AND d.tenant_id = w.tenant_id
  AND d.is_default = true;

-- ============ work_orders.department_id ============
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS department_id uuid;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS department_source text;
CREATE INDEX IF NOT EXISTS idx_wo_tenant_department ON work_orders(tenant_id, department_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'work_orders_department_fk' AND conrelid = 'work_orders'::regclass
  ) THEN
    ALTER TABLE work_orders
      ADD CONSTRAINT work_orders_department_fk
      FOREIGN KEY (tenant_id, department_id) REFERENCES dept(tenant_id, id)
      ON DELETE RESTRICT;
  END IF;
END $$;

-- 旧 department text 里如果就是 dept.id，先安全回填
UPDATE work_orders wo
SET department_id = CASE
      WHEN wo.department ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN wo.department::uuid ELSE NULL END,
    department_source = COALESCE(wo.department_source, 'legacy')
WHERE wo.department_id IS NULL
  AND CASE
      WHEN wo.department ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN wo.department::uuid ELSE NULL END IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM dept d
    WHERE d.id = CASE
      WHEN wo.department ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN wo.department::uuid ELSE NULL END
      AND d.tenant_id = wo.tenant_id
  );

-- 其余存量行落默认部门（历史数据可删；这里保证 112 收紧 NOT NULL 前没有空值）
UPDATE work_orders wo
SET department_id = d.id,
    department_source = COALESCE(wo.department_source, 'default')
FROM dept d
WHERE wo.department_id IS NULL
  AND d.tenant_id = wo.tenant_id
  AND d.is_default = true;

COMMENT ON COLUMN dept.is_default IS '每租户唯一默认部门：自动识别不到时兜底';
COMMENT ON COLUMN department_route_rule.match_json IS
  '匹配条件：business_type/catalog_id/catalog_code/catalog_name_contains/location_id/location_name_contains/asset_id/asset_code/reporter_id/source/description_contains';
COMMENT ON COLUMN work_orders.department_id IS '责任部门（部门模型）；110 起 RLS 仍只按租户 + 本人过滤';
COMMENT ON COLUMN work_orders.department_source IS 'explicit/rule:<name>/manual/default/assignee';
COMMENT ON COLUMN worker.department_id IS '所属部门；空=机动/共享人员';
