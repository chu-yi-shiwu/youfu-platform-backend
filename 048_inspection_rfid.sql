-- 048_inspection_rfid.sql —— 批次 D2：巡检外部硬件预留（RFID/传感器，诚实：仅协议/字段/UI 预留）。
-- 设计意图：
--   - inspection_item 加 device_type/device_tag/trigger_mode：检查项可绑定外部设备（RFID 标签/传感器），
--     硬件到位后「扫到对应 device_tag 才允许通过/自动填充实测」——即插即用，本轮不接真实硬件。
--   - inspection_task 加 scan_meta jsonb：巡检执行打卡记录（扫码点/时间/GPS lat/lng），
--     scan_tag 落库（不匹配拒绝/降级），为后续硬件联动留数据位。
-- 全部 IF NOT EXISTS / ADD COLUMN IF NOT EXISTS 幂等；须 superuser 执行：sudo -u postgres psql -d youfu -f 048_inspection_rfid.sql

-- ============ inspection_item 外部设备绑定 ============
ALTER TABLE inspection_item ADD COLUMN IF NOT EXISTS device_type text;
ALTER TABLE inspection_item ADD COLUMN IF NOT EXISTS device_tag text;
ALTER TABLE inspection_item ADD COLUMN IF NOT EXISTS trigger_mode text DEFAULT 'manual'
  CHECK (trigger_mode IN ('manual','scan','auto'));

-- ============ inspection_task 打卡元数据 ============
ALTER TABLE inspection_task ADD COLUMN IF NOT EXISTS scan_meta jsonb NOT NULL DEFAULT '{}'::jsonb;
