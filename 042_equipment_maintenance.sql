-- 042_equipment_maintenance.sql
-- P3b 设备维保：新增 equipment_maintenance 表，记录设备保养/维修历史。
-- 用途：设备档案可挂维保计划与记录（保养类型/计划日期/完成日期/费用/负责人/备注/照片），复用资产维保模式。
-- 部署契约：以数据库属主（ECS 上 postgres）执行；youfu_app 为受 RLS 约束的非属主角色无权 ALTER 表。
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 042_equipment_maintenance.sql
-- 幂等：全部 IF NOT EXISTS，可安全重跑。

CREATE TABLE IF NOT EXISTS equipment_maintenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  equipment_id uuid NOT NULL,
  mtype text NOT NULL DEFAULT 'maintain',   -- maintain 保养 | repair 维修 | inspect 巡检
  plan_date date,                            -- 计划日期
  done_date date,                            -- 完成日期
  cost numeric(12,2) DEFAULT 0,              -- 费用
  responsible text,                          -- 负责人
  note text,                                 -- 备注
  photos text[],                            -- 照片（OSS/相对路径数组）
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 索引：按设备反查维保记录
CREATE INDEX IF NOT EXISTS idx_equipment_maintenance_equipment
  ON equipment_maintenance (tenant_id, equipment_id);

-- RLS：复用租户策略（与 equipment 表一致，tenant_id 为 text，不做 uuid 强转）
ALTER TABLE equipment_maintenance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS equipment_maintenance_tenant_isolation ON equipment_maintenance;
CREATE POLICY equipment_maintenance_tenant_isolation ON equipment_maintenance
  USING (tenant_id = current_setting('app.tenant_id'))
  WITH CHECK (tenant_id = current_setting('app.tenant_id'));
