-- 055_llm_call_log.sql —— K1 LLM 网关调用审计 + 成本统计
-- 与 051_ai_inference_log（报修推理结果留痕）互补：本表记录「每一次 LLM 网关调用」的
--   provider / model / task / tokens / cost_usd / latency，支撑 K1「调用可审计 + 成本统计」。
-- RLS：审计表不挂租户 RLS（跨租户成本汇总需要），插入走 SECURITY DEFINER 函数绕 RLS。
-- 幂等：CREATE OR REPLACE FUNCTION + IF NOT EXISTS；可重复执行。

CREATE TABLE IF NOT EXISTS llm_call_log (
  id                bigserial PRIMARY KEY,
  tenant_id         text NOT NULL DEFAULT 'system',
  provider          text NOT NULL,
  model             text NOT NULL,
  task              text NOT NULL DEFAULT 'unknown',
  prompt_tokens     integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  cost_usd          numeric(12,8) NOT NULL DEFAULT 0,
  latency_ms        integer NOT NULL DEFAULT 0,
  ok                boolean NOT NULL DEFAULT true,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_llm_call_log_tenant ON llm_call_log (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_call_log_created ON llm_call_log (created_at);

-- 写入审计（SECURITY DEFINER 绕 RLS，仅插本表）
CREATE OR REPLACE FUNCTION log_llm_call(
  p_tenant_id text, p_provider text, p_model text, p_task text,
  p_prompt_tokens integer, p_completion_tokens integer, p_cost_usd numeric,
  p_latency_ms integer, p_ok boolean, p_error text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO llm_call_log (tenant_id, provider, model, task, prompt_tokens, completion_tokens, cost_usd, latency_ms, ok, error)
  VALUES (
    COALESCE(p_tenant_id, 'system'), p_provider, p_model, p_task,
    COALESCE(p_prompt_tokens, 0), COALESCE(p_completion_tokens, 0), COALESCE(p_cost_usd, 0),
    COALESCE(p_latency_ms, 0), COALESCE(p_ok, true), p_error
  );
END;
$$;
GRANT EXECUTE ON FUNCTION log_llm_call(text, text, text, text, integer, integer, numeric, integer, boolean, text) TO youfu_app;
