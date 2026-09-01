-- 065_ai_shadow_suggestions.sql —— K2 影子模式底座（智能体兑现三步②，2026-09-01）
-- ───────────────────────────────────────────────────────────────────────────
-- 背景：K2 向量管道已建（建单即嵌入，058），但分类/派单主链路不消费——
--   「语义辅助分类/派单」的承诺未兑现。MODEL_AUTO_TUNE=false 期间，影子模式
--   让 K2 以**只读建议**运行：建单时用同一向量检索相似历史单 →
--   category / assignee 多数票落影子表；派单发生时回填 actual。
-- 目的：积累「K2 建议 vs 人工实际」配对数据，量化评估 AUTO_TUNE 开启条件
--   （DMR 铁律：先数据后模型，不在无数据时开自动调参）。
-- 安全边界：影子表绝不参与业务决策（不回写工单字段、不改变流转），
--   应用侧所有影子调用均为 best-effort，失败仅告警不影响主链路。
-- 幂等：CREATE TABLE IF NOT EXISTS + IF NOT EXISTS 索引，可重复执行。
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_shadow_suggestions (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL,
  work_order_id text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('category','dispatch')),
  suggested    text NOT NULL DEFAULT '',
  suggested_by text NOT NULL DEFAULT 'k2',
  actual       text,
  matched      boolean,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_shadow_wo
  ON ai_shadow_suggestions(tenant_id, work_order_id);
CREATE INDEX IF NOT EXISTS idx_shadow_eval
  ON ai_shadow_suggestions(tenant_id, kind, resolved_at)
  WHERE resolved_at IS NOT NULL;

ALTER TABLE ai_shadow_suggestions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_shadow_suggestions_tenant_isolation ON ai_shadow_suggestions;
CREATE POLICY ai_shadow_suggestions_tenant_isolation ON ai_shadow_suggestions
  TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE ON ai_shadow_suggestions TO youfu_app;
GRANT USAGE ON SEQUENCE ai_shadow_suggestions_id_seq TO youfu_app;
