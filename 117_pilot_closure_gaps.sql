-- 117：业务闭环补齐（2026-11-14）
-- 1) 基础数据字典「停用优先」：给缺少 enabled 的字典表补列；历史行默认启用。
-- 2) 需求反馈关闭留痕：closed_at / closed_by / close_note。
-- 说明：sla_policy / work_order_template / business_type_dict / location_dict / reporter_dict
--       在更早迁移中已有 enabled，本迁移只补缺失表，全部 IF NOT EXISTS 可重复执行。

ALTER TABLE dept            ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE region          ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE contact         ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE supplier        ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE equipment_type  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE equipment_brand ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE priority_dict   ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;

ALTER TABLE feedback ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS closed_by text;
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS close_note text;
