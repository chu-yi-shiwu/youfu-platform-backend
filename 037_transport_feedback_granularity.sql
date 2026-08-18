-- 037_transport_feedback_granularity.sql —— P2 运送深化 + P5 反馈导出补齐。
-- 对齐 UOne A3（运送：物品分类/自由运送）+ UOne H（反馈：导出）：
--   transport_order 补 item_category(物品分类) / order_type(计划运送 scheduled | 自由运送 free)。
-- 全部 IF NOT EXISTS 幂等，可重复执行；与线上 DB 现状对齐。
-- 须以 superuser(postgres) 执行：psql "$DATABASE_URL_POSTGRES" -f 037_transport_feedback_granularity.sql

-- ============ transport_order 补列 ============
ALTER TABLE transport_order ADD COLUMN IF NOT EXISTS item_category text;          -- 物品分类（标本/药品/文件/器械...）
ALTER TABLE transport_order ADD COLUMN IF NOT EXISTS order_type text NOT NULL DEFAULT 'scheduled'; -- scheduled 计划运送 | free 自由运送
CREATE INDEX IF NOT EXISTS idx_transport_order_category ON transport_order (tenant_id, item_category);
CREATE INDEX IF NOT EXISTS idx_transport_order_type ON transport_order (tenant_id, order_type);
