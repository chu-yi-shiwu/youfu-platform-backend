-- 116：志愿者模块增强
-- 1) 活动签到码（管理员展示二维码，志愿者扫码签到）
-- 2) 取消报名截止时间
-- 3) 志愿者黑名单（按姓名）
ALTER TABLE volunteer_activity ADD COLUMN IF NOT EXISTS checkin_code text;
ALTER TABLE volunteer_activity ADD COLUMN IF NOT EXISTS cancel_deadline timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS ux_volunteer_activity_checkin_code
  ON volunteer_activity (tenant_id, checkin_code)
  WHERE checkin_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS volunteer_blacklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  user_name text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_volunteer_blacklist_tenant_user
  ON volunteer_blacklist (tenant_id, user_name);

ALTER TABLE volunteer_blacklist ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS volunteer_blacklist_tenant_isolation ON volunteer_blacklist;
CREATE POLICY volunteer_blacklist_tenant_isolation ON volunteer_blacklist
  TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
