-- T-C / C1 自适应优化层：优化决策审计与建议表。
-- 横切优化带 3c 优化层的落库载体：
--   - dispatch 范围：模型权重写回 dispatch_rule.weight 的审计记录（飞轮可见、可回溯）。
--   - workflow 范围：依据过程度量产出的流程调优建议，状态 pending 待 T-① workflow_def 引擎消费应用。
-- 幂等：CREATE TABLE IF NOT EXISTS + DROP POLICY IF EXISTS + GRANT；支持 migrate.ts 重复执行。
CREATE TABLE IF NOT EXISTS optimization_feedback (
  id             bigserial PRIMARY KEY,
  tenant_id      text NOT NULL,
  scope          text NOT NULL CHECK (scope IN ('dispatch', 'workflow')),
  target         text NOT NULL,
  recommendation jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason         text,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  applied_at     timestamptz
);

ALTER TABLE optimization_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS optimization_feedback_tenant_isolation ON optimization_feedback;
CREATE POLICY optimization_feedback_tenant_isolation ON optimization_feedback
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON optimization_feedback TO youfu_app;
GRANT USAGE, SELECT ON SEQUENCE optimization_feedback_id_seq TO youfu_app;

CREATE INDEX IF NOT EXISTS idx_optfb_tenant_scope ON optimization_feedback (tenant_id, scope, status);
CREATE INDEX IF NOT EXISTS idx_optfb_tenant_created ON optimization_feedback (tenant_id, created_at);
