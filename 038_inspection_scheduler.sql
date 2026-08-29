-- 038_inspection_scheduler.sql —— G3 真 cron 调度支撑：跨租户枚举"有到期计划"的租户。
-- 背景：调度器(Node setInterval)需周期性扫描各租户的到期巡检计划并自动生成下一期；
--   但所有业务表 RLS 策略均为 FOR ALL TO youfu_app，连接层 SET ROLE youfu_app 后严格按租户隔离，
--   直接用 youfu_app 连接无法跨租户读取 inspection_plan。
-- 方案：本函数以 SECURITY DEFINER(属主 postgres) 执行，函数体内绕过 RLS，仅【只读】返回
--   "存在未暂停且 next_run_at 已到期计划"的租户列表；Node 调度器据此逐租户复用既有
--   createPlanOccurrence + emitDomainEvent 生成实例并推进 next_run_at（保持 RLS 不变）。
-- 幂等可重复执行（CREATE OR REPLACE）。须以 superuser(postgres) 执行：
--   sudo -u postgres psql -d youfu -f 038_inspection_scheduler.sql

CREATE OR REPLACE FUNCTION inspection_due_plan_tenants()
RETURNS TABLE(tenant_id text) AS $$
BEGIN
  RETURN QUERY
    SELECT DISTINCT p.tenant_id
    FROM inspection_plan p
    WHERE p.paused = false
      AND p.next_run_at IS NOT NULL
      AND p.next_run_at <= now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public;

-- youfu_app 仅被授权 EXECUTE（只读枚举），不直接触碰表，RLS 边界不变。
-- SET search_path = public（R25-003 硬化）：钉死函数内对象解析模式，杜绝 SECURITY DEFINER
--   在 owner 默认 search_path 下被恶意同名对象劫持的提权面（与 046_model_train_scheduler.sql 一致）。
GRANT EXECUTE ON FUNCTION inspection_due_plan_tenants() TO youfu_app;
