-- 098_label_dict_tenant.sql —— 展示标签「租户覆盖」表（解跨维度冲突 #1）。
--
-- 【为什么要这张表】
--   073 建的 label_dict 是**平台级**字典（无 tenant_id、GRANT SELECT、注释明写"杜绝租户篡改全局标签"），
--   而流程状态名是**租户可自定义**的（workflow_def）。两者正面冲突：
--     ① 租户自定义一个状态（如 rated），平台字典里没有 ⇒ 界面显示裸 key；
--     ② 两个租户用了同一个 key 却要不同中文名 ⇒ 平台字典（scope+key 唯一）根本表达不了。
--   本表提供「租户覆盖层」：平台字典 ∪ 本租户覆盖，覆盖优先。平台字典本身一字不动（零回归）。
--
-- 【为什么不动 label_dict 加 tenant_id】
--   /meta/labels 是**免鉴权**端点（FE/mp 启动就拉，未登录页也要渲染，见 meta.ts:3 注释）。
--   给它加租户维度就得先加鉴权 ⇒ 前端启动即崩。所以另开鉴权端点 /meta/labels/me，
--   本表走 RLS 隔离（与 080 的 workflow_def_change 同款策略写法）。
--
-- 【回滚】DROP TABLE label_dict_tenant;（端点读不到覆盖行时退化为纯平台字典 = 改动前行为）
-- 幂等可重跑（IF NOT EXISTS / DROP POLICY IF EXISTS）；DDL 须 superuser 执行：
--   sudo -u postgres psql -d youfu -f 098_label_dict_tenant.sql

CREATE TABLE IF NOT EXISTS label_dict_tenant (
  id         serial PRIMARY KEY,
  tenant_id  text NOT NULL,
  scope      text NOT NULL,                 -- 与平台字典同域：wo_status / source / business_type / priority
  key        text NOT NULL,                 -- 枚举值（含租户自定义状态名）
  label      text NOT NULL,                 -- 本租户的中文展示名（覆盖平台字典）
  sort       int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_label_dict_tenant_tsk
  ON label_dict_tenant (tenant_id, scope, key);
CREATE INDEX IF NOT EXISTS idx_label_dict_tenant_lookup
  ON label_dict_tenant (tenant_id, scope, sort);

ALTER TABLE label_dict_tenant ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS label_dict_tenant_tenant_isolation ON label_dict_tenant;
CREATE POLICY label_dict_tenant_tenant_isolation ON label_dict_tenant
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON label_dict_tenant TO youfu_app;
GRANT USAGE, SELECT ON SEQUENCE label_dict_tenant_id_seq TO youfu_app;
