-- 053_platform_template.sql —— 批次 E2：模板市场（V2 运营包 / V3 双轮 / V6 标准载体 / V7 官方预置）。
-- 1) platform_template 官方模板库（运营包 playbook：workflow_def + 默认字段 + SLA + 派单规则 + 术语映射 + 报表）
-- 2) platform_template_apply 应用记录（租户应用模板：before/after 版本 + 指标快照 + 效果回写位）
-- 全部 IF NOT EXISTS 幂等；DDL 须 superuser 执行：sudo -u postgres psql -d youfu -f 053_platform_template.sql

-- ============ 1) 官方模板库（平台侧，无 RLS） ============
CREATE TABLE IF NOT EXISTS platform_template (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,                       -- 模板名：如「医院报修标准运营包」
  category      text,                                -- hospital/school/property/municipal/hotel/...
  entity_type   text NOT NULL DEFAULT 'work_order',  -- 适用业务类型
  description   text,
  playbook      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- 运营包：{ workflow_def, default_fields, sla, dispatch, terms, report }
  version       int  NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','archived')),
  rating_score  numeric(4,2) NOT NULL DEFAULT 0,     -- 评分（效果回写重算）
  applied_count int  NOT NULL DEFAULT 0,             -- 应用次数
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_template TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_platform_template_cat ON platform_template (category, status);

-- ============ 2) 模板应用记录 ============
CREATE TABLE IF NOT EXISTS platform_template_apply (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id    uuid NOT NULL REFERENCES platform_template(id),
  tenant_id      text NOT NULL,                      -- 应用到哪个租户
  entity_type    text NOT NULL,
  before_version int,                                -- 应用前 workflow_def 版本
  after_version  int,                                -- 应用后（新版本）
  applied_by     text,
  applied_at     timestamptz NOT NULL DEFAULT now(),
  before_metrics jsonb NOT NULL DEFAULT '{}'::jsonb, -- 应用前指标快照（闭环率/超时）
  after_metrics  jsonb NOT NULL DEFAULT '{}'::jsonb, -- 应用后 7/30 天回写
  effect_rating  numeric(4,2),                       -- 效果评分（回写后重算）
  status         text NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','rolled_back'))
);
GRANT SELECT, INSERT, UPDATE ON platform_template_apply TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_template_apply_tenant ON platform_template_apply (tenant_id, applied_at DESC);
