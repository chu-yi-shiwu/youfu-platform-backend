-- ============================================================
-- 2026-10-19 生产补登记：t-probe-9292ka3 / t-probe-9294p8k
-- ------------------------------------------------------------
-- 背景（全部有审计/实测证据）：
--   2026-09-05 12:06 / 12:08 平台账号 pa_probe_929 走 POST /platform/tenants
--   正常开通这两个租户（platform_audit 有 tenant.create 记录，category=other，
--   categories_copied=91，admin_username=admin）。
--   随后 tenant_registry 登记行被直接删除（代码无删租户能力 → 人工数据库手术；
--   同日更早的 9 个 t-probe-* 及 09-11 的 t-probe-r4a 已被清干净，各表 0 行，
--   这 2 个是清理漏尾：账号/分类/流程还在，登记行没了）。
--   现状（补登记前实测）：
--     account_user=2 行（各 1 个 active admin）/ fault_category=182 行 /
--     workflow_def=2 行 / tenant_registry=0 行
--     → 登录走 fail-open 旁路（auth.ts:59：registry 查不到行就跳过状态检查），
--       平台侧统计/封禁都看不见这 2 个租户（账实不符）。
--
-- 动作：按 POST /platform/tenants 同口径补回登记行（platform.ts:161-163），
--   不改、不删任何现有数据；INSERT 带 WHERE NOT EXISTS 守卫，可重复执行。
--   name 用 tenant_id 代替：audit payload 不记录 name（开通时传的值不可考），
--   不编造名称，并在 audit payload 里注明。
--
-- 回滚（如需）：
--   DELETE FROM tenant_registry WHERE tenant_id IN ('t-probe-9292ka3','t-probe-9294p8k');
--   DELETE FROM platform_audit WHERE action = 'tenant.registry_repair';
-- ============================================================

BEGIN;

INSERT INTO tenant_registry (tenant_id, name, category, parent_id, quota, status, created_at, updated_at)
SELECT 't-probe-9292ka3', 't-probe-9292ka3', 'other', NULL, '{"repair_daily": 500}'::jsonb, 'active',
       '2026-09-05 12:06:47.718636+08'::timestamptz, now()
WHERE NOT EXISTS (SELECT 1 FROM tenant_registry WHERE tenant_id = 't-probe-9292ka3');

INSERT INTO tenant_registry (tenant_id, name, category, parent_id, quota, status, created_at, updated_at)
SELECT 't-probe-9294p8k', 't-probe-9294p8k', 'other', NULL, '{"repair_daily": 500}'::jsonb, 'active',
       '2026-09-05 12:08:27.44244+08'::timestamptz, now()
WHERE NOT EXISTS (SELECT 1 FROM tenant_registry WHERE tenant_id = 't-probe-9294p8k');

-- 留痕：这次补登记本身也进审计表，与开通审计区分
INSERT INTO platform_audit (actor, action, resource, target_tenant, payload, at) VALUES
('platform_admin', 'tenant.registry_repair', 'tenant_registry', 't-probe-9292ka3',
 '{"reason": "registry 登记行缺失：账实不符 + 登录 fail-open 旁路（auth.ts:59）；按 2026-09-05 tenant.create 审计补登记", "source_audit_at": "2026-09-05T12:06:47.718636+08:00", "category": "other", "original_name": "unrecoverable（audit payload 不含 name，以 tenant_id 记）", "restored_by": "ops-2026-10-19", "note": "未删改任何现有数据"}'::jsonb, now()),
('platform_admin', 'tenant.registry_repair', 'tenant_registry', 't-probe-9294p8k',
 '{"reason": "registry 登记行缺失：账实不符 + 登录 fail-open 旁路（auth.ts:59）；按 2026-09-05 tenant.create 审计补登记", "source_audit_at": "2026-09-05T12:08:27.44244+08:00", "category": "other", "original_name": "unrecoverable（audit payload 不含 name，以 tenant_id 记）", "restored_by": "ops-2026-10-19", "note": "未删改任何现有数据"}'::jsonb, now());

COMMIT;
