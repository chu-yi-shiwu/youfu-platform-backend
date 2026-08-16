-- 012_volunteer.sql —— 批次 B：志愿者模块（PRD §6.5）
-- 志愿者 = 报名→签到→服务(记录时长/积分)→签退/审批，走"派单变体"模板，保留专属字段，
-- 不与普通工单混。积分在签退时按服务时长自动计算（每满 1 小时计 1 分，向下取整）。
--   volunteer_activity：活动（批次、名额、时间窗）
--   volunteer_record ：报名记录（状态机 + 时长 + 积分）
-- 与既有表一致：uuid 主键 + tenant_id + RLS + GRANT + 索引。
-- 本迁移为 DDL，须以 superuser(postgres) 执行：
--   psql "$DATABASE_URL_POSTGRES" -f 012_volunteer.sql

CREATE TABLE IF NOT EXISTS volunteer_activity (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  title       text NOT NULL,
  batch       text,                         -- 活动批次
  location    text,
  start_at    timestamptz,
  end_at      timestamptz,
  slots       int NOT NULL DEFAULT 0,       -- 名额
  status      text NOT NULL DEFAULT 'open', -- open | closed
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE volunteer_activity ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS volunteer_activity_tenant_isolation ON volunteer_activity;
CREATE POLICY volunteer_activity_tenant_isolation ON volunteer_activity
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON volunteer_activity TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_volunteer_activity_tenant ON volunteer_activity (tenant_id);

CREATE TABLE IF NOT EXISTS volunteer_record (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  activity_id   uuid NOT NULL,
  user_name     text NOT NULL,
  status        text NOT NULL DEFAULT 'registered', -- registered | checked_in | serving | checked_out | approved
  check_in_at   timestamptz,                -- 签到（到场）时间
  check_out_at  timestamptz,                -- 签退时间
  duration_min  int NOT NULL DEFAULT 0,     -- 服务时长（分钟）
  points        int NOT NULL DEFAULT 0,     -- 积分
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE volunteer_record ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS volunteer_record_tenant_isolation ON volunteer_record;
CREATE POLICY volunteer_record_tenant_isolation ON volunteer_record
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON volunteer_record TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_volunteer_record_tenant_activity ON volunteer_record (tenant_id, activity_id);
CREATE INDEX IF NOT EXISTS idx_volunteer_record_tenant_status ON volunteer_record (tenant_id, status);
