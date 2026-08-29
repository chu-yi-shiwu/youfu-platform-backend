-- 数据飞轮断链 2 修复：全量训练租户枚举（SECURITY DEFINER 绕过 RLS 只读枚举）
-- 返回「存在工单数据」的租户（无数据不空训）；供每日 03:00 modelTrainScheduler 逐租户重训。
CREATE OR REPLACE FUNCTION model_train_tenants()
RETURNS TABLE (tenant_id text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT tenant_id
  FROM work_orders
  WHERE status IN ('completed', 'closed', 'evaluated')
  ORDER BY tenant_id;
$$;
