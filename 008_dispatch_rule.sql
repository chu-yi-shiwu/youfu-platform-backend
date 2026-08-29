-- 008_dispatch_rule.sql —— 批次 A：可配置自动派单规则
-- 让运营在管理端自助配置"什么条件派给谁 / 用什么策略"，替代硬编码 least_load。
-- 与既有表一致：tenant_id + RLS(TO youfu_app) + GRANT youfu_app 读写。
-- 注意：本迁移为 DDL，须以 superuser(postgres) 执行（youfu_app 无 DDL 权，见 005 注释）。
--   psql "$DATABASE_URL_POSTGRES" -f 008_dispatch_rule.sql

CREATE TABLE IF NOT EXISTS dispatch_rule (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  name          text NOT NULL,                       -- 规则名称（运营可读）
  priority      int  NOT NULL DEFAULT 100,           -- 数值越大越优先（同优先级按创建序）
  match_json    jsonb NOT NULL DEFAULT '{}'::jsonb,  -- 匹配条件：{business_type?,skill_tags?[],priority?}
  strategy_json jsonb NOT NULL DEFAULT '{}'::jsonb,  -- 派单策略：{type:'skill_match'|'load_balance',skill_tags?[]}
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE dispatch_rule ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dispatch_rule_tenant_isolation ON dispatch_rule;
CREATE POLICY dispatch_rule_tenant_isolation ON dispatch_rule
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON dispatch_rule TO youfu_app;

CREATE INDEX IF NOT EXISTS idx_dispatch_rule_tenant_priority
  ON dispatch_rule (tenant_id, enabled, priority DESC);
