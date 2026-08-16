-- 019_model_state.sql —— 派单自适应闭环 · 数据底座（A1）
-- 1) dispatch_rule 加 weight/score 学习列（供模型评分与自适应写回）
-- 2) 建 model_state 表（模型参数持久化，租户隔离）
-- 幂等（migrate.ts 按文件名序重复执行全部 NNN_*.sql）；
-- 须以 superuser(postgres) 执行（youfu_app 无 DDL 权，见 005/008 注释）。

-- 1) dispatch_rule 学习列（ADD COLUMN IF NOT EXISTS 幂等）
ALTER TABLE dispatch_rule ADD COLUMN IF NOT EXISTS weight real NOT NULL DEFAULT 1.0;
ALTER TABLE dispatch_rule ADD COLUMN IF NOT EXISTS score  real NOT NULL DEFAULT 0.0;

-- 2) model_state：模型参数（模型即配置参数，存 DB）
CREATE TABLE IF NOT EXISTS model_state (
  id              bigserial PRIMARY KEY,
  tenant_id       text NOT NULL,
  model_key       text NOT NULL,                       -- 如 'dispatch_score'
  version         int  NOT NULL DEFAULT 1,
  params          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- 模型参数（arms/alpha/ucbC）
  metric_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,  -- 最近指标快照
  trained_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, model_key)
);

ALTER TABLE model_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS model_state_tenant_isolation ON model_state;
CREATE POLICY model_state_tenant_isolation ON model_state
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON model_state TO youfu_app;
GRANT USAGE, SELECT ON SEQUENCE model_state_id_seq TO youfu_app;  -- T-A 修复：bigserial 自增需序列 USAGE 权，否则 incrementalLearn INSERT 报 permission denied for sequence

CREATE INDEX IF NOT EXISTS idx_model_state_tenant_key
  ON model_state (tenant_id, model_key);
