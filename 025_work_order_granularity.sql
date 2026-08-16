-- 025_work_order_granularity.sql —— 取老系统 UOne 工单全生命周期之所长，补齐维度字段
-- 在优服家可配置 workflow_def 引擎上跑通更细颗粒度：来源/故障类型/服务台/满意度/模板动态字段。
-- 执行：随 npm run migrate 按序加载；或 psql 以 superuser(postgres) 执行。
-- 仅新增列（IF NOT EXISTS），向后兼容既有工单；不改变状态机（状态图存 workflow_def）。

-- 工单来源：微信申告 / 后台申告 / 来电(电话) 等；缺省 backend。
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS source VARCHAR(32) NOT NULL DEFAULT 'backend';
-- 故障类型（故障类型目录，对应 UOne countTroubleCatalogue）。
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS fault_type VARCHAR(64);
-- 所属服务台（对应 UOne 工单服务台表 / 客服人员派单统计）。
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS service_desk VARCHAR(64);
-- 满意度评分（0-5，关闭/评价后回写；nullable）。
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS satisfaction_score SMALLINT CHECK (satisfaction_score IS NULL OR satisfaction_score BETWEEN 0 AND 5);
-- 模板动态字段（工单模板驱动的单行/多行/单选/多选/数值/日期/图片附件等，存为 JSONB）。
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS ext JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN work_orders.source IS '工单来源: wechat/backend/phone';
COMMENT ON COLUMN work_orders.fault_type IS '故障类型(目录)';
COMMENT ON COLUMN work_orders.service_desk IS '所属服务台';
COMMENT ON COLUMN work_orders.satisfaction_score IS '满意度评分 0-5';
COMMENT ON COLUMN work_orders.ext IS '工单模板动态字段(JSONB)';

-- 新列默认仅属主可读写，显式授权给业务角色 youfu_app（RLS 隔离依赖该角色）。
GRANT SELECT, UPDATE, INSERT ON work_orders TO youfu_app;
