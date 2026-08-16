-- T-① 可配置状态机（横切优化带 · 设计支柱②：单引擎 + 每业务流状态图存 DB 零代码配）
-- 1) workflow_def：每业务流状态图定义（状态机引擎的零代码配置载体）。
-- 2) 放宽 work_orders.status 的枚举 CHECK：状态合法性改由 workflow_def 应用层校验，
--    允许运行期动态增状态（如 recheck / escalated），契合"流程零代码配置"。
-- 幂等：CREATE TABLE IF NOT EXISTS + DROP POLICY IF EXISTS + GRANT；支持 migrate.ts 重复执行。

CREATE TABLE IF NOT EXISTS workflow_def (
  id          bigserial PRIMARY KEY,
  tenant_id   text NOT NULL,
  entity_type text NOT NULL,
  def         jsonb NOT NULL DEFAULT '{}'::jsonb,
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity_type)
);

ALTER TABLE workflow_def ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflow_def_tenant_isolation ON workflow_def;
CREATE POLICY workflow_def_tenant_isolation ON workflow_def
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_def TO youfu_app;
GRANT USAGE, SELECT ON SEQUENCE workflow_def_id_seq TO youfu_app;

CREATE INDEX IF NOT EXISTS idx_wfdef_tenant_entity ON workflow_def (tenant_id, entity_type);

-- 放宽 work_orders.status 枚举 CHECK：去掉固定枚举，仅保留 text NOT NULL DEFAULT 'draft'。
-- 动态状态合法性由应用层 workflow_def 校验（零代码配置），不再写死在 DDL。
-- 仅删除 work_orders 上的 CHECK 约束（该表仅 status 一处 CHECK）。
DO $$
DECLARE
  cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
   WHERE conrelid = 'work_orders'::regclass AND contype = 'c' LIMIT 1;
  IF cname IS NOT NULL THEN
    EXECUTE 'ALTER TABLE work_orders DROP CONSTRAINT ' || quote_ident(cname);
  END IF;
END $$;
