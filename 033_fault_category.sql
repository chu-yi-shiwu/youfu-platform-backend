-- 033 故障类型/问题目录（主数据字典，租户内 code 唯一）。
-- 对齐 UOne 工单「故障类型/问题目录」维度：结构化分类，替代自由文本。
CREATE TABLE IF NOT EXISTS fault_category (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   VARCHAR(64) NOT NULL,
  code        VARCHAR(64) NOT NULL,
  name        VARCHAR(128) NOT NULL,
  sort        INT NOT NULL DEFAULT 0,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

ALTER TABLE fault_category ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fault_category_tenant_isolation ON fault_category;
CREATE POLICY fault_category_tenant_isolation ON fault_category
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON fault_category TO youfu_app;
