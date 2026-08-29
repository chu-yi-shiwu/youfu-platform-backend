-- AI 反馈闭环（采纳/忽略/处理 真实落库——治本修复"纯 Toast 假动作"）
CREATE TABLE IF NOT EXISTS ai_feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  action      text NOT NULL CHECK (action IN ('adopt','ignore','resolve')),
  target_type text NOT NULL DEFAULT 'suggestion',
  target_id   text NOT NULL DEFAULT '',
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_feedback_tenant ON ai_feedback (tenant_id, created_at);
