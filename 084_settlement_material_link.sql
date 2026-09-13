-- 084_settlement_material_link.sql —— E-9 批次：自动结算（BUG-004）× 耗材二级库存 交汇点。
--
-- 本迁移**零新建表**（二级库存底座 material/inventory/inventory_log 见 015/016/048 已存在），只做三件结构性补齐：
--   ① settlement_item 增 source / material_id：
--        结算明细可区分「服务价目行（service）」与「工单耗材行（material）」——
--        自动结算把工单耗材费追加为独立明细行（source='material'，material_id 指回耗材档案）。
--   ② settlement_item 唯一约束放宽：UNIQUE(tenant_id, work_order_id) → UNIQUE(tenant_id, work_order_id, source)。
--        原因（E-9 设计实施必要修正，已回报）：耗材行与服务行**同属一张工单**，若沿用 072 的两列唯一约束，
--        同一工单的第二行明细必然 23505——设计稿「价目预填行 + 追加耗材行」在 072 约束下不可实施。
--        放宽后语义：一张工单在同一结算单内最多 1 条服务行 + 1 条耗材行；
--        「一单终身一结算」由 source='service' 行继续承载，且入口预检（createSettlementDraft 的 settledSet /
--        autoCreateSettlementForOrder 预检）**按工单整体**防重，与 source 无关——防重强度不降级。
--   ③ inventory_log.work_order_id 列类型 uuid → text（**随批修既有 bug**）：
--        work_orders.id 是 text 业务号（001_init.sql:25），048 却把该列建成 uuid →
--        /inventory/out 传非 uuid 形态业务号时 INSERT 直接 22P02 → 500（"材料挂工单出库"实际不可用）。
--
-- 幂等：全部判存 / 可重复执行；②③ 均为**放宽**方向（不丢行、不改业务数据），对存量行零风险。
-- 部署契约：DDL 须以数据库属主（ECS 上 postgres）执行：
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 084_settlement_material_link.sql
-- 锁窗口：③ 的 ALTER TYPE 需 ACCESS EXCLUSIVE 锁；inventory_log 增量小，秒级完成。
-- 🔴索引谓词纪律：仅 IMMUTABLE 表达式（= / IS NOT NULL），本文件不含 now()。
-- RLS/GRANT：settlement_item（071/072 策略）与 inventory_log（016 策略/GRANT）均沿用既有，
--   新列随行级策略与表级授权自动生效，无需新增策略行。

-- ⚠️ 行粒度权威（E-9 20260914 修正）：settlement_item 唯一性的**权威**自 085 起是「行粒度」部分唯一索引
--    （uq_sti_service / uq_sti_material，见 085_settlement_material_row_grain.sql）。本文件（084）② 段
--    所建的 3 列约束在 085 之后即被 DROP，故 084 的职责降级为「兼容历史库：补列 / 补索引 / 修类型」。
--    ② 段带**重入守卫**：085 已接管、或存量数据已是行粒度形态（同工单同来源 ≥2 行）→ 整段跳过，
--    保证 084 在任意既有形态下重放恒 exit 0（QA-2 真库复现 exit 3 的修复，详见 ② 段注释）。

-- ============ 修订声明（2026-09-14，首次推送前修订）============
-- 【修订时点】本文件于 2026-09-14 在**首次推送前**修订：当时本文件尚未推送（远端 main 仍停在
--   历史 tip，见仓库远端状态），亦**尚未在任何生效环境应用**。迁移"只前进不回改"保护的是已生效环境，
--   本文件不属该范畴，故就地修订而非另起 087（087 在序上晚于 084，无法阻止 084 自身重放失败）。
-- 【修订内容】两处，均只改 ② 段，不改任何 DDL 语义方向：
--   1) DO 段新增两道重入守卫（见 ② 段：守卫1 = 085 已接管则跳过；守卫2 = 存量数据已是行粒度则跳过）；
--   2) DO 段定界符 `$$` → `$g$`（避免与守卫注释/其它块混读，纯可读性）。
-- 【修订动机（QA-2 真库复现）】085 落地后重放 084：在"同工单 ≥2 种耗材"（085 明确允许的常规形态）下，
--   建 3 列唯一约束必撞唯一性 → `ERROR: could not create unique index ... DETAIL: (...) is duplicated`；
--   且本文件**非单事务**，脚本会在中途 exit 3 并留下部分生效的中间态。守卫使重放恒 exit 0。
-- 【漂移声明】dev / 验证库可能已执行过**无守卫版** 084；带守卫版是它的**安全超集**——不改数据、
--   不放宽任何语义，重放行为一致（已应用场景下打印 NOTICE 并跳过 ② 段）。两者可安全混用。

-- ============ ① 结算明细来源标记 + 耗材关联 ============
ALTER TABLE settlement_item ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'service';
ALTER TABLE settlement_item ADD COLUMN IF NOT EXISTS material_id uuid;

