-- 085_settlement_material_row_grain.sql —— E-9 §13 裁决1：按来源拆分 084 的三列唯一约束。
--
-- 【命名变更留痕】本文件初版名为 085_settlement_item_unique_split.sql，收口时按架构师文档
--   §13 的登记名改名（架构师文档为单一事实源，编号 085 不变；内容未变，仅文件名对齐）。
--
-- 【为什么需要它（架构师 §13 发现 3，P1）】
--   084 的 UNIQUE(tenant_id, work_order_id, source) 语义是「一单每来源至多一行」，
--   与耗材联动「每耗材一行」的行模型冲突：工单消耗 ≥2 种耗材时，
--   appendMaterialCostItems/syncMaterialCostRows 的第二条 material 行必然 23505 →
--   被 repo/settlement.ts 的 catch 误报 409 → 自动结算路径冒泡 → SAVEPOINT 回滚 → 结算单不创建。
--   单耗材工单不触发，故 mock 层此前全绿（漏测形态）。
--
-- 【本迁移做什么（迁移只前进：不改 084，已执行过 084 的库让它留着）】
--   ① 摘除 084 的三列唯一约束 uq_settlement_item_tenant_wo_source（显式名 + 列集兜底双保险）；
--   ② 建 uq_sti_service ：UNIQUE(tenant_id, work_order_id)            WHERE source='service'
--      —— 承载「一单终身一结算」（072 原两列约束的业务语义由部分唯一索引续命）；
--   ③ 建 uq_sti_material：UNIQUE(tenant_id, work_order_id, material_id) WHERE source='material'
--      —— syncMaterialCostRows 按 (工单,耗材) UPSERT 的目标冲突键（全量重投影幂等的 DB 兜底）。
--
-- 【幂等】全部 IF EXISTS / IF NOT EXISTS / 判存后执行，真库可重复跑。
-- 【数据安全】084 下每 (tenant,wo,source) 至多一行 ⇒ 拆分后的两个部分唯一索引对存量行必然满足，不会建索引失败。
-- 【留痕口径】§13 要求删除的 material_cost_appended 事件与 settlement_item.updated_at 列经查证
--   本仓从未落地（071 的 updated_at 在 settlement 表头；072/084 均未给 settlement_item 加列），
--   无 DDL 可做——留痕改由「重投影即最新事实」零成本承载，不新增事件/列。
--
-- 部署契约：以数据库属主执行（与 084 同）：
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 085_settlement_material_row_grain.sql
-- 🔴索引谓词纪律：谓词仅 `source = 'text 字面量'`（IMMUTABLE），本文件不含任何易变时间函数（077 铁律）。
-- RLS/GRANT：只动索引/约束，不动行级策略与表级授权。

-- ============ ① 摘除 084 三列唯一约束 ============
ALTER TABLE settlement_item DROP CONSTRAINT IF EXISTS uq_settlement_item_tenant_wo_source;

DO $$
DECLARE
  con record;
BEGIN
  -- 兜底：按「恰含 (tenant_id, work_order_id, source) 三列」的唯一约束列集匹配摘残余
  --（覆盖 084 命名差异 / 手工建库场景，不写死约束名）
  FOR con IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'settlement_item'::regclass
      AND c.contype = 'u'
      AND array_length(c.conkey, 1) = 3
      AND c.conkey @> ARRAY[
            (SELECT attnum FROM pg_attribute WHERE attrelid = 'settlement_item'::regclass AND attname = 'tenant_id'),
            (SELECT attnum FROM pg_attribute WHERE attrelid = 'settlement_item'::regclass AND attname = 'work_order_id'),
            (SELECT attnum FROM pg_attribute WHERE attrelid = 'settlement_item'::regclass AND attname = 'source')
          ]::smallint[]
  LOOP
    EXECUTE format('ALTER TABLE settlement_item DROP CONSTRAINT %I', con.conname);
    RAISE NOTICE '085: dropped residual 3-col unique % on settlement_item', con.conname;
  END LOOP;
END $$;

