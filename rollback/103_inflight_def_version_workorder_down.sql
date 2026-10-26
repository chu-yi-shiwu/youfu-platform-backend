-- rollback/103_inflight_def_version_workorder_down.sql —— T1-B 批4 的**反向迁移**
--   （与 103_inflight_def_version_workorder.sql 成对）
--
-- ⚠️⚠️【为什么这个文件必须放在 rollback/ 子目录，不能放仓库根目录】⚠️⚠️
--   两条自动迁移通道都只扫**仓库根目录**、且都以「数字前缀 + .sql」为筛选条件：
--     · src/db/migrate.ts            → readdirSync(根).filter(f => /^\d+_.*\.sql$/.test(f))
--     · scripts/migrate-as-owner.sh  → ls [0-9][0-9][0-9]_*.sql
--   若本文件以 103_xxx_down.sql 躺在根目录：排序上 '.'(46) < '_'(95) ⇒ 正向先跑、反向紧跟着跑，
--   **刚加上去的列会被同一次 migrate 立刻删掉**，且 _migrations 还会把它记成"已应用"，
--   下次重跑因已记账而不再补回来 —— 静默失效，最坏的一类回退事故。
--   放进 rollback/ 后：目录名不匹配数字前缀正则 ⇒ 两条通道都看不见它 ⇒ 只有人显式执行才会跑。
--   执行方式（回滚时，以属主身份）—— **就这一条，别加参数**：
--     sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f rollback/103_inflight_def_version_workorder_down.sql
--
--   ⚠️ 不得叠加 --single-transaction：本文件**自带 BEGIN/COMMIT**，被外层再包一层事务时，
--      事务会在文件内部提前 COMMIT，外层收尾再 COMMIT 就会报 "no transaction in progress"。
--      **回退是事故当下手敲的，最容易被顺手加上这个参数** —— 所以写在这里。
--
--   为什么仍然必须带 -v ON_ERROR_STOP=1：没有它，事务内某条语句失败后 psql 会**继续跑后面的
--   语句**再整体 COMMIT，等于把"部分成功"提交上去；有了它才是"出错即停 + 整体回滚"。
--
-- 【为什么必须单独提供反向迁移】
--   T1-B 批 4 的回退 = ① git revert 代码提交 + ② 本文件删列。
--   **git revert 掉不掉加列**：revert 只回滚代码，已执行的 ALTER TABLE 留在库里，
--   且 _migrations 里 103 已被记为已应用 ⇒ 重跑 migrate 也不会自动撤掉。
--   只 revert 不跑本文件 = 代码回退了、库里多一列，属于"回退不彻底"。
--
-- 【代价（必须知情）】删列会丢掉这列上已积累的版本号：work_orders.def_version
--   —— 这是**有意**的：回退到 T1-B 批 4 之前，本来就没有这些事实。业务数据一行不动。
--   且按 E4，存量行本来全是 0（未记录），丢掉的只是"未记录"这个状态本身 ⇒ 几乎无损。
--
-- 【🔴 代码层回退是自含的，本文件可延后执行】
--   读取函数采用「读不到版本 ⇒ 降级到 live def + console.warn」（T1-B 设计 §4.3、R-6），
--   ⇒ **即使本文件一条不跑，代码 revert 之后行为也回到今天**。
--   这是刻意的设计收益：def_version 是读取时的**输入**，不是写入时的**目标列**，
--   所以本迁移的回退不必须与代码回退原子绑定（比 T0 那种「列不在就直接 42703 ⇒ 500」软得多）。
--   ⇒ 事故当下的正确顺序：**先回代码 → 本文件可延后**（列在而代码旧 = 完全无害）。
--
-- 【为什么必须擦 _migrations 记账（只删列不擦账 = 假回退）】
--   两条自动迁移通道都**只记账、从不擦账**：
--     · src/db/migrate.ts:61  if (applied.has(file)) continue      → 已记账就 skip
--     · src/db/migrate.ts:87  INSERT ... ON CONFLICT DO NOTHING    → 只增不删
--     · scripts/migrate-as-owner.sh:22-25  查到 exists=1 就 skip；:40 只 INSERT
--   ⇒ 若本文件只删列而不擦账，事故链是这样的（**最常见的回退场景：回退 → 修 bug → 重新上线**）：
--       跑本文件（列被删，但账上 103 仍是"已应用"）
--         → 重新发版 + 跑正向迁移 → 103 因已记账被 skip → 列不再加回
--         → 批 4 的代码 INSERT ... def_version ⇒ 42703 ⇒ 500
--   **回退每一步都做对了，重新上线反而炸** —— 比"回退不彻底"更隐蔽，
--   因为它发生在"已经成功回退之后"。不擦账的回退是**假回退**。
--
-- 【为什么擦账那一条必须排在删列之前（顺序是硬要求，别调换）】
--   本文件在真实回退里是**手工 psql -v ON_ERROR_STOP=1 -f 执行，不带 --single-transaction**
--   （migrate-as-owner.sh:38 那个单事务只包正向迁移），⇒ **非原子，中途失败会留半截**。
--   两种排法在正常路径上等价，**只在失败路径上分生死**：
--     ✅ 先擦账后删列（本文件采用）：失败态 = 「列还在 + 账已擦」
--        ⇒ 下次 migrate 重跑 103，ADD COLUMN IF NOT EXISTS 幂等 ⇒ 列加回来（本来就在），**可自愈**
--     ❌ 先删列后擦账：失败态 = 「列已删 + 账还在」
--        ⇒ 下次 migrate 因已记账 **永久 skip** ⇒ 列永远回不来 ⇒ 42703 ⇒ 500
--   ⇒ 把失败态**落在可自愈的那一侧**。
--
-- 【记账 key 为什么写死这个字符串】两条通道存的都是**文件名**（migrate.ts:87 传 `[file]`、
--   shell :40 传 `'$f'`），不带路径 ⇒ 这一条 DELETE 同时擦掉两个通道的账。
--
-- 【为什么整个文件包在显式事务里】
--   本文件是**手工 psql -v ON_ERROR_STOP=1 -f** 执行的，不带事务就**非原子**——
--   中途失败会留下半截状态。包一层显式 BEGIN/COMMIT ⇒ 要么全成、要么全不成。
--
--   ⚠️ 事务**不能替代**上面的顺序要求：down 文件是给人手敲的，不能假设它总被整文件执行——
--   一旦有人拆开逐条执行，事务这层防线就不存在了，只剩"擦账在删列之前"。两条都要。
--
-- 【幂等】DELETE 无匹配行即空操作；DROP COLUMN IF EXISTS；可重复执行。

BEGIN;

-- ① 先擦账（顺序是硬要求，理由见上）
DELETE FROM _migrations WHERE name = '103_inflight_def_version_workorder.sql';

-- ② 再删列
ALTER TABLE work_orders DROP COLUMN IF EXISTS def_version;

COMMIT;

-- 【本文件尚未实跑验证】102 的反向迁移有 src/test/migration102.pglite.test.ts 实跑守着；
--   本文件对应的 pglite 验证测试由批 4 的验收方补（不属本批产品代码改动范围）。
--   写了没跑过的反向迁移不算回退方案（总则 E1 的镜像：事前写了但没验过，同样不算）
--   ⇒ 上线前必须补 migration103.pglite.test.ts 走完「应用 103 → 确认列在 →
--     应用本文件 → 确认列没了且记账也没了 → 再应用 103 → 确认列能加回来」这条闭环。
