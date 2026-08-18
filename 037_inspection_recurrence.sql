-- 037_inspection_recurrence.sql —— G3：巡检周期/循环计划（MVP，真 cron 调度列为后续增强）。
-- 设计：新增 inspection_plan（租户级周期计划），复用 inspection_task.plan_id 关联已生成实例。
--   frequency/interval_n 描述节奏；next_run_at 记录下一期时间；paused 控制是否继续推进。
--   建计划时按规则批量生成未来 N 期 scheduled 巡检单；暂停则不再推进；手动"生成下一期"推进 next_run_at。
-- 全部 IF NOT EXISTS / DROP POLICY IF EXISTS 幂等，可重复执行；与线上 DB 现状对齐，保证全新库可复现部署。
-- 须以 superuser(postgres) 执行：
--   PGPASSWORD=youfu2026 psql -U postgres -h 127.0.0.1 -p 5432 -d youfu -f 037_inspection_recurrence.sql

-- ============ inspection_plan 周期计划 ============
CREATE TABLE IF NOT EXISTS inspection_plan (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL,
  name         text NOT NULL,
  point_ids    uuid[] NOT NULL DEFAULT '{}',
  frequency    text NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  interval_n   int NOT NULL DEFAULT 1,
  next_run_at  timestamptz,
  paused       boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inspection_plan ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inspection_plan_tenant_isolation ON inspection_plan;
CREATE POLICY inspection_plan_tenant_isolation ON inspection_plan
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON inspection_plan TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_inspection_plan_tenant ON inspection_plan(tenant_id);

-- inspection_task.plan_id 已随建表存在（inspection.ts 的 INSERT 已引用），补索引提升按计划查实例性能。
CREATE INDEX IF NOT EXISTS idx_inspection_task_plan ON inspection_task(tenant_id, plan_id);
