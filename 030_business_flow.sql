-- 030_business_flow.sql —— P3 横向克隆：通用业务流任务表
-- 所有"业务流型"模块（运送 / 应急 / 循环签到 …）共用一张表，靠 entity_type 区分，
-- 流转内核统一由 workflow_def 引擎驱动（红线：所有业务流必须过 workflow_def，不再硬编码状态机）。
-- 业务流专属字段放 data(jsonb)，结构随 workflow_def 的 catalog 走，零代码扩展。
-- 与既有表一致：uuid 主键 + tenant_id(text) + RLS(TO youfu_app) + GRANT + 索引。
-- 本迁移为 DDL，须以 superuser(postgres) 执行（youfu_app 无 DDL 权）：
--   psql "$DATABASE_URL_POSTGRES" -f 030_business_flow.sql

CREATE TABLE IF NOT EXISTS business_flow_tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  entity_type   text NOT NULL,                 -- transport_task | emergency_plan | cycle_check | ...
  title         text NOT NULL,
  status        text NOT NULL,
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- 业务流专属字段（运送物品/应急级别/签到位置…）
  assignee      text,                         -- 责任人 / 执行人
  location      text,                         -- 位置
  scheduled_at  timestamptz,                  -- 计划时间
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE business_flow_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS business_flow_tasks_tenant_isolation ON business_flow_tasks;
CREATE POLICY business_flow_tasks_tenant_isolation ON business_flow_tasks
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON business_flow_tasks TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_business_flow_tenant_type ON business_flow_tasks (tenant_id, entity_type);
CREATE INDEX IF NOT EXISTS idx_business_flow_tenant_type_status ON business_flow_tasks (tenant_id, entity_type, status);
CREATE INDEX IF NOT EXISTS idx_business_flow_tenant_sched ON business_flow_tasks (tenant_id, entity_type, scheduled_at);
