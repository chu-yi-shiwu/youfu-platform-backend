-- 067_rls_dict_llm_fix.sql —— R13-002 补齐三张含 tenant_id 表缺失的 RLS 隔离（G2 修复）
-- 背景（releaseGate RLS 红区持续 16 日未清零）：
--   1) location_dict / reporter_dict（055_location_reporter_dict.sql）：ENABLE RLS 被注释掉、且无
--      CREATE POLICY → 实际无隔离（含报修人姓名/手机号 PII）。055 注释称「与租户其他表一致」但
--      实现漏配，属实现缺口而非设计取舍。
--   2) llm_call_log（055_llm_call_log.sql）：注释称「审计表不挂租户 RLS（跨租户成本汇总需要）」。
--      但同仓 060 已为兄弟审计表 ai_inference_log 启用 RLS，并明确「任一未来/新增查询若漏写
--      tenant_id，即跨租户泄露」。llm_call_log 含 tenant_id，同样面临该风险；跨租户成本汇总
--      应走 SECURITY DEFINER 函数（postgres 属主绕过 RLS），与平台层 platform_tenant_summary() 同口径，
--      故启用标准 tenant_isolation 策略才是与全库一致的姿态。
-- 修复：三表补齐 ENABLE ROW LEVEL SECURITY + 与 001/060 同款 tenant_isolation 策略。
--   安全影响：
--    - 读取路径（youfu_app 身份，withTenantClient 已设 app.tenant_id）按 tenant 过滤，行为不变；
--    - 写入路径走 SECURITY DEFINER 函数（log_llm_call / upsert_case_embedding 等，属主 postgres
--      绕过 RLS）或显式带 tenant_id 的 INSERT，均不受影响；
--    - 跨租户聚合（成本汇总）须走 SECURITY DEFINER / postgres 上下文，不依赖 youfu_app 空 GUC 直查。
-- 部署契约：以 postgres 身份执行（与 001/060 一致）：
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 067_rls_dict_llm_fix.sql
-- 幂等：ENABLE ROW LEVEL SECURITY 重跑为 no-op；策略 DROP POLICY IF EXISTS 后重建。

-- 1) location_dict
ALTER TABLE location_dict ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS location_dict_tenant_isolation ON location_dict;
CREATE POLICY location_dict_tenant_isolation ON location_dict
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- 2) reporter_dict（含报修人姓名/手机号 PII，隔离尤其重要）
ALTER TABLE reporter_dict ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reporter_dict_tenant_isolation ON reporter_dict;
CREATE POLICY reporter_dict_tenant_isolation ON reporter_dict
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- 3) llm_call_log
ALTER TABLE llm_call_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS llm_call_log_tenant_isolation ON llm_call_log;
CREATE POLICY llm_call_log_tenant_isolation ON llm_call_log
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
