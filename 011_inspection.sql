-- 011_inspection.sql —— 批次 B：巡检模块（PRD §6.1）
-- 巡检 = 周期任务 + 定位签到 + 硬件扫码/NFC + 离线可操作，独立设计（非普通工单）。
--   inspection_point：点位（设备/位置，可 NFC/二维码绑定）
--   inspection_task ：巡检单（计划/自由），含定位、状态、异常转工单回填
-- 与既有表一致：uuid 主键 + tenant_id + RLS(TO youfu_app) + GRANT + 索引。
-- 本迁移为 DDL，须以 superuser(postgres) 执行（youfu_app 无 DDL 权）：
--   psql "$DATABASE_URL_POSTGRES" -f 011_inspection.sql

CREATE TABLE IF NOT EXISTS inspection_point (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  name        text NOT NULL,
  code        text,                         -- 设备/点位编码（NFC/二维码），自由巡检扫此发起
  lng         double precision,             -- 经度（定位签到基准）
  lat         double precision,             -- 纬度
  asset_id    text,                         -- 可关联资产（批次 C 资产台账）
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inspection_point ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inspection_point_tenant_isolation ON inspection_point;
CREATE POLICY inspection_point_tenant_isolation ON inspection_point
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON inspection_point TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_inspection_point_tenant ON inspection_point (tenant_id);

CREATE TABLE IF NOT EXISTS inspection_task (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  plan_id       uuid,                       -- 计划巡检来源（自由巡检为 null）
  point_id      uuid,                       -- 绑定点位
  type          text NOT NULL DEFAULT 'plan',   -- plan | free
  title         text NOT NULL,
  assignee      text,                       -- 巡检人
  status        text NOT NULL DEFAULT 'pending', -- pending | in_progress | done | exception
  geo_lat       double precision,           -- 签到定位纬度
  geo_lng       double precision,           -- 签到定位经度
  note          text,                       -- 备注/异常描述
  photos        jsonb NOT NULL DEFAULT '[]'::jsonb, -- 拍照附件
  scheduled_at  timestamptz,                -- 计划执行时间
  done_at       timestamptz,                -- 完成时间
  linked_wo_id  uuid,                       -- 异常转工单后回填（不混进标准派单流，仅异常时转）
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE inspection_task ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inspection_task_tenant_isolation ON inspection_task;
CREATE POLICY inspection_task_tenant_isolation ON inspection_task
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON inspection_task TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_inspection_task_tenant_status ON inspection_task (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_inspection_task_tenant_point ON inspection_task (tenant_id, point_id);
CREATE INDEX IF NOT EXISTS idx_inspection_task_tenant_sched ON inspection_task (tenant_id, scheduled_at);
