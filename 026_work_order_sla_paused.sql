-- 026: work_orders 增加 SLA 暂停时间戳，支撑 A+ 流转副作用 pause_sla/resume_sla（真实落库可断言）。
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS sla_paused_at TIMESTAMPTZ;
GRANT SELECT, UPDATE ON work_orders TO youfu_app;
