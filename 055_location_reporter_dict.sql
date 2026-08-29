-- 055_location_reporter_dict.sql
-- 报修人扫码基本信息来源：位置字典（设备/房间）+ 报修人角色字典（员工）
-- 2026-08-23 v0.4.0 初一反馈：位置/姓名/手机号是租户预录入基本信息，不应让报修人在小程序里手填或授权

-- 位置字典：每个租户预录入的"报修发生位置"（设备/房间/工位）
CREATE TABLE IF NOT EXISTS location_dict (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  code text NOT NULL,                -- 租户内唯一编码（如 3F-A01, MRI-001）
  name text NOT NULL,                -- 展示名（3F 会议室 A01 / 一楼 MRI 室）
  category text,                     -- 可选分类：设备/房间/工位
  default_reporter_id uuid,          -- 该位置默认报修人（可选）
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_location_dict_tenant_code ON location_dict(tenant_id, code);
CREATE INDEX IF NOT EXISTS ix_location_dict_tenant ON location_dict(tenant_id) WHERE enabled = true;

-- 报修人角色字典：租户员工（维修工/前台/护士/物业等）
CREATE TABLE IF NOT EXISTS reporter_dict (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  code text NOT NULL,                -- 租户内唯一编码（zhangsan / 维修01）
  name text NOT NULL,                -- 真实姓名（张三，不是微信昵称）
  phone text NOT NULL,               -- 真实手机号（18712345678）
  role text,                         -- 角色：维修工/前台/护士/物业
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_reporter_dict_tenant_code ON reporter_dict(tenant_id, code);
CREATE INDEX IF NOT EXISTS ix_reporter_dict_tenant ON reporter_dict(tenant_id) WHERE enabled = true;

-- RLS：与租户其他表一致（owner 已改 postgres，pool 直连无 GUC 需用 withTenantClient）
-- ALTER TABLE location_dict ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE reporter_dict ENABLE ROW LEVEL SECURITY;
