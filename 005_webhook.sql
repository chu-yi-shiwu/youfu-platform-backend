-- 005_webhook.sql —— P5 事件溯源对外投递（Webhook）
-- 事件溯源已在 ticket_event 落地（create/assign/transition/sla_escalated）。
-- 本迁移补充"订阅 + 投递"两张表，使工单事件可实时推送到外部系统（如试点期配的外部订阅地址）。
-- 执行：本迁移为 DDL，**必须用 superuser(postgres) 执行**（youfu_app 无 DDL 权，RLS 依赖该角色）。
--   psql "$DATABASE_URL_POSTGRES" -f 005_webhook.sql
-- 注意：npm run migrate 默认以 youfu_app 运行会失败于 DDL——与 004_sla.sql 同一约束，DDL 迁移统一由 postgres 执行。

-- 1) 订阅表：租户内注册外部回调地址
CREATE TABLE IF NOT EXISTS webhook_subscription (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  text NOT NULL,
  url        text NOT NULL,                      -- 外部回调地址（https 推荐）
  secret     text NOT NULL,                      -- 签名密钥（HMAC-SHA256，仅创建时返回一次）
  events     text[] NOT NULL DEFAULT '{}',       -- 订阅事件类型；含 '*' 表示全部
  active     boolean NOT NULL DEFAULT true,      -- 软停用开关
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 2) 投递记录表：每次投递可观测、便于排错与重试判定
CREATE TABLE IF NOT EXISTS webhook_delivery (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL,
  subscription_id uuid,                          -- 关联订阅（订阅删除后仍留痕，故可空）
  event_type     text NOT NULL,
  work_order_id  text,
  attempt        int NOT NULL DEFAULT 1,
  status_code    int,                            -- 外部 HTTP 状态码；连接失败为 NULL
  response_body  text,
  error          text,                           -- 连接/超时错误；成功为 NULL
  delivered_at   timestamptz NOT NULL DEFAULT now()
);

-- 3) RLS：与既有表一致，按租户隔离（TO youfu_app，连接层 SET ROLE youfu_app 后生效）
ALTER TABLE webhook_subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_delivery    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS webhook_subscription_tenant_isolation ON webhook_subscription;
CREATE POLICY webhook_subscription_tenant_isolation ON webhook_subscription
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

DROP POLICY IF EXISTS webhook_delivery_tenant_isolation ON webhook_delivery;
CREATE POLICY webhook_delivery_tenant_isolation ON webhook_delivery
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- 4) 业务角色授权（属主为 postgres，youfu_app 仅运行时读写）
GRANT SELECT, INSERT, UPDATE ON webhook_subscription TO youfu_app;
GRANT SELECT, INSERT, UPDATE ON webhook_delivery    TO youfu_app;

-- 5) 索引：订阅按租户+活跃过滤；投递按租户时间倒序排查
CREATE INDEX IF NOT EXISTS idx_webhook_sub_tenant_active
  ON webhook_subscription (tenant_id, active);
CREATE INDEX IF NOT EXISTS idx_webhook_delivery_tenant_time
  ON webhook_delivery (tenant_id, delivered_at DESC);