-- ============ ②③ 按来源拆分的部分唯一索引 ============
CREATE UNIQUE INDEX IF NOT EXISTS uq_sti_service
  ON settlement_item (tenant_id, work_order_id)
  WHERE source = 'service';

CREATE UNIQUE INDEX IF NOT EXISTS uq_sti_material
  ON settlement_item (tenant_id, work_order_id, material_id)
  WHERE source = 'material';

COMMENT ON INDEX uq_sti_service IS
  'E-9 §13（085）：一单终身一结算——source=service 行每工单至多一条（接续 072 两列唯一约束语义）';
COMMENT ON INDEX uq_sti_material IS
  'E-9 §13（085）：耗材行每 (工单,耗材) 至多一条——syncMaterialCostRows 全量重投影 UPSERT 的冲突目标键';

-- ============ ④ 真库自证（部署窗口执行；本地无 PG 凭据 → 挂账，见回执）============
-- 说明：本地 PG 15 为 scram-sha-256 强制密码，且无 .pgpass / .env / PG* 变量，
--   本机无法连真库 → 以下自证 SQL 随迁移固化，在**部署窗口以属主身份执行**并回贴原始输出；
--   绝不用 mock 冒充真库（本文件不含任何测试替身逻辑，只有可执行 SQL）。

-- 085④-1 索引存在性：两条部分唯一索引必须各 1 行（且索引定义与谓词逐字匹配）
\echo '--- 085④-1 部分唯一索引存在性（期望 2 行：uq_sti_service / uq_sti_material）---'
SELECT i.indexname AS index_name,
       i.indexdef   AS index_def
FROM pg_indexes i
WHERE i.schemaname = current_schema()
  AND i.tablename = 'settlement_item'
  AND i.indexname IN ('uq_sti_service', 'uq_sti_material')
ORDER BY i.indexname;

-- 085④-2 三列唯一约束残留检查：必须 0 行（084 的 uq_settlement_item_tenant_wo_source 已被摘除）
\echo '--- 085④-2 残留三列唯一约束（期望 0 行）---'
SELECT c.conname AS residual_unique_3col
FROM pg_constraint c
WHERE c.conrelid = 'settlement_item'::regclass
  AND c.contype = 'u'
  AND array_length(c.conkey, 1) = 3
ORDER BY c.conname;

-- 085④-3 行粒度实证（真库真撞）：先看该约束是否真的按来源拆档——
--   同工单两种耗材应能共存（≥2 行），而 service 行每工单至多 1 行。
\echo '--- 085④-3 行粒度实证：material 行多耗材共存 / service 行每单至多一条 ---'
SELECT si.work_order_id,
       COUNT(*) FILTER (WHERE si.source = 'material') AS material_rows,
       COUNT(*) FILTER (WHERE si.source = 'service')  AS service_rows
FROM settlement_item si
GROUP BY si.work_order_id
ORDER BY material_rows DESC, si.work_order_id
LIMIT 20;

-- 085④-4 哨兵巡检（§14 复议1 ⑩）：结算单 material 行的 qty 必须等于 inventory_log 的 out 聚合
--   （不一致 = 重投影漏同步/多同步；期望 0 行）
\echo '--- 085④-4 哨兵：material 行 qty 与事实源聚合不一致（期望 0 行）---'
SELECT si.tenant_id,
       si.settlement_id,
       si.work_order_id,
       si.material_id,
       si.qty                                   AS row_qty,
       COALESCE(lg.out_qty, 0)                  AS log_qty
FROM settlement_item si
LEFT JOIN LATERAL (
  SELECT SUM(il.qty)::numeric(12,2) AS out_qty
  FROM inventory_log il
  WHERE il.tenant_id = si.tenant_id
    AND il.work_order_id = si.work_order_id
    AND il.material_id = si.material_id
    AND il.type = 'out'
) lg ON true
WHERE si.source = 'material'
  AND si.qty <> COALESCE(lg.out_qty, 0)
ORDER BY si.work_order_id, si.material_id
LIMIT 50;

