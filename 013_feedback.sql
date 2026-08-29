-- 013_feedback.sql —— 批次 B：服务反馈模块（PRD §D）
-- 服务反馈 = 文字/图/语音提交满意度/意见，轻量、无派单，后台统计归类。
-- 与既有表一致：uuid 主键 + tenant_id + RLS + GRANT + 索引。
-- 本迁移为 DDL，须以 superuser(postgres) 执行：
--   psql "$DATABASE_URL_POSTGRES" -f 013_feedback.sql

CREATE TABLE IF NOT EXISTS feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  type        text NOT NULL DEFAULT 'opinion', -- satisfaction | opinion
  content     text NOT NULL,                    -- 文字内容
  rating      int,                              -- 满意度评分 1-5（satisfaction 时填写）
  images      jsonb NOT NULL DEFAULT '[]'::jsonb, -- 图
  audio       text,                             -- 语音地址
  channel     text NOT NULL DEFAULT 'mobile',   -- mobile | desk
  status      text NOT NULL DEFAULT 'new',      -- new | replied
  reply       text,                             -- 回复内容（reply 接口写入）
  replied_at  timestamptz,                      -- 回复时间
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS feedback_tenant_isolation ON feedback;
CREATE POLICY feedback_tenant_isolation ON feedback
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON feedback TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_feedback_tenant ON feedback (tenant_id);
CREATE INDEX IF NOT EXISTS idx_feedback_tenant_type ON feedback (tenant_id, type);
CREATE INDEX IF NOT EXISTS idx_feedback_tenant_status ON feedback (tenant_id, status);
