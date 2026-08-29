-- 060_rls_tenant_scoped_ai_tables.sql —— R13-001 纵深防御补强
-- 问题：ai_case_embeddings(058) / ai_feedback(050) / ai_inference_log(051) 三张含 tenant_id 的
--       多租户表未启用 RLS（058 注释明确「无显式 RLS，靠应用层过滤」），与全库 60+ 张表的
--       「RLS 是 P1 规避核心隔离机制」声明不一致。当前读取路径均带 tenant_id=$1（已核查），
--       无 active exploit；但任一未来/新增查询若漏写 tenant_id，即跨租户泄露。
-- 修复：为三张表补齐 ENABLE ROW LEVEL SECURITY + 与 001 同款的 tenant_isolation 策略。
--       安全影响：
--         - 读取路径（youfu_app 身份，withTenantClient 已设 app.tenant_id）仍按 tenant 过滤，行为不变；
--         - 写入路径走 SECURITY DEFINER 函数（upsert_case_embedding / log_llm_call 等，属主 postgres
--           绕过 RLS）或显式带 tenant_id 的 INSERT，均不受影响。
-- 部署契约：以 postgres 身份执行（与 001 一致）：
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 060_rls_tenant_scoped_ai_tables.sql
-- 幂等：IF NOT EXISTS / DROP POLICY IF EXISTS。

-- 1) ai_case_embeddings
ALTER TABLE ai_case_embeddings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_case_embeddings_tenant_isolation ON ai_case_embeddings;
CREATE POLICY ai_case_embeddings_tenant_isolation ON ai_case_embeddings
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- 2) ai_feedback
ALTER TABLE ai_feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_feedback_tenant_isolation ON ai_feedback;
CREATE POLICY ai_feedback_tenant_isolation ON ai_feedback
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- 3) ai_inference_log
ALTER TABLE ai_inference_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_inference_log_tenant_isolation ON ai_inference_log;
CREATE POLICY ai_inference_log_tenant_isolation ON ai_inference_log
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
