-- 128 工作台统计：四类任务查询索引 + 能耗完成时间防脏
--
-- 背景：
--   工作台 /open/me/summary 每次打开都按 worker 查四张表。
--   现有索引覆盖 work_orders(tenant_id, assignee_id) 与 transport_order(tenant_id, carrier)，
--   但 inspection_task 没有 assignee 索引，business_flow_tasks 也没有 worker_ref 索引。
--   数据量小时是顺序扫描，量上来后会拖慢首屏。
--
--   能耗 data.submitted_at 来自外部平台。应用层已校验新写入，但历史/直接写库的非法值
--   一旦参与 (data->>'submitted_at')::timestamptz，会让整个 summary 500。
--   这里加一个安全转换函数，清洗历史脏值，并用 CHECK 约束阻止新的非法值。

-- ---------------------------------------------------------------------------
-- 1) 索引
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_inspection_task_tenant_assignee_status
  ON inspection_task (tenant_id, assignee, status);

CREATE INDEX IF NOT EXISTS idx_business_flow_tenant_type_assignee
  ON business_flow_tasks (tenant_id, entity_type, assignee);

CREATE INDEX IF NOT EXISTS idx_business_flow_energy_worker_ref
  ON business_flow_tasks (tenant_id, (data->>'worker_ref'))
  WHERE entity_type = 'energy_collection';

-- ---------------------------------------------------------------------------
-- 2) 安全时间转换：非法输入返回 NULL，不抛异常
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.youfu_safe_timestamptz(value text)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
BEGIN
  RETURN value::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3) 历史能耗完成时间清洗
--    终态任务缺失/非法 submitted_at 时，冻结到 updated_at。
--    这只做一次，避免 reviewed/archived 后续再改 updated_at 时继续漂移。
-- ---------------------------------------------------------------------------
UPDATE business_flow_tasks
SET data = jsonb_set(data, '{submitted_at}', to_jsonb(updated_at), true)
WHERE entity_type = 'energy_collection'
  AND status IN ('submitted', 'reviewed', 'archived')
  AND (
    data->>'submitted_at' IS NULL
    OR public.youfu_safe_timestamptz(data->>'submitted_at') IS NULL
  );

-- ---------------------------------------------------------------------------
-- 4) 新写入约束：能耗 submitted_at 若存在必须是合法时间
-- ---------------------------------------------------------------------------
ALTER TABLE business_flow_tasks
  DROP CONSTRAINT IF EXISTS business_flow_tasks_energy_submitted_at_chk;

ALTER TABLE business_flow_tasks
  ADD CONSTRAINT business_flow_tasks_energy_submitted_at_chk
  CHECK (
    entity_type <> 'energy_collection'
    OR data->>'submitted_at' IS NULL
    OR public.youfu_safe_timestamptz(data->>'submitted_at') IS NOT NULL
  );
