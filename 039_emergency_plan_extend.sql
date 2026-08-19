-- 039_emergency_plan_extend.sql —— 补齐应急预案字段（图3「阉割版」修复）。
-- 原 034 仅 code/title/category/level/content/steps/owner/contact_phone/enabled，缺完整预案要素。
-- 现增补：适用场景 / 触发条件 / 响应组织 / 物资清单 / 关联资产区域 / 演练记录。
-- 全部 ADD COLUMN IF NOT EXISTS，幂等可重跑；表级 GRANT 自动覆盖新增列，无需额外授权。

ALTER TABLE emergency_plan ADD COLUMN IF NOT EXISTS applicable_scene text;       -- 适用场景
ALTER TABLE emergency_plan ADD COLUMN IF NOT EXISTS trigger_condition text;       -- 触发条件
ALTER TABLE emergency_plan ADD COLUMN IF NOT EXISTS response_org text;            -- 响应组织
ALTER TABLE emergency_plan ADD COLUMN IF NOT EXISTS materials text;               -- 物资清单
ALTER TABLE emergency_plan ADD COLUMN IF NOT EXISTS related_asset_area text;      -- 关联资产区域
ALTER TABLE emergency_plan ADD COLUMN IF NOT EXISTS drill_record text;            -- 演练记录
