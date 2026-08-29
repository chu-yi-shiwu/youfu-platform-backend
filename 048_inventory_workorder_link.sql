-- 物料领用 × 工单 外键级关联（出库挂工单，供工单详情查"用了哪些料" + 飞轮归因）
ALTER TABLE inventory_log ADD COLUMN IF NOT EXISTS work_order_id uuid;
