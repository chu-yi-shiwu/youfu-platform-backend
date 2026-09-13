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

DO $$
DECLARE
  con record;
BEGIN
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

  -- 建命名约束：工单 × 来源 唯一（一单每来源至多一行）
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'settlement_item'::regclass AND conname = 'uq_settlement_item_tenant_wo_source'
  ) THEN
    ALTER TABLE settlement_item
      ADD CONSTRAINT uq_settlement_item_tenant_wo_source UNIQUE (tenant_id, work_order_id, source);
    RAISE NOTICE '084: created constraint uq_settlement_item_tenant_wo_source';
  END IF;
END $$;

-- ============ ③ 修 048 类型错位：inventory_log.work_order_id uuid → text ============
ALTER TABLE inventory_log ALTER COLUMN work_order_id DROP DEFAULT;
ALTER TABLE inventory_log ALTER COLUMN work_order_id TYPE text USING work_order_id::text;

COMMENT ON COLUMN inventory_log.work_order_id IS
  '关联工单业务号（E-9 20260914 由 uuid 改 text）：对齐 work_orders.id（text 业务号）；改前非 uuid 单号走 /inventory/out 会 22P02 → 500';
