-- 结构性幂等守卫（支柱④⑤ 自我优化飞轮·不重复学习 DB 级兜底）
-- 与 transition() 行锁 + shouldTriggerLearning（过程式判定）形成双重保险：
-- 即便未来上"事件驱动 at-least-once 重放"或任何绕过 transition() 的路径，
-- 同一 (tenant_id, work_order_id, trigger_state) 也只允许学习一次。
-- 幂等：CREATE TABLE IF NOT EXISTS + DROP POLICY IF EXISTS + GRANT；支持 migrate.ts 重复执行。

CREATE TABLE IF NOT EXISTS ticket_learn_log (
  id            bigserial PRIMARY KEY,
  tenant_id     text NOT NULL,
  work_order_id text NOT NULL,
  trigger_state text NOT NULL,            -- 触发增量学习的"目标态"（learningTriggers 命中态）
  model_version int,                      -- 当时模型版本，便于审计/排查
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, work_order_id, trigger_state)
);

ALTER TABLE ticket_learn_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ticket_learn_log_tenant_isolation ON ticket_learn_log;
CREATE POLICY ticket_learn_log_tenant_isolation ON ticket_learn_log
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT ON ticket_learn_log TO youfu_app;
GRANT USAGE, SELECT ON SEQUENCE ticket_learn_log_id_seq TO youfu_app;

CREATE INDEX IF NOT EXISTS idx_ticket_learn_log_wo ON ticket_learn_log (tenant_id, work_order_id);
