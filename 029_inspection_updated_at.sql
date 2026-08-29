-- 巡检任务补 updated_at 列（原硬编码路由引用了 updated_at = now()，但 011_inspection.sql 未建列，
-- 因前端占位从未触发故潜伏；配置中心把巡检接回引擎后首次暴露。补列使巡检模块整体正确）。
-- 幂等：IF NOT EXISTS。
ALTER TABLE inspection_task ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
