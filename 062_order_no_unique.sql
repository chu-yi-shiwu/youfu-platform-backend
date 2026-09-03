-- 062_order_no_unique.sql —— R28-R1-003 修复配套：为业务工单号 order_no 补 DB 级唯一约束，
--   作为应用层强随机生成（crypto 32bit 熵，src/repo/ticket.ts genOrderNo）的最终兜底。
-- 解决：极端情况下应用层生成的 order_no 若重复，将影响查单 / 找回 / 对账的正确性。
--   唯一约束在 DB 层彻底杜绝重复，与 idempotency_key 抢键（R1-001 零 DDL 方案）形成双层防护。
--
-- 【M0-3 幂等化改写（2026-09-02）】原为一次性 DDL，重复执行报 42710 中断迁移链。
--   改为 DROP CONSTRAINT IF EXISTS + ADD 的标准幂等写法：
--   - 未建过 → DROP 静默跳过，ADD 正常建立；
--   - 已建过 → DROP 后重建，最终状态一致，重复执行安全。
--   该写法同时满足 scripts/releaseGate.ts 迁移幂等静态检查白名单（DROP CONSTRAINT IF EXISTS）。
--
-- 部署契约（铁律）：DDL 必须以数据库属主(postgres) 身份执行，youfu_app 无权 ALTER：
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 062_order_no_unique.sql
-- （正常 migrate 脚本以 youfu_app 运行时本文件会因权限失败并跳过，属预期；须用 postgres 手动应用。）
--
-- ⚠ 前置检查：若 live 已存在同一租户内重复 order_no，ADD UNIQUE 会失败。先跑下方 SELECT 核对：
--   SELECT tenant_id, order_no, COUNT(*) AS c
--   FROM work_orders GROUP BY tenant_id, order_no HAVING COUNT(*) > 1;
--   若返回 0 行 → 直接执行；若返回行 → 须人工去重（保留一条、清理其余重复单及其关联事件/嵌入）后再执行，
--   禁止在存在重复时强行建约束，否则迁移会失败并中断后续迁移链。
--
-- 注意：order_no 唯一约束为「(tenant_id, order_no)」复合唯一，跨租户允许相同前缀但同租户内必须唯一，
--   与 RLS 租户隔离模型一致。本约束不改动任何既有列、不回填数据，纯增量加约束。

ALTER TABLE work_orders
  DROP CONSTRAINT IF EXISTS uq_work_orders_tenant_order_no;

ALTER TABLE work_orders
  ADD CONSTRAINT uq_work_orders_tenant_order_no UNIQUE (tenant_id, order_no);
