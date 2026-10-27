-- rollback/104_inflight_def_version_index_down.sql —— 104 的**反向迁移**（成对）
--
-- ⚠️⚠️【为什么这个文件必须放在 rollback/ 子目录，不能放仓库根目录】⚠️⚠️
--   两条自动迁移通道都只扫**仓库根目录**、且都以「数字前缀 + .sql」为筛选条件：
--     · src/db/migrate.ts            → readdirSync(根).filter(f => /^\d+_.*\.sql$/.test(f))
--     · scripts/migrate-as-owner.sh  → ls [0-9][0-9][0-9]_*.sql
--   若本文件以 104_xxx_down.sql 躺在根目录：排序上 '.'(46) < '_'(95) ⇒ 正向先跑、反向紧跟着跑，
--   **刚建好的 4 条索引会被同一次 migrate 立刻删掉**，且 _migrations 还会把它记成"已应用"，
--   下次重跑因已记账而不再补回来 —— 静默失效，最坏的一类回退事故。
--   放进 rollback/ 后：目录名不匹配数字前缀正则 ⇒ 两条通道都看不见它 ⇒ 只有人显式执行才会跑。
--   执行方式（回滚时，以属主身份）—— **就这一条，别加参数**：
--     sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f rollback/104_inflight_def_version_index_down.sql
--
--   ⚠️ 不得叠加 --single-transaction：本文件**自带 BEGIN/COMMIT**，被外层再包一层事务时，
--      事务会在文件内部提前 COMMIT，外层收尾再 COMMIT 就会报 "no transaction in progress"。
--      **回退是事故当下手敲的，最容易被顺手加上这个参数** —— 所以写在这里。
--
--   为什么仍然必须带 -v ON_ERROR_STOP=1：没有它，事务内某条语句失败后 psql 会**继续跑后面的
--   语句**再整体 COMMIT，等于把"部分成功"提交上去；有了它才是"出错即停 + 整体回滚"。
--
-- 【本回退的代价 —— 必须知情】
--   删掉索引**不丢任何数据**：索引是纯派生物，删了只是"版本探测从索引扫退回全表扫"
--   （= 回到 104 之前的行为，功能完全正常，只是慢）。业务数据一行不动。
--   这是本迁移"低风险"的核心理由，也是它敢单独成批上线的原因。
--
-- 【为什么仍然必须擦 _migrations 记账（只删索引不擦账 = 假回退）】
--   两条自动迁移通道都**只记账、从不擦账**：
--     · src/db/migrate.ts:61  if (applied.has(file)) continue      → 已记账就 skip
--     · src/db/migrate.ts:87  INSERT ... ON CONFLICT DO NOTHING    → 只增不删
--     · scripts/migrate-as-owner.sh:22-25  查到 exists=1 就 skip；:40 只 INSERT
--   ⇒ 若本文件只删索引而不擦账，事故链是这样的（**最常见的回退场景：回退 → 修 bug → 重新上线**）：
--       跑本文件（索引删了，但账上 104 仍是"已应用"）
--         → 重新发版 + 跑正向迁移 → 104 因已记账被 skip → 索引不再建回
--         → 功能照常，但性能永久停在"全表扫"，**且没人看得出来**（不报错、不告警）
--   **回退每一步都做对了，重新上线反而留下一个隐性性能坑** —— 比"回退不彻底"更隐蔽。
--   不擦账的回退是**假回退**。
--
-- 【为什么擦账那一条必须排在删索引之前（顺序是硬要求，别调换）】
--   本文件在真实回退里是**手工 psql -v ON_ERROR_STOP=1 -f 执行，不带 --single-transaction**，
--   ⇒ **非原子，中途失败会留半截**。两种排法在正常路径上等价，**只在失败路径上分生死**：
--     ✅ 先擦账后删索引（本文件采用）：失败态 = 「索引还在 + 账已擦」
--        ⇒ 下次 migrate 重跑 104，CREATE INDEX IF NOT EXISTS 幂等 ⇒ 索引补回（本来就在），**可自愈**
--     ❌ 先删索引后擦账：失败态 = 「索引已删 + 账还在」
--        ⇒ 下次 migrate 因已记账 **永久 skip** ⇒ 索引永远回不来 ⇒ 永久全表扫
--   ⇒ 把失败态**落在可自愈的那一侧**。
--
-- 【记账 key 为什么写死这个字符串】两条通道存的都是**文件名**（migrate.ts:87 传 `[file]`、
--   shell :40 传 `'$f'`），不带路径 ⇒ 这一条 DELETE 同时擦掉两个通道的账。
--
-- 【为什么整个文件包在显式事务里】
--   本文件是**手工 psql -v ON_ERROR_STOP=1 -f** 执行的，不带事务就**非原子**——
--   中途失败会留下半截状态。包一层显式 BEGIN/COMMIT ⇒ 要么全成、要么全不成。
--   ⚠️ 事务**不能替代**上面的顺序要求：一旦有人拆开逐条执行，事务这层防线就不存在了，
--   只剩"擦账在删索引之前"。两条都要。
--
-- 【幂等】DELETE 无匹配行即空操作；DROP INDEX IF EXISTS；可重复执行。

BEGIN;

-- ① 先擦账（顺序是硬要求，理由见上）
DELETE FROM _migrations WHERE name = '104_inflight_def_version_index.sql';

-- ② 再删索引
DROP INDEX IF EXISTS idx_work_orders_tenant_defver;
DROP INDEX IF EXISTS idx_transport_order_tenant_defver;
DROP INDEX IF EXISTS idx_business_flow_tasks_tenant_defver;
DROP INDEX IF EXISTS idx_inspection_task_tenant_defver;

COMMIT;

-- 【反向迁移已实跑验证】见 src/test/migration104.pglite.test.ts：
--   真建库 → 应用 104 → 确认 4 条索引都在 → 应用本文件 → 确认索引没了**且 _migrations 里
--   104 的记账也没了** → 再次应用 104 → 确认索引能重新建回来（最后一步才证明"退回去还能再上来"）。
--   写了没跑过的反向迁移不算回退方案（总则 E1 的镜像：事前写了但没验过，同样不算）。
