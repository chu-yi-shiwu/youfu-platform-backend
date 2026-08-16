-- 004_sla.sql —— P4 SLA 扫描真实化（M3 Step2）
-- 给 work_orders 增加 SLA 时限/升级追踪字段（已含 RLS，沿用既有隔离策略，无需重复建 policy）。
-- 执行：随 npm run migrate 自动按序加载；或 psql "$DATABASE_URL" -f 004_sla.sql

-- SLA 时限（分钟）：建单/派单后由引擎按 catalog 派生（详见 src/engine/sla.ts）。
-- 设计口径（来自 PRD 需求规格 §7）：维修紧急 30min / 一般 4h；运送紧急 15min。
-- 这里存"应付截止时刻"，扫描时用 now() 比较，时区无关（都用服务端 now()）。
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS sla_minutes int;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS sla_due_at  timestamptz;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS escalated_at timestamptz;

-- ticket_event 的 type 枚举注释补充 sla_escalated（应用层约束，PG 仅 text）
COMMENT ON COLUMN ticket_event.type IS 'create / assign / transition / sla_escalated';

-- 本迁移用 superuser(postgres) 执行；新列默认仅属主可读写，需显式授权给业务角色 youfu_app，
-- 否则 SET ROLE youfu_app 后读写新列会被拒（RLS 隔离依赖 youfu_app 角色）。
GRANT SELECT, UPDATE, INSERT ON work_orders TO youfu_app;
