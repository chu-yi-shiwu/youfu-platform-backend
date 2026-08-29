-- 二阶段 #12 巡更：点位 + 任务（最小完整版，复用巡检模式语义）
-- patrol_point：巡更点（管理端配置）
-- patrol_task：巡更任务（聚合多个点位，逐点签到；全签完自动 done）
CREATE TABLE IF NOT EXISTS patrol_point (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  name        text NOT NULL,                 -- 巡更点名称
  location    text,                          -- 位置描述
  seq         int NOT NULL DEFAULT 0,        -- 巡更顺序
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS patrol_task (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  title       text NOT NULL,                 -- 任务标题（如：夜班 1 号路线）
  assignee    text,                          -- 巡更人（worker.id）
  point_ids   uuid[] NOT NULL DEFAULT '{}',  -- 本任务覆盖的巡更点（顺序）
  status      text NOT NULL DEFAULT 'pending', -- pending | in_progress | done | missed
  checkins    jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{ point_id, note, at }]
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE patrol_point ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patrol_point_tenant_isolation ON patrol_point;
CREATE POLICY patrol_point_tenant_isolation ON patrol_point
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id());

ALTER TABLE patrol_task ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patrol_task_tenant_isolation ON patrol_task;
CREATE POLICY patrol_task_tenant_isolation ON patrol_task
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id());
