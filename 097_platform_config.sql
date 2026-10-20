-- 097：平台级配置表（流程配置权限归属开关）
--
-- 【为什么必须平台级，不能复用 system_config】
--   system_config 是**租户级**表（带 tenant_id + RLS 按 app.tenant_id 隔离，见 tenantInfo.ts:2 注释）。
--   把"谁能改流程"这个开关放进去 = 客户自己就能把开关拨回去，等于没锁。
--   本表**故意不带 tenant_id**：平台层配置，只有平台运维（platformAdminAuth）能读写。
--
-- 【为什么不加 RLS】
--   平台层一律用 pool 直连（不经 withTenantClient / 不设 app.tenant_id），
--   与 platform_admin、platform_audit 同款治理：隔离靠"平台端点必须过 platformAdminAuth"，
--   不靠 RLS。若误加租户 RLS，平台侧查询会因 app.tenant_id 未设而全部返回空行（静默失效）。
--
-- 【回滚】DROP TABLE platform_config;（读不到行时代码回退默认值 'platform'，即最严侧）
CREATE TABLE IF NOT EXISTS platform_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);

-- 流程配置权限归属开关：
--   'platform'（默认）= 只平台运维能改流程，租户侧（含 admin、含 role_permission 自行授权）一律 403；
--   'tenant'          = 回到原行为，租户按 workflow.edit / workflow.approve 权限点自治。
-- 缺省方向取最严侧（与 F7 的 AUTH_MODE fail-closed 同款纪律）：查不到行也按 'platform' 处理。
INSERT INTO platform_config (key, value, updated_by)
VALUES ('workflow_config_owner', 'platform', '097_migration')
ON CONFLICT (key) DO NOTHING;