COMMENT ON COLUMN settlement_item.source IS
  '明细来源（E-9 20260914）：service=服务价目行（默认，兼容 071 存量行）/ material=工单耗材行；参与 UNIQUE(tenant_id,work_order_id,source)';
COMMENT ON COLUMN settlement_item.material_id IS
  '耗材档案 id（E-9 20260914）：source=material 时指向 material.id，服务行为 NULL。故意不加外键——耗材档案删除不应被结算历史牵制，单价/数量已在 price/qty 落行为快照';

CREATE INDEX IF NOT EXISTS idx_sti_wo_source
  ON settlement_item (tenant_id, work_order_id, source)
  WHERE source = 'material';

-- ============ ② 唯一约束放宽：UNIQUE(tenant_id, work_order_id) → UNIQUE(tenant_id, work_order_id, source) ============
-- 先显式摘除 072 的命名旧约束（E-9 批复审要求：旧约束处理必须显式可读，不藏在列集匹配里）。
-- 幂等：IF EXISTS；若该约束不存在（理论上不可能，072 必建）则跳过，不影响后续兜底。
ALTER TABLE settlement_item DROP CONSTRAINT IF EXISTS uq_settlement_item_tenant_work_order;

DO $g$
DECLARE
  con record;
BEGIN
  -- ── 重入守卫 1：085 已接管（其行粒度部分唯一索引已存在）──
  -- 此时行粒度权威归 085，本段若再建 3 列约束，会在「同工单 ≥2 种耗材」（085 明确允许的常规形态）
  -- 上直接炸：ERROR: could not create unique index "uq_settlement_item_tenant_wo_source"
  --          DETAIL: (...) is duplicated  → 脚本 exit 3，且本文件非单事务，留下部分生效中间态。
  -- 判定 SQL：pg_indexes 里存在 uq_sti_service（085 首建的第 1 条部分唯一索引）。
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname = 'uq_sti_service'
  ) THEN
    RAISE NOTICE '084: skip uq_settlement_item_tenant_wo_source (superseded by 085 row-grain uq_sti_service/uq_sti_material)';
    RETURN;
  END IF;

  -- 兜底：再按列集摘除「恰好只含 (tenant_id, work_order_id) 两列」的残余唯一约束
  -- （覆盖 071 自动命名形态 / 手工建库等命名不一致场景，列集匹配不写死名字）
  FOR con IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'settlement_item'::regclass
      AND c.contype = 'u'
      AND array_length(c.conkey, 1) = 2
      AND c.conkey @> ARRAY[
            (SELECT attnum FROM pg_attribute WHERE attrelid = 'settlement_item'::regclass AND attname = 'tenant_id'),
            (SELECT attnum FROM pg_attribute WHERE attrelid = 'settlement_item'::regclass AND attname = 'work_order_id')
          ]::smallint[]
  LOOP
    EXECUTE format('ALTER TABLE settlement_item DROP CONSTRAINT %I', con.conname);
    RAISE NOTICE '084: dropped unique constraint % on settlement_item (tenant_id, work_order_id)', con.conname;
  END LOOP;

  -- ── 重入守卫 2：存量数据已是行粒度形态（同 (tenant_id, work_order_id, source) ≥2 行）──
  -- 085 尚未跑、但库中已存在多耗材行的历史库：建 3 列约束必撞唯一性 → 跳过并显式告知，
  -- 保持 084 重放 exit 0（这类库应补跑 085 把行粒度接管过去）。
  -- 判定 SQL：SELECT 1 FROM settlement_item GROUP BY tenant_id, work_order_id, source HAVING COUNT(*) > 1
  IF EXISTS (
    SELECT 1 FROM settlement_item
    GROUP BY tenant_id, work_order_id, source
    HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE '084: skip uq_settlement_item_tenant_wo_source (existing rows already exceed 3-col uniqueness = row-grain data; apply 085 to take over)';
    RETURN;
  END IF;

  -- 建命名约束：工单 × 来源 唯一（一单每来源至多一行）
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'settlement_item'::regclass AND conname = 'uq_settlement_item_tenant_wo_source'
  ) THEN
    ALTER TABLE settlement_item
      ADD CONSTRAINT uq_settlement_item_tenant_wo_source UNIQUE (tenant_id, work_order_id, source);
    RAISE NOTICE '084: created constraint uq_settlement_item_tenant_wo_source';
  END IF;
END $g$;

-- ============ ③ 修 048 类型错位：inventory_log.work_order_id uuid → text ============
ALTER TABLE inventory_log ALTER COLUMN work_order_id DROP DEFAULT;
ALTER TABLE inventory_log ALTER COLUMN work_order_id TYPE text USING work_order_id::text;

COMMENT ON COLUMN inventory_log.work_order_id IS
  '关联工单业务号（E-9 20260914 由 uuid 改 text）：对齐 work_orders.id（text 业务号）；改前非 uuid 单号走 /inventory/out 会 22P02 → 500';
