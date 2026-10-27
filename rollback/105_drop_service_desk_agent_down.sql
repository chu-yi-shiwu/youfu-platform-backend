-- rollback/105_drop_service_desk_agent_down.sql —— 105 的反向迁移
--
-- 用途：仅当 105_drop_service_desk_agent.sql 已应用、需要**回退**时才执行。
-- 位置：放在 `rollback/`（与既有 101~104 的 _down.sql 同目录）。
--       ⚠️ 该目录**不会被**自动应用：两个迁移入口都只扫仓根
--       （src/db/migrate.ts:39-41 与 scripts/migrate-as-owner.sh 的 ls [0-9][0-9][0-9]_*.sql），
--       且本文件名以 `_down.sql` 结尾、以 `rollback/` 为父目录 ⇒ 双重不命中。
--
-- =============================================================================
-- 🔴🔴 最重要的一句话：本脚本**只恢复表结构，不恢复任何一行数据** 🔴🔴
-- =============================================================================
--   跑完得到的是一张**空表**。若那 1 行还需要，必须另行回灌：
--     骨架仓 docs/00_现行/_archive/service_desk_agent_备份_20261028.sql
--     （或生产每日全量备份 /opt/youfu/backup/youfu_YYYYMMDD_030701.sql.gz）
--   ⇒ 所以 105 的**前置条件**是"先导出留档"，没有留档就不许跑 105。
--
-- =============================================================================
-- 结构来源说明（与 018 的差异，按**生产现状**为准）
-- =============================================================================
--   018_service_desk.sql:40 授的是 GRANT SELECT, INSERT, UPDATE, DELETE，
--   但生产实际是 **GRANT ALL ON TABLE service_desk_agent TO youfu_app**
--   （2026-10-28 pg_dump --schema-only 实测）。
--   ⇒ 本脚本按生产现状写 **GRANT ALL**，避免回退后权限窄于现状、出现
--     "表回来了但写不进" 的假回退。若有意收紧，请另行决策，不要在本回退里夹带。
--
-- =============================================================================
-- 执行
--   sudo -u postgres psql -d youfu -f rollback/105_drop_service_desk_agent_down.sql
-- =============================================================================

CREATE TABLE IF NOT EXISTS service_desk_agent (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  text NOT NULL,
  desk_id    uuid NOT NULL REFERENCES service_desk(id) ON DELETE CASCADE,
  user_id    text NOT NULL,                   -- 关联 account_user.id
  name       text NOT NULL,                   -- 客服人员姓名
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, desk_id, user_id)
);

ALTER TABLE service_desk_agent ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_desk_agent_tenant_isolation ON service_desk_agent;
CREATE POLICY service_desk_agent_tenant_isolation ON service_desk_agent
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- 与生产现状一致（见上面的"结构来源说明"）
GRANT ALL ON TABLE service_desk_agent TO youfu_app;

CREATE INDEX IF NOT EXISTS idx_agent_desk ON service_desk_agent(desk_id);
