-- 066_ai_conversation.sql —— L3 对话管家会话底座（R36，2026-09-01）
-- ───────────────────────────────────────────────────────────────────────────
-- 背景：R34 定稿的智能体阶梯 L3「对话管家」MVP。报修人在 H5 对话流里多轮交互，
--   助手可调用三个只读/受控工具：search_history（K2 语义查本机构相似单）、
--   create_ticket（DMR 种子建单，consent 硬拒）、check_status（单号+尾号查进度）。
-- 设计稿：D:\WorkBuddy\outputs\优服家_智能体兑现三步_R34交付报告_2026-09-01.md §3
-- 防幻觉三件套：工具返回真实数据才允许引用；建议带出处（工单号/相似度）；
--   建单写操作必须过 consent（缺省/false 一律拒绝，与 /public/mp-phone 同口径）。
-- 安全边界：两表均 RLS tenant 隔离（与 060/065 同款策略）；对话内容仅存派生索引
--   （文字），媒体原文件仍走 /public/upload 无损耗随工单流转（铁律不变）。
-- 部署契约：以 postgres 身份执行（与 060 一致）：
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 066_ai_conversation.sql
-- 幂等：CREATE TABLE IF NOT EXISTS + DROP POLICY IF EXISTS。
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_conversation (
  id            uuid PRIMARY KEY,
  tenant_id     text NOT NULL,
  work_order_id text,
  reporter_anon text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_conv_tenant_anon
  ON ai_conversation(tenant_id, reporter_anon, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_conversation_turn (
  id             bigserial PRIMARY KEY,
  tenant_id      text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES ai_conversation(id) ON DELETE CASCADE,
  role           text NOT NULL CHECK (role IN ('user','assistant','tool')),
  content        text NOT NULL DEFAULT '',
  tool_name      text,
  tool_calls     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_turn_conv
  ON ai_conversation_turn(conversation_id, id);

ALTER TABLE ai_conversation ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_conversation_tenant_isolation ON ai_conversation;
CREATE POLICY ai_conversation_tenant_isolation ON ai_conversation
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

ALTER TABLE ai_conversation_turn ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_conversation_turn_tenant_isolation ON ai_conversation_turn;
CREATE POLICY ai_conversation_turn_tenant_isolation ON ai_conversation_turn
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE ON ai_conversation TO youfu_app;
GRANT SELECT, INSERT ON ai_conversation_turn TO youfu_app;
GRANT USAGE ON SEQUENCE ai_conversation_turn_id_seq TO youfu_app;
