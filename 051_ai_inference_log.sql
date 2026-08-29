-- AI 推理日志（数据管线：/ai/preview 每次推理留痕 → 反馈回流 → 重训闭环）
CREATE TABLE IF NOT EXISTS ai_inference_log (
  id         bigserial PRIMARY KEY,
  tenant_id  text NOT NULL,
  description text NOT NULL,
  category   text NOT NULL DEFAULT '',
  priority   text NOT NULL DEFAULT '',
  confidence integer NOT NULL DEFAULT 0,
  method     text NOT NULL DEFAULT '',
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_inference_tenant ON ai_inference_log (tenant_id, created_at);
