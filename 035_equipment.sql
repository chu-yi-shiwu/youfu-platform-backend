-- 035_equipment.sql —— P4 设备管理（对齐 UOne C 族：设备 / 设备类型 / 设备厂商）
-- 风格对齐 034_emergency_transport.sql：uuid 主键 + tenant_id + RLS(TO youfu_app) + GRANT + 索引。
-- 须以 superuser(postgres) 执行：psql "$DATABASE_URL_POSTGRES" -f 035_equipment.sql
-- 全部 IF NOT EXISTS / DROP POLICY IF EXISTS 幂等，可重复执行（兼容 migrate 重跑与手工补表）。

-- ============ 设备类型（字典，租户内 code 唯一） ============
CREATE TABLE IF NOT EXISTS equipment_type (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   TEXT NOT NULL,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  remark      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
ALTER TABLE equipment_type ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS equipment_type_tenant_isolation ON equipment_type;
CREATE POLICY equipment_type_tenant_isolation ON equipment_type
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON equipment_type TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_equipment_type_tenant ON equipment_type (tenant_id);

-- ============ 设备厂商（字典，租户内 code 唯一） ============
CREATE TABLE IF NOT EXISTS equipment_vendor (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  code            TEXT NOT NULL,
  name            TEXT NOT NULL,
  contact_person  TEXT,
  phone           TEXT,
  address         TEXT,
  remark          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);
ALTER TABLE equipment_vendor ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS equipment_vendor_tenant_isolation ON equipment_vendor;
CREATE POLICY equipment_vendor_tenant_isolation ON equipment_vendor
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON equipment_vendor TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_equipment_vendor_tenant ON equipment_vendor (tenant_id);

-- ============ 设备档案（主数据，引用 类型/厂商） ============
CREATE TABLE IF NOT EXISTS equipment (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  name            TEXT NOT NULL,                 -- 设备名称
  code            TEXT,                          -- 设备编号/资产编号
  type_id         UUID,                          -- 设备类型（引用 equipment_type）
  vendor_id       UUID,                          -- 设备厂商（引用 equipment_vendor）
  model           TEXT,                          -- 型号
  sn              TEXT,                          -- 序列号
  location        TEXT,                          -- 安装位置
  status          TEXT NOT NULL DEFAULT 'in_use',-- in_use(在用)/idle(闲置)/repair(维修中)/scrapped(报废)
  purchase_date   DATE,                          -- 购置日期
  price           NUMERIC(12,2),                 -- 购置金额
  responsible     TEXT,                          -- 责任人
  remark          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE equipment ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS equipment_tenant_isolation ON equipment;
CREATE POLICY equipment_tenant_isolation ON equipment
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON equipment TO youfu_app;
CREATE INDEX IF NOT EXISTS idx_equipment_tenant ON equipment (tenant_id);
CREATE INDEX IF NOT EXISTS idx_equipment_tenant_type ON equipment (tenant_id, type_id);
CREATE INDEX IF NOT EXISTS idx_equipment_tenant_status ON equipment (tenant_id, status);

-- ============ 种子：常用设备类型（仅 pilot 租户 t-verification，幂等） ============
INSERT INTO equipment_type (tenant_id, code, name, remark)
SELECT 't-verification', v.code, v.name, v.remark
FROM (VALUES
  ('elevator',    '电梯',     '垂直电梯'),
  ('escalator',   '扶梯',     '自动扶梯'),
  ('autodoor',    '自动门',   '自动感应门'),
  ('electric',    '电气',     '供配电设备'),
  ('water',       '给排水',   '水泵/排水设备'),
  ('hvac',        '暖通',     '空调/通风设备'),
  ('fire',        '消防',     '消防设备'),
  ('network',     '网络',     '网络通信设备'),
  ('access',      '门禁',     '门禁安防设备'),
  ('medical_gas', '医用气体', '医用气体设备'),
  ('other',       '其他',     '其他设备')
) AS v(code, name, remark)
WHERE NOT EXISTS (
  SELECT 1 FROM equipment_type t WHERE t.tenant_id='t-verification' AND t.code=v.code
);
