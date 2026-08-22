-- 054_llm_authorize.sql —— 租户级 LLM 授权开关（管理侧控制）
-- 设计（初一定调 2026-08-23）：AI 语义推断的启用权限在平台管理侧，平台授权该租户后，
--   该租户的报修入口才走 LLM 推断（DeepSeek），否则回退本地规则引擎（A 档）。
-- 安全：管理侧跨租户写 settings.llm_enabled → SECURITY DEFINER 函数（bypass RLS 但有明确入参校验）；
--       租户侧只读自己行（RLS 内）。
-- 幂等：CREATE OR REPLACE FUNCTION + GRANT；支持重复执行。

-- 平台侧授权/撤销（跨租户，绕 RLS 但只允许改 settings.llm_enabled，不触碰其他列）
CREATE OR REPLACE FUNCTION llm_authorize(p_tenant_id text, p_enabled boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_exists boolean;
BEGIN
  SELECT EXISTS(SELECT 1 FROM tenant_registry WHERE tenant_id = p_tenant_id) INTO v_exists;
  IF NOT v_exists THEN
    RAISE EXCEPTION 'tenant % not found', p_tenant_id;
  END IF;

  INSERT INTO tenant_settings (tenant_id, settings, updated_at)
  VALUES (p_tenant_id, jsonb_build_object('llm_enabled', p_enabled), now())
  ON CONFLICT (tenant_id)
  DO UPDATE SET
    settings = tenant_settings.settings || jsonb_build_object('llm_enabled', p_enabled),
    updated_at = now();

  RETURN p_enabled;
END;
$$;

GRANT EXECUTE ON FUNCTION llm_authorize(text, boolean) TO youfu_app;
