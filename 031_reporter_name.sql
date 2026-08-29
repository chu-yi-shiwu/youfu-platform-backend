-- P1 收尾：工单"申告人"真实列（顶层，避免仅存 ext）。
-- 与 028_phase_a.sql 风格一致；幂等，可重复执行。
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS reporter_name text;
