-- 074 工单生命周期里程碑时间列（2026-09-06 任务④：受理→派工→到场→开始→完成→评价全打点）
-- 背景：work_orders 此前仅有 created_at/updated_at（001），生命周期各环节时间只能靠
--   ticket_event/domain_event 事件流水反推，统计口径脆弱。本迁移补六个里程碑列，
--   与既有 sla_due_at/escalated_at（004）、sla_paused_at（026）、satisfaction_score（025）同范式。
-- 写入口径（单一事实源 = src/engine/stateMachine.ts 的 STATUS_TIMESTAMP_COLUMNS）：
--   accepted_at  = 首次进入 pending_accept（受理）
--   assigned_at  = 进入 assigned（派单/抢单，自动派单与抢单旁路同步回填）
--   arrived_at   = 进入 arrived（到场，074 新增状态，processing 之前）
--   started_at   = 进入 processing（开始处理；resume/reject 再入会刷新为最近一次开始）
--   completed_at = 进入 completed（完成）
--   rated_at     = 进入 evaluated（评价）
-- 注意：旧单六列为 NULL 属预期（无事件可回填，不做历史回填，诚实留白）。
-- RLS 纪律：本迁移为 DDL，由迁移通道（postgres 超管）执行；运行期读写均走
--   withTenantClient（RLS 注入 tenant_id），无新增裸查询。

ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS accepted_at  timestamptz;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS assigned_at  timestamptz;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS arrived_at   timestamptz;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS started_at   timestamptz;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS rated_at     timestamptz;

-- 说明：不建独立索引——里程碑列用于统计/看板聚合（全表或按状态段扫描），
-- 现有 status/tenant 索引已覆盖主查询路径，避免为低频报表列增加写放大。
-- 如后续看板出现按 arrived_at 范围查询的热路径，再按 044_perf_indexes 范式补索引。

-- ⚠️ 部署注意（重要）：状态机定义存于 workflow_def 表（per-tenant JSON）。
-- 本代码版本更新了 RICH_WORK_ORDER_DEF（新增 arrived 状态与 arrive/start/cancel 边），
-- 但已按旧版富模板种子化的租户，其 workflow_def.def JSON 仍是 14 态——arrived 边不会生效，
-- 需由管理端「模板应用/保存」重新写入（saveWorkflowDef），或运营侧单独刷 JSON。
-- 本迁移不做 JSON 数据改写（避免脚本改业务状态图的风险），如实挂账由负责人决定刷法。
