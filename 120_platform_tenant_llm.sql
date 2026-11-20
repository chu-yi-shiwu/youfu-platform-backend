-- 120_platform_tenant_llm.sql（2026-11-14 深度探针）
--
-- 问题：平台端 `GET /platform/tenants` 需要展示「LLM 授权」状态，但 `tenant_settings`
--   启用了 RLS（tenant_id = app_tenant_id()），平台查询用应用连接、无租户 GUC
--   ⇒ LEFT JOIN 永远拿不到行 ⇒ 刚授权成功也显示 false（写成功、读永远失败）。
--
-- 修复：平台是受信边界（platform_admin 才能读），用 SECURITY DEFINER 函数只暴露
--   「tenant_id + llm_enabled」这一列聚合，不放开整表，也不复制状态。
--
-- 幂等：重复执行安全。
CREATE OR REPLACE FUNCTION public.platform_tenant_llm()
RETURNS TABLE (tenant_id text, llm_enabled text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ts.tenant_id,
         COALESCE(ts.settings->>'llm_enabled', 'false') AS llm_enabled
  FROM tenant_settings ts;
$$;

REVOKE ALL ON FUNCTION public.platform_tenant_llm() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_tenant_llm() TO youfu_app;
