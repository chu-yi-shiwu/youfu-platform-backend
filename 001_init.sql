-- 优服家后端最小闭环 Schema（M3 Step1）
-- 多租户隔离：连接层 SET LOCAL app.tenant_id + RLS policy，不建 tenant 元数据表。
-- 状态机：draft -> assigned -> processing -> completed，状态校验在应用层纯函数完成。
-- 执行：psql "$DATABASE_URL" -f 001_init.sql  或  npm run migrate

-- 1) 承载租户隔离的会话函数（RLS 读取会话级 tenant_id）
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS text
  LANGUAGE sql STABLE AS $$
    SELECT COALESCE(current_setting('app.tenant_id', true), '')::text;
$$;

-- 2) worker 模拟表（派单候选池）
CREATE TABLE IF NOT EXISTS worker (
  id            text PRIMARY KEY,
  tenant_id     text NOT NULL,
  name          text NOT NULL,
  skill_tags    text[] NOT NULL DEFAULT '{}',   -- 技能标签，用于技能匹配派单
  load          int  NOT NULL DEFAULT 0,          -- 当前在途工单数，用于 least_load
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 3) work_orders 主表
CREATE TABLE IF NOT EXISTS work_orders (
  id            text PRIMARY KEY,
  tenant_id     text NOT NULL,
  business_type text NOT NULL,                    -- 业务类型（来自元数据，非写死）
  catalog       text,                             -- 目录/科室
  priority      text NOT NULL DEFAULT 'normal',   -- normal/urgent
  location      text,
  title         text,
  description   text,
  contact       text,
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','assigned','processing','completed')),
  assignee_id   text,                             -- 命中派单时指向 worker.id
  auto_flow     boolean NOT NULL DEFAULT false,   -- 是否自动派单命中
  assets        jsonb NOT NULL DEFAULT '[]'::jsonb,-- 拍照/扫码附件引用
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 4) ticket_event 审计表（最小字段）
CREATE TABLE IF NOT EXISTS ticket_event (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL,
  work_order_id text NOT NULL,
  type         text NOT NULL,                     -- create / transition / assign
  from_status  text,
  to_status    text,
  actor        text,                              -- 操作人/系统
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 5) idempotency_key 幂等表（最小字段）
CREATE TABLE IF NOT EXISTS idempotency_key (
  key            text PRIMARY KEY,
  tenant_id      text NOT NULL,
  work_order_id  text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- 6) RLS：开启并强制行级隔离（P1 规避核心）
ALTER TABLE work_orders    ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_event   ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_key ENABLE ROW LEVEL SECURITY;

-- 租户内可见：每行只能被其 tenant_id 对应的会话读取/写入
DROP POLICY IF EXISTS work_orders_tenant_isolation ON work_orders;
CREATE POLICY work_orders_tenant_isolation ON work_orders
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

DROP POLICY IF EXISTS worker_tenant_isolation ON worker;
CREATE POLICY worker_tenant_isolation ON worker
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

DROP POLICY IF EXISTS ticket_event_tenant_isolation ON ticket_event;
CREATE POLICY ticket_event_tenant_isolation ON ticket_event
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

DROP POLICY IF EXISTS idempotency_key_tenant_isolation ON idempotency_key;
CREATE POLICY idempotency_key_tenant_isolation ON idempotency_key
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- 角色说明：应用层连接由超级用户/连接池取得连接后，执行 SET ROLE youfu_app 切换为
-- 受限角色 youfu_app；此后所有 SQL 在该角色下运行，RLS policy 的 TO youfu_app 才生效，
-- 会话级 tenant_id 由连接层 SET LOCAL app.tenant_id 注入。请勿用 superuser 直连业务表，
-- 以免绕过 RLS 行级隔离（P1 规避核心）。youfu_app 角色需预先在 PG 创建并授权库 youfu：
--   CREATE ROLE youfu_app LOGIN PASSWORD '...' NOSUPERUSER;
--   GRANT ALL ON ALL TABLES IN SCHEMA public TO youfu_app;
