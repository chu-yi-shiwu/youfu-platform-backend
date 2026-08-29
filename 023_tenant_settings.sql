-- ④ 自动改流程开关：每租户持久化 AUTO_TUNE 开关。
-- 让用户（租户操作员）在界面上自主翻转"系统是否根据数据自动改写流程定义(workflow_def)"，
-- 实时生效 + 落库持久化，替代原先只有运维能改的 MODEL_AUTO_TUNE 环境变量。
-- 幂等：CREATE TABLE IF NOT EXISTS + DROP POLICY IF EXISTS + GRANT；支持 migrate.ts 重复执行。
-- RLS：铁底线，漏配会在 releaseGate 被拦。

CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id  text NOT NULL PRIMARY KEY,
  auto_tune  boolean NOT NULL DEFAULT false,
  settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_settings_tenant_isolation ON tenant_settings;
CREATE POLICY tenant_settings_tenant_isolation ON tenant_settings
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_settings TO youfu_app;

CREATE INDEX IF NOT EXISTS idx_tenant_settings_tenant ON tenant_settings (tenant_id);
