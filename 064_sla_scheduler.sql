-- 064_sla_scheduler.sql —— SLA 定时扫描的跨租户枚举底座（拆雷三件套②，2026-08-31）
-- ───────────────────────────────────────────────────────────────────────────
-- 背景：/sla/scan 此前只能由登录用户按租户手动触发，超时工单无人扫描就永不被升级。
--   本迁移为进程内 cron（src/scheduler/slaScheduler.ts）提供跨租户枚举能力，
--   模式与 05x 的 inspection_due_plan_tenants() 完全一致：SECURITY DEFINER 绕 RLS，
--   仅返回 tenant_id 列表（不泄漏任何业务数据），逐租户回 withTenantClient 隔离执行。
-- RLS 惯例：应用连接角色 youfu_app 受 RLS 约束，无权跨租户读 work_orders；
--   故枚举必须走 SECURITY DEFINER 函数（属主身份），GRANT 仅授 EXECUTE。
-- 幂等：CREATE OR REPLACE FUNCTION + GRANT 可重复执行。
-- ───────────────────────────────────────────────────────────────────────────

-- 枚举「存在未升级 SLA 工单」的租户：只扫有 sla_due_at 且尚未 escalated_at 的单，
-- 避免空转租户每分钟进一遍扫描事务。
CREATE OR REPLACE FUNCTION sla_escalation_tenants()
RETURNS TABLE (tenant_id text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT tenant_id
  FROM work_orders
  WHERE sla_due_at IS NOT NULL
    AND escalated_at IS NULL
$$;

GRANT EXECUTE ON FUNCTION sla_escalation_tenants() TO youfu_app;
