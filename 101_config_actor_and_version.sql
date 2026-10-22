-- 101_config_actor_and_version.sql —— T0：配置变更「留变更人 + 条件更新防竞态」的地基
--
-- 【为什么必须有这份迁移】
--   T0 要回答两个当前答不上来的问题：「这行配置现在是谁改的」「我这次改是基于哪个版本」。
--   现状（实测）：
--     · updated_by 列全仓只存在于 097 platform_config 一张表，其余配置表一个都没有；
--     · workflow_def.version 早就存在（022），但没有任何写语句拿它当条件；
--     · label_dict_tenant（098）连 version 列都没有 ⇒ 字典类配置根本没有并发锚可用。
--   本迁移补齐 3 表 4 列，只加列、不改任何既有列、不动任何读路径。
--
-- 【为什么是 ALTER 而不是回去改 022/010/098 的 CREATE TABLE】
--   已部署迁移由 _migrations 表**按文件名**追踪（src/db/migrate.ts），改已应用过的文件内容
--   在部署库上就是 no-op —— 库里不会有这个列，而代码会以为有。向后兼容的唯一正确做法是新增迁移。
--
-- 【为什么列一律可空 / 有默认值】
--   T0 的回退方案是「git revert 代码提交 + 反向迁移 DROP COLUMN」（见同序号 _down.sql）。
--   DROP COLUMN 只在列可空 / 有默认值时才谈得上安全（NOT NULL 无默认值的列加不回去、
--   删了也回不到"删之前"的语义）。**这四个列的"可空/有默认值"不是随手写的，是回退能成立的前提。**
--   version 用 NOT NULL DEFAULT 1：新列必须有值，否则并发锚读到 NULL 根本没法比；
--   存量行一律补 1（与 workflow_def 的初始版本口径一致）。
--
-- 【幂等】ADD COLUMN IF NOT EXISTS，可重复执行；DDL 须以属主执行：
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 101_config_actor_and_version.sql

-- ① 流程定义（022 建表）：补变更人。version 建表时已有，无需补。
ALTER TABLE workflow_def ADD COLUMN IF NOT EXISTS updated_by text;

-- ② 租户级系统配置（010 建表，品牌名/热线/开关）：补变更人。
--    本表无版本列，T0 也不给它加并发锚（不是流程配置，写冲突面小、且是单 key upsert）。
ALTER TABLE system_config ADD COLUMN IF NOT EXISTS updated_by text;

-- ③ 租户展示标签覆盖（098 建表）：补变更人 + 版本号（并发锚）。
--    version 是 T0 条件更新的物理载体：PUT /meta/labels/me 的 UPSERT 要能写
--    `WHERE label_dict_tenant.version = $n`，没有这列就只能在应用层做 check-then-act
--    （先 SELECT 再 UPDATE，两条语句，并发下仍可穿——正是 T0 要消灭的东西）。
ALTER TABLE label_dict_tenant ADD COLUMN IF NOT EXISTS updated_by text;
ALTER TABLE label_dict_tenant ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1;

-- 【回滚】执行同序号的反向迁移（**在 rollback/ 子目录，不在本目录**）：
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f rollback/101_config_actor_and_version_down.sql
--（DROP 本次新增的 4 列 + 擦掉 _migrations 里本文件的记账；不动任何既有列/数据行的其它字段）
--  ⚠️ 擦账那一步不是可选的：只删列不擦账 ⇒ 重新上线时本文件被 skip ⇒ 4 列加不回来 ⇒ 假回退。
--     顺序也是硬要求（先擦账、后删列），理由写在 down 文件头。
--
-- ⚠️ 反向迁移**不能**放在本文件所在的根目录：两条自动迁移通道都只扫根目录、且都以
--   "数字前缀 + .sql"为筛选条件（src/db/migrate.ts 的 /^\d+_.*\.sql$/、
--   scripts/migrate-as-owner.sh 的 ls [0-9][0-9][0-9]_*.sql）。放在根目录 ⇒ 排序上
--   '.'(46) < '_'(95) ⇒ 正向先跑、反向紧跟着跑，刚加的 4 列在同一次 migrate 里被删掉，
--   且被记账为"已应用"、下次重跑不再补回 —— 静默失效。该约束由
--   src/test/migration101.pglite.test.ts 的 ⑨⑩ 两条用例钉死。
