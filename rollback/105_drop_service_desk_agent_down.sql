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
-- ⚠️ 刻意不做的一步：本回退**不擦 `_migrations` 账**（与 101~104 约定不一致，有意为之）
-- =============================================================================
--   101/102/103/104 的 _down.sql 都先 `DELETE FROM _migrations WHERE name='NNN_xxx.sql'`
--   再删结构（顺序由 src/test/migration101.pglite.test.ts 用例⑫ 钉死）。本文件**故意不这样做**。
--
--   理由（DROP TABLE 型迁移与 ADD COLUMN 型迁移的语义不同）：
--     · 不擦账 ⇒ `_migrations` 里仍记着 105_drop_service_desk_agent.sql
--       ⇒ 后续任何一次自动迁移都会判为 `already applied` 而 skip
--       ⇒ **这张被恢复的表不会被二次删掉**。
--       这恰恰是「回退 = 让表回来」想要的结果：擦了账反而会让下一轮部署把表再删一遍，
--       等于回退了个寂寞。
--     · 代价（已知，接受）：将来若改主意要再次推进删表，自动通道**不会重跑** 105，
--       必须由人手工 `sudo -u postgres psql -d youfu -f 105_drop_service_desk_agent.sql`
--       （文件仍在 pending-migrations/ 或已移位后的仓根），不能指望再 `git mv` 回去让它自动跑。
--
--   若日后要改成与 101~104 一致的「先擦账」口径，必须连同上面这条理由一起改，
--   并确认届时「自动通道会重新删表」是想要的行为。
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
