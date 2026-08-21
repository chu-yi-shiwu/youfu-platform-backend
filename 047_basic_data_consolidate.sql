-- 047_basic_data_consolidate.sql —— 批次 B：基础数据目录归集 + 流程版本历史（S2/S3）。
-- 新增（全部 IF NOT EXISTS 幂等，可重复执行；照 040 模式：RLS + GRANT youfu_app）：
--   1) equipment_type  设备类型（基础数据目录补全）
--   2) equipment_brand 设备厂商
--   3) priority_dict   优先级字典（普通/加急/紧急，带排序与颜色）
--   4) sla_policy      SLA 策略（按业务类型+优先级配置响应/完成时限，驾驶舱超时卡进阶来源）
--   5) work_order_template 工单模板库（只存「默认值/预填」，不定义字段结构 —— 字段真源唯一 = workflow_def.config.fields，S3）
--   6) workflow_def_history 流程定义版本历史（S2 版本回滚的地基：saveWorkflowDef 时把旧版快照写历史）
-- 注：service_desk 已有表与路由（serviceDesk.ts），本批前端归集入口、后端不重复建表。
-- 本迁移为 DDL，须以 superuser(postgres) 执行：sudo -u postgres psql -d youfu -f 047_basic_data_consolidate.sql

-- ============ equipment_type 设备类型 ============
CREATE TABLE IF NOT EXISTS equipment_type (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  text NOT NULL,
  name       text NOT NULL,
  code       text,
  remark     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE equipment_type ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS equipment_type_tenant_isolation ON equipment_type;
CREATE POLICY equipment_type_tenant_isolation ON equipment_type
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON equipment_type TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_equipment_type_tenant ON equipment_type (tenant_id);

-- ============ equipment_brand 设备厂商 ============
CREATE TABLE IF NOT EXISTS equipment_brand (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  text NOT NULL,
  name       text NOT NULL,
  code       text,
  remark     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE equipment_brand ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS equipment_brand_tenant_isolation ON equipment_brand;
CREATE POLICY equipment_brand_tenant_isolation ON equipment_brand
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON equipment_brand TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_equipment_brand_tenant ON equipment_brand (tenant_id);

-- ============ priority_dict 优先级字典 ============
CREATE TABLE IF NOT EXISTS priority_dict (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  text NOT NULL,
  name       text NOT NULL,                 -- 显示名：普通/加急/紧急
  code       text,                          -- 系统编码：normal/urgent/emergency
  sort       int  NOT NULL DEFAULT 0,       -- 排序（小在前）
  color      text,                          -- 展示颜色（如 red/orange）
  remark     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE priority_dict ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS priority_dict_tenant_isolation ON priority_dict;
CREATE POLICY priority_dict_tenant_isolation ON priority_dict
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON priority_dict TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_priority_dict_tenant ON priority_dict (tenant_id);

-- ============ sla_policy SLA 策略 ============
CREATE TABLE IF NOT EXISTS sla_policy (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL,
  name           text NOT NULL,             -- 策略名：如「报修-加急」
  entity_type    text NOT NULL DEFAULT 'work_order',  -- 适用业务类型
  priority       text,                      -- 适用优先级（priority_dict.code；空=全部）
  response_hours numeric NOT NULL DEFAULT 2,  -- 响应时限（小时）
  complete_hours numeric NOT NULL DEFAULT 24, -- 完成时限（小时）
  enabled        boolean NOT NULL DEFAULT true,
  remark         text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sla_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sla_policy_tenant_isolation ON sla_policy;
CREATE POLICY sla_policy_tenant_isolation ON sla_policy
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON sla_policy TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_sla_policy_tenant ON sla_policy (tenant_id);

-- ============ work_order_template 工单模板库 ============
-- 只存「默认值/预填」层（S3）：字段结构定义不在此处，唯一真源 = workflow_def.config.fields。
CREATE TABLE IF NOT EXISTS work_order_template (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL,
  name           text NOT NULL,             -- 模板名：如「设备报修-默认」
  entity_type    text NOT NULL DEFAULT 'work_order',  -- 关联业务类型
  business_type  text,                      -- 业务类型 code（存量兼容）
  description    text,
  default_fields jsonb NOT NULL DEFAULT '{}'::jsonb, -- 默认值/预填：{field_key: 默认值}
  enabled        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE work_order_template ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_order_template_tenant_isolation ON work_order_template;
CREATE POLICY work_order_template_tenant_isolation ON work_order_template
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON work_order_template TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_work_order_template_tenant ON work_order_template (tenant_id);

-- ============ workflow_def_history 流程定义版本历史（S2 回滚地基） ============
CREATE TABLE IF NOT EXISTS workflow_def_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  entity_type text NOT NULL,
  version     int  NOT NULL,                -- 被覆盖前的版本号
  def         jsonb NOT NULL,               -- 该版本完整快照
  operator    text,                         -- 变更人（用户名；未知为 null）
  reason      text,                         -- 变更原因/来源标记（模板应用/回滚/手工保存，G5 来源标记）
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_workflow_def_history UNIQUE (tenant_id, entity_type, version)
);
ALTER TABLE workflow_def_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflow_def_history_tenant_isolation ON workflow_def_history;
CREATE POLICY workflow_def_history_tenant_isolation ON workflow_def_history
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON workflow_def_history TO youfu_app;   -- 历史表 append-only：只读+写入，禁止改删
CREATE INDEX IF NOT EXISTS idx_workflow_def_history_tenant ON workflow_def_history (tenant_id, entity_type);
