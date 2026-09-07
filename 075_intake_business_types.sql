-- 075_intake_business_types.sql —— FE Intake 业务类型/目录后端事实源（申报页配置化 第一刀）。
-- 背景：申报页业务类型/目录/技能标签此前写死在前端 templates.ts；本次让后端成为事实源：
--   ① business_type_dict：租户业务类型登记处（纯空表起步，不做数据迁移、不 seed 业务数据——
--      生产库 work_orders.business_type 历史值有 repair/hvac/plumbing 等目录码混入，迁数据反而固化脏值）；
--   ② fault_category 加两列（全部可空，零数据影响）：business_type（目录归属的业务类型码）、
--      skill_tags（目录技能标签，jsonb 数组）。
-- 部署契约：DDL 须 superuser 执行（对齐 033/060 写法）：
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 075_intake_business_types.sql
-- 幂等：IF NOT EXISTS / DROP POLICY IF EXISTS，可重跑。

-- ============ 1. business_type_dict（租户业务类型登记处） ============
CREATE TABLE IF NOT EXISTS business_type_dict (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  text NOT NULL,
  code       text NOT NULL,                 -- 业务类型码（如 repair / transport / escort）
  name       text NOT NULL,                 -- 展示名（维修 / 运送 / 陪检）
  sort       int NOT NULL DEFAULT 0,        -- 展示排序（小在前）
  enabled    boolean NOT NULL DEFAULT true,
  remark     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- tenant 维度查询索引（intake-options 聚合 + /basic-data/business_type 列表均按 tenant 过滤）
CREATE INDEX IF NOT EXISTS ix_business_type_dict_tenant ON business_type_dict(tenant_id);
-- 不建 code 唯一索引：对齐既有 9 类字典的无唯一索引口径（不引入新约束）。

-- RLS：对齐 033 fault_category 的租户表范式（ENABLE + tenant_isolation 策略 + youfu_app 授权）。
ALTER TABLE business_type_dict ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS business_type_dict_tenant_isolation ON business_type_dict;
CREATE POLICY business_type_dict_tenant_isolation ON business_type_dict
  FOR ALL TO youfu_app
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON business_type_dict TO youfu_app;

-- ============ 2. fault_category 扩展（全部可空，零数据影响；该表 RLS/GRANT 已存在，不动） ============
ALTER TABLE fault_category ADD COLUMN IF NOT EXISTS business_type text;
ALTER TABLE fault_category ADD COLUMN IF NOT EXISTS skill_tags jsonb;
