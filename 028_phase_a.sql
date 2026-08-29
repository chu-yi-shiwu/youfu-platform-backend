-- 028_phase_a.sql —— Phase A 滴滴式核心：派单通知 + 部门级抢单维度
-- 与既有表一致：tenant_id text + RLS(app_tenant_id) + GRANT youfu_app；幂等可重复执行。
--   psql "$DATABASE_URL_POSTGRES" -f 028_phase_a.sql   （superuser 执行）

-- 1) notification 表：派单/转台/退回/改派/抢单/挂起等事件通知。
--    channel: in_app(落库即视为已送达) / sms / push（后两者为 stub：仅落库 + 日志，诚实标注未真实发送，待接入网关）。
CREATE TABLE IF NOT EXISTS notification (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  recipient     text NOT NULL,                 -- 接收人：worker.id / account id / desk id
  recipient_kind text NOT NULL DEFAULT 'worker', -- worker / account / desk
  type          text NOT NULL,                 -- dispatch / transpond / return / forward / claim / suspend / resume / close / satisfy
  work_order_id text NOT NULL,
  title         text NOT NULL,
  body          text,
  channel       text NOT NULL DEFAULT 'in_app', -- in_app / sms / push
  delivered     boolean NOT NULL DEFAULT false,  -- 真实送达（sms/push 接入前恒为 false，诚实）
  read          boolean NOT NULL DEFAULT false,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_tenant_isolation ON notification;
CREATE POLICY notification_tenant_isolation ON notification
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON notification TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_notification_tenant_recipient ON notification(tenant_id, recipient, read);
CREATE INDEX IF NOT EXISTS idx_notification_wo ON notification(tenant_id, work_order_id);

-- 2) worker.department：部门级抢单维度（同部门 worker 优先看到/可抢本部门工单）
ALTER TABLE worker ADD COLUMN IF NOT EXISTS department VARCHAR(64);
COMMENT ON COLUMN worker.department IS '所属部门，用于部门级抢单大厅过滤';
GRANT SELECT, UPDATE, INSERT ON worker TO youfu_app;

-- 3) work_orders.department：工单归属部门（建单时由服务台/显式传入推导）
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS department VARCHAR(64);
COMMENT ON COLUMN work_orders.department IS '工单归属部门，用于部门级抢单大厅过滤';
GRANT SELECT, UPDATE, INSERT ON work_orders TO youfu_app;
