-- 050_open_platform.sql —— 城市级平台层地基（E_min）
-- 1) tenant_registry 租户注册表（平台侧元数据，非业务 RLS）
-- 2) platform_admin 平台管理员（独立账号体系，G3 推荐：不污染租户角色）
-- 3) platform_audit 平台审计（append-only：仅 SELECT/INSERT）
-- 4) platform_tenant_summary() SECURITY DEFINER 跨租户聚合（只出聚合，不下钻，R2）
-- 全部幂等，可重复执行；DDL 须以 superuser(postgres) 执行：
--   sudo -u postgres psql -d youfu -f 050_open_platform.sql

-- ============ 1) 租户注册表 ============
CREATE TABLE IF NOT EXISTS tenant_registry (
  tenant_id  text PRIMARY KEY,
  name       text NOT NULL,
  category   text,                                -- hospital/school/property/municipal/...
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  parent_id  text REFERENCES tenant_registry(tenant_id),  -- 多级治理预留（市→区→机构）
  quota      jsonb,                               -- 配额（工单量/账号数等）
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_registry TO youfu_app;
-- 租户注册表不经 RLS（平台侧元数据，非业务数据隔离）

-- ============ 2) 平台管理员（独立账号，scrypt 同 account.ts 格式） ============
CREATE TABLE IF NOT EXISTS platform_admin (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name  text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON platform_admin TO youfu_app;

-- ============ 3) 平台审计（append-only：禁止 UPDATE/DELETE，R3） ============
CREATE TABLE IF NOT EXISTS platform_audit (
  id            bigserial PRIMARY KEY,
  actor         text NOT NULL,                     -- platform_admin 用户名 或 租户账号
  action        text NOT NULL,                     -- tenant.create/suspend/aggregate/...
  resource      text,                              -- 资源标识
  target_tenant text,                              -- 涉及租户
  payload       jsonb,
  at            timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON platform_audit TO youfu_app;   -- 仅追加+只读
CREATE INDEX IF NOT EXISTS idx_platform_audit_at ON platform_audit (at DESC);

-- ============ 4) 跨租户聚合（SECURITY DEFINER，只出聚合指标，R2 不下钻） ============
CREATE OR REPLACE FUNCTION platform_tenant_summary()
RETURNS TABLE (
  tenant_id text,
  total           int,
  closed          int,
  cancelled       int,
  pending         int,
  processing      int,
  timeout         int,
  satisfaction_avg numeric,
  satisfaction_count int
)
LANGUAGE sql SECURITY DEFINER STABLE AS $$
  SELECT tenant_id,
    count(*)::int                                                                  AS total,
    count(*) FILTER (WHERE status IN ('completed','closed','evaluated'))::int      AS closed,
    count(*) FILTER (WHERE status = 'cancelled')::int                              AS cancelled,
    count(*) FILTER (WHERE status IN ('created','assigned','claim_hall','pending_dispatch','pending_accept'))::int AS pending,
    count(*) FILTER (WHERE status IN ('processing','transporting','accompanying','auditing','review','paused','suspended','pending_review','review_passed'))::int AS processing,
    count(*) FILTER (WHERE status NOT IN ('completed','closed','evaluated','cancelled')
                      AND sla_due_at IS NOT NULL AND sla_due_at < now())::int      AS timeout,
    AVG(satisfaction_score)::numeric(3,2)                                          AS satisfaction_avg,
    COUNT(satisfaction_score)::int                                                 AS satisfaction_count
  FROM work_orders
  GROUP BY tenant_id;
$$;
