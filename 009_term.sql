-- 009_term.sql —— 批次 A：术语 / 各院叫法配置
-- 让运营把"工单/报修/师傅"等通用词替换成自己单位的叫法（零代码改名，契合核心诉求）。
-- module：业务模块（global=全局）；code：术语键（如 work_order/report/master）；
-- default_label：系统默认文案；custom_label：自定义文案（NULL=用默认）。
-- 执行：psql "$DATABASE_URL_POSTGRES" -f 009_term.sql

CREATE TABLE IF NOT EXISTS term (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  module        text NOT NULL DEFAULT 'global',     -- 作用模块（global=全局）
  code          text NOT NULL,                       -- 术语键（如 work_order）
  default_label text NOT NULL,                       -- 系统默认文案
  custom_label  text,                                -- 自定义文案（NULL=用默认）
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, module, code)
);

ALTER TABLE term ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS term_tenant_isolation ON term;
CREATE POLICY term_tenant_isolation ON term
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON term TO youfu_app;

CREATE INDEX IF NOT EXISTS idx_term_tenant
  ON term (tenant_id, module, code);
