-- 034_emergency_transport.sql —— P2 第二刀：应急预案库 + 预警中心 + 运送轨迹
-- 风格对齐 011_inspection.sql：uuid 主键 + tenant_id + RLS(TO youfu_app) + GRANT + 索引。
-- 须以 superuser(postgres) 执行：psql "$DATABASE_URL_POSTGRES" -f 034_emergency_transport.sql
-- 全部 IF NOT EXISTS / DROP POLICY IF EXISTS 幂等，可重复执行（兼容 migrate 重跑与手工补表）。

-- ============ 应急预案库（知识库 / 预案目录） ============
CREATE TABLE IF NOT EXISTS emergency_plan (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  code          text,                       -- 预案编号
  title         text NOT NULL,              -- 预案名称
  category      text NOT NULL DEFAULT 'general', -- 分类：fire|medical|security|general...
  level         text NOT NULL DEFAULT 'L3', -- 等级：L1(紧急)/L2(重要)/L3(提示)
  content       text,                       -- 预案正文/说明
  steps         jsonb NOT NULL DEFAULT '[]'::jsonb, -- 处置步骤 [{title,detail}]
  owner         text,                       -- 责任人
  contact_phone text,                        -- 联系电话
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE emergency_plan ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS emergency_plan_tenant_isolation ON emergency_plan;
CREATE POLICY emergency_plan_tenant_isolation ON emergency_plan
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON emergency_plan TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_emergency_plan_tenant ON emergency_plan (tenant_id);
CREATE INDEX IF NOT EXISTS idx_emergency_plan_tenant_cat ON emergency_plan (tenant_id, category);

-- ============ 预警 / 告警 ============
CREATE TABLE IF NOT EXISTS alert (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL,
  source_type     text NOT NULL,   -- inspection | transport | manual | system
  source_id       text,            -- 来源业务ID（如 inspection_task.id）
  level           text NOT NULL DEFAULT 'L2', -- L1(紧急)/L2(重要)/L3(提示)
  title           text NOT NULL,
  message         text,
  status          text NOT NULL DEFAULT 'pending', -- pending | handling | handled | ignored
  related_plan_id uuid,            -- 关联应急预案
  handler         text,            -- 处理人
  handled_at      timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE alert ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS alert_tenant_isolation ON alert;
CREATE POLICY alert_tenant_isolation ON alert
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON alert TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_alert_tenant ON alert (tenant_id);
CREATE INDEX IF NOT EXISTS idx_alert_tenant_status ON alert (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_alert_tenant_level ON alert (tenant_id, level);

-- ============ 运送订单 ============
CREATE TABLE IF NOT EXISTS transport_order (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL,
  code            text,            -- 运送单号
  item_name       text NOT NULL,   -- 运送物品
  from_loc        text,            -- 起点
  to_loc          text,            -- 终点
  carrier         text,            -- 运送人
  priority        text NOT NULL DEFAULT 'normal', -- urgent | normal | low
  status          text NOT NULL DEFAULT 'pending', -- pending|assigned|transporting|done|exception|cancelled
  plan_depart_at  timestamptz,
  depart_at       timestamptz,
  arrive_at       timestamptz,
  sign_at         timestamptz,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE transport_order ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS transport_order_tenant_isolation ON transport_order;
CREATE POLICY transport_order_tenant_isolation ON transport_order
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON transport_order TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_transport_order_tenant ON transport_order (tenant_id);
CREATE INDEX IF NOT EXISTS idx_transport_order_tenant_status ON transport_order (tenant_id, status);

-- ============ 运送轨迹点 ============
CREATE TABLE IF NOT EXISTS transport_track_point (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  order_id    uuid NOT NULL,
  event       text NOT NULL,   -- dispatch|receive|transit|arrive|sign|note|exception
  loc         text,            -- 位置描述
  note        text,
  lat         double precision,
  lng         double precision,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE transport_track_point ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS transport_track_point_tenant_isolation ON transport_track_point;
CREATE POLICY transport_track_point_tenant_isolation ON transport_track_point
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON transport_track_point TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_track_point_order ON transport_track_point (tenant_id, order_id);
