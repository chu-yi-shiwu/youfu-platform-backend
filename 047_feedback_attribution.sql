-- P1 反馈归因桥接：feedback 关联工单（satisfaction 反馈可归因到工单/工人，未来进 reward）
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS work_order_id uuid;
