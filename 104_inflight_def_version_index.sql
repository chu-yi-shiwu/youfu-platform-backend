-- 104_inflight_def_version_index.sql —— T1-B 配套：把「版本探测」从全表扫变成索引扫
--
-- 【为什么要这份迁移】
--   102/103 给四张在途单表加了 `def_version` 列之后，`getDefsAcrossAllVersions`
--   （src/engine/workflowDef.ts:718）每次调用都要跑一条：
--     SELECT DISTINCT def_version FROM <表> WHERE tenant_id = $1 AND def_version > 0
--   这条 SQL 出现在**高频热路径**上：
--     · SLA 扫描 cron —— 每 60 秒 × 逐租户（实测试点库枚举到 2 个租户）；
--     · 工单流转 —— 持行锁（FOR UPDATE）期间；
--     · 各类统计 / 结算入账 / 抢单大厅名单。
--   而**四张表上都没有 (tenant_id, def_version) 索引**（102/103 只 ADD COLUMN，未建索引）——
--   即本文件下面 ①②③④ 四条索引所覆盖的：
--     work_orders（103 加列）/ transport_order（102 加列）
--     / business_flow_tasks（102 加列）/ inspection_task（102 加列）
--   ⇒ 这条查询是逐租户全表扫。单量小的时候无所谓，单量上去后它会成为定时任务的主要开销。
--
-- 【🔴 为什么必须是"部分索引"，不是普通复合索引】
--   存量行**全部是 0**（哨兵，语义是"建单时未记录版本"，见 102:13-19 / 103:14-21 的 E4 论证）。
--   而上面那条查询固定带 `def_version > 0` ⇒ 0 行**永远不会被它命中**。
--   普通复合索引会把 100% 的行（全是 0）都塞进索引：
--     · 索引体积 ≈ 全表行数，白白吃掉内存与备份体积；
--     · 每次 INSERT / UPDATE def_version 都要维护索引 ⇒ 给建单热路径加写放大。
--   加 `WHERE def_version > 0` 之后：
--     · 存量 0 行**一行都不进索引** ⇒ 现在索引几乎是空的；
--     · 只有真正锁了版本的新单才进索引 ⇒ 维护成本随"新单量"增长，不随"历史总量"增长；
--     · 查询条件与索引谓词**逐字一致**（`tenant_id = $1 AND def_version > 0`）
--       ⇒ PG 规划器能直接识别并选用（partial index 只在谓词被证明蕴含时才可用，
--       本例是恒等的，必然可用）。
--
-- 【为什么用 CONCURRENTLY 之外的普通 CREATE INDEX IF NOT EXISTS】
--   CREATE INDEX CONCURRENTLY 不能包在事务里，而 scripts/migrate-as-owner.sh:47-51 对
--   不含 `BEGIN;` 的迁移**固定套一层 --single-transaction** ⇒ 用 CONCURRENTLY 会直接报错。
--   本索引只涉及加索引、不锁表数据字典以外的东西；且建索引期间表仍可读（只阻塞写）。
--   试点库当前量级（实测 97 行）下，建索引耗时可忽略 ⇒ 不引入 CONCURRENTLY 的复杂度。
--   ⚠️ 若将来要在**大表**上补这条索引，需要单独评估：届时要么临时绕开单事务包裹，
--   要么接受短暂的写阻塞窗口。
--
-- 【幂等】CREATE INDEX IF NOT EXISTS，可重复执行；DDL 须以属主执行：
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 104_inflight_def_version_index.sql
--   反向迁移见 rollback/104_inflight_def_version_index_down.sql（已实跑验证）。

-- ① 工单（103 加列）
CREATE INDEX IF NOT EXISTS idx_work_orders_tenant_defver
  ON work_orders (tenant_id, def_version) WHERE def_version > 0;

-- ② 运送单（102 加列）
CREATE INDEX IF NOT EXISTS idx_transport_order_tenant_defver
  ON transport_order (tenant_id, def_version) WHERE def_version > 0;

-- ③ 通用业务流任务（102 加列；一张表覆盖多个 entity_type）
CREATE INDEX IF NOT EXISTS idx_business_flow_tasks_tenant_defver
  ON business_flow_tasks (tenant_id, def_version) WHERE def_version > 0;

-- ④ 巡检任务（102 加列）
CREATE INDEX IF NOT EXISTS idx_inspection_task_tenant_defver
  ON inspection_task (tenant_id, def_version) WHERE def_version > 0;
