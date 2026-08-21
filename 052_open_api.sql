-- 052_open_api.sql —— 批次 E0_open：开放平台（连接=能生存）。
-- 1) open_api_app 应用注册（app_key/app_secret/scopes/配额/吊销）——第三方/上级平台/ISV 凭 key 调开放 API
-- 2) open_api_call_log 调用审计（append-only：仅 INSERT/SELECT）
-- 3) integration 连接器框架注册位（短信/HIS/政务等 adapter，真实网关需外部资源，本轮只建框架）
-- 4) event_subscription 事件订阅（平台侧 app 级；租户级 webhook_subscription 已存在可复用投递机制）
-- 全部 IF NOT EXISTS 幂等；DDL 须 superuser 执行：sudo -u postgres psql -d youfu -f 052_open_api.sql

-- ============ 1) 开放 API 应用注册 ============
CREATE TABLE IF NOT EXISTS open_api_app (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_name    text NOT NULL,
  app_key     text NOT NULL UNIQUE,                 -- 公钥（client 标识）
  app_secret  text NOT NULL,                        -- 密钥（仅创建时明文返回一次，DB 存哈希）
  secret_hash text NOT NULL,                        -- HMAC 校验用哈希（不再明文可查）
  owner       text,                                 -- 归属方（平台/租户/ISV 名称）
  scopes      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- 权限域：["summary:read"]
  quotas      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 配额：{ qps: 10, daily: 1000 }
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON open_api_app TO youfu_app;
-- 应用注册表不经 RLS（平台侧元数据）

-- ============ 2) 调用审计（append-only） ============
CREATE TABLE IF NOT EXISTS open_api_call_log (
  id          bigserial PRIMARY KEY,
  app_id      uuid NOT NULL REFERENCES open_api_app(id),
  endpoint    text NOT NULL,
  method      text NOT NULL,
  status_code int,
  at          timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON open_api_call_log TO youfu_app;   -- 仅追加+只读
-- bigserial 序列须显式授权（GRANT ON TABLE 不含序列 USAGE；缺失导致 INSERT nextval 权限错误）
GRANT USAGE, SELECT ON SEQUENCE open_api_call_log_id_seq TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_open_api_call_log_app ON open_api_call_log (app_id, at DESC);

-- ============ 3) 连接器框架注册位 ============
CREATE TABLE IF NOT EXISTS integration (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  type       text NOT NULL CHECK (type IN ('webhook','sms','his','gov','other')),
  adapter    text,                                  -- 适配器标识（预留）
  status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','enabled','disabled')),
  config     jsonb NOT NULL DEFAULT '{}'::jsonb,    -- 连接配置（网关地址/密钥位，真实接入时填）
  remark     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON integration TO youfu_app;

-- ============ 4) 平台侧事件订阅（app 级；投递复用 webhook 签名机制） ============
CREATE TABLE IF NOT EXISTS event_subscription (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      uuid NOT NULL REFERENCES open_api_app(id),
  event_type  text NOT NULL,                        -- create/assign/transition/* 
  url         text NOT NULL,                        -- 回调地址
  secret      text NOT NULL,                        -- 回调签名密钥（HMAC 复用 webhook）
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON event_subscription TO youfu_app;
