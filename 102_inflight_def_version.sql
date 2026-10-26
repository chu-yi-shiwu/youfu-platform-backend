-- 102_inflight_def_version.sql —— T1-B：给三张在途单物理表加「建单时流程版本」列
--
-- 【为什么必须有这份迁移】
--   T1-B 要回答一个当前答不上来的问题：「这张在途单当时是按哪一版流程建的」。
--   现状（实测）：
--     · def_version 全仓 0 命中（grep -rn "def_version" src --include=*.ts ⇒ 0）⇒ 新增字段，无撞名；
--     · 版本号的另一半早就齐了：workflow_def.version 建表时就有（022:12），
--       且「(tenant_id, entity_type, version) → 完整 def 快照」的映射表
--       workflow_def_history 也已存在、有唯一约束、且 append-only（047:113-126）。
--   ⇒ T1-B 不需要自己存快照，只需要给业务行加一个指向它的 int。
--   本迁移只加列、不改任何既有列、不动任何读路径 ⇒ **与现状逐字节等价，可单独上线**。
--
-- 【🔴 E4：本迁移不改动任何一行既存数据】
--   存量行一律靠 DEFAULT 0 落到哨兵值。0 的语义是「**未记录**」——
--   不是「事实上是第 0 版」，更不是「创建时的当前版本」。
--   任何「把存量填成当时的 version」的写法都是**伪造数据**（总则 E4），本迁移明令禁止：
--   一张 9 月建的巡检单，我们没有任何证据说它是按哪一版 def 建的，
--   拿今天的版本号填进去，就是拿今天猜昨天。
--   宁可留 0，让读取侧降级按 live def 走 —— 那正是今天的行为，逐字节不变。
--   （反之，若填了假值，"降级"这条退路也被堵死了：假值看起来像真值，不会触发降级。）
--
-- 【为什么是 int NOT NULL DEFAULT 0，而不是可空】
--   ① 避免第三态：可空会让每个读取点都要写 row.def_version ?? 0，
--      且「没写」与「写了 0」在运行中不可区分 ⇒ 平白多一个出错面。
--      用哨兵 0，类型系统直接给你 number。
--   ② 与既有函数语义天然对齐：getWorkflowDefVersion（src/engine/workflowDef.ts:514）
--      在租户没有 definition 时**返回 0**（:523 `r.rows[0]?.version ?? 0`）
--      ⇒ 建单点可以直接拿它落值，无需任何特殊分支。
--   ③ 回退安全：有 DEFAULT 0 ⇒ 删列之后能原样加回来
--      （与 101 里 label_dict_tenant.version 用 NOT NULL DEFAULT 1 同款论证）。
--
-- 【为什么排除 work_orders】
--   §6 不动清单（docs/00_现行/任务骨架.md:1027）明列「工单模块本身」不动；
--   且 repo/ticket.ts:201-202 不走 applyEvent，是自己 def.transitions.find({from,to})
--   解析 ⇒ 改造形状与另三张表不同，混在一批违反总则 E6（一次只改一个变量）。
--   工单线留给批 4，需初一拍板。**代价：工单目前只有 T1-A 的 409 硬闸保护，没有版本锁。**
--
-- 【施工踩坑先例（照着 029 的教训写）】
--   029_inspection_updated_at.sql:1-3 记载：路由引用了 updated_at，但 011 没建列
--   ⇒ 潜伏很久才炸。⇒ **本列加上之后，必须同步改 INSERT 语句**
--   （见 T1-B 设计 §5 批 1/2/3 的「盖章」条目），否则就是新造一个 029。
--   批 0 只加列、零调用点，是有意为之：让它能单独上线且风险最低。
--
-- 【与既有加列互不冲突】inspection_task 已有三次加列（029:4 updated_at /
--   040:62 items_json / 048:16 scan_meta）。若 T2 的 data 列或 T0 的 updated_by 列
--   先落地，施工前应先 grep -n "ALTER TABLE inspection_task" *.sql 确认无重复加列。
--
-- 【幂等】ADD COLUMN IF NOT EXISTS，可重复执行；DDL 须以属主执行：
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 102_inflight_def_version.sql

-- ① 巡检任务（011 建表）
ALTER TABLE inspection_task ADD COLUMN IF NOT EXISTS def_version int NOT NULL DEFAULT 0;

-- ② 运送单（034 建表）
ALTER TABLE transport_order ADD COLUMN IF NOT EXISTS def_version int NOT NULL DEFAULT 0;

-- ③ 通用业务流任务（030 建表）：一张表覆盖 transport_task / emergency_plan /
--    cycle_check / energy_collection 等多个 entity_type（030:12 注释），
--    ⇒ 加这一列等于同时覆盖所有通用业务流。
ALTER TABLE business_flow_tasks ADD COLUMN IF NOT EXISTS def_version int NOT NULL DEFAULT 0;
