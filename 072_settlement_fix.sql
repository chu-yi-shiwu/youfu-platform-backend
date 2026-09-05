-- 072_settlement_fix.sql —— 注册制批次三 卡4 结算三凭证：上线前修正（审查修复 A 路）
--
-- 背景：071 三表刚建、生产零数据，故本迁移按「建表即终态」的修正版写（不做增量数据搬迁）。
-- 三件事（分节注释）：
--   (a) settlement_item 唯一约束改 UNIQUE (tenant_id, work_order_id)——
--       071 的全局 UNIQUE(work_order_id) 未带 tenant_id，与全库「一切多租户表均按 tenant_id 隔离」
--       口径不一致（RLS 已隔离但约束层未兜底）；本约束才是"一单终身一结算"的正确粒度。
--   (b) settlement 增列 created_by text——结算单创建人留痕（应用侧此前把 operator 参数丢弃）。
--   (c) settlement 补索引 idx_settlement_tenant_created (tenant_id, created_at DESC)——
--       列表主查询 ORDER BY created_at DESC，此前只有 (tenant_id,status) 命中不了排序。
--
-- 幂等：全部 IF NOT EXISTS / DO 动态判存；可重复执行，收敛到同一终态。
-- 部署契约：DDL 须用 superuser 身份执行（与 060/070/071 一致）：
--   sudo -u postgres psql youfu -v ON_ERROR_STOP=1 -f 072_settlement_fix.sql

-- ============ (a) settlement_item 唯一约束：UNIQUE(work_order_id) → UNIQUE(tenant_id, work_order_id) ============
DO $$
DECLARE
  con record;
  row_count bigint;
BEGIN
  -- 安全阀：表非空时拒绝执行——约束从"全局唯一"收窄为"租户内唯一"本身不会丢数据，
  -- 但若表中已存在跨租户同 work_order_id 的行，收窄后仍合法；反之若曾有过非法脏数据，
  -- 去重会静默丢行。故先断言 0 行（071 刚建、生产零数据，满足即放行）。
  EXECUTE 'SELECT COUNT(*) FROM settlement_item' INTO row_count;
  IF row_count > 0 THEN
    RAISE EXCEPTION 'settlement_item 已有 % 行数据，拒绝自动改约束（需人工核对去重后再执行）', row_count;
  END IF;

  -- 删掉 071 建的全局唯一约束（含 071 命名约束与 PG 自动生成的同名约束，一律按列集匹配删除）
  FOR con IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'settlement_item'::regclass
      AND c.contype = 'u'
      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute
                            WHERE attrelid = 'settlement_item'::regclass AND attname = 'work_order_id')]::smallint[]
  LOOP
    EXECUTE format('ALTER TABLE settlement_item DROP CONSTRAINT %I', con.conname);
    RAISE NOTICE 'dropped unique constraint % on settlement_item', con.conname;
  END LOOP;

  -- 建命名约束：租户内一单终身一结算
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'settlement_item'::regclass AND conname = 'uq_settlement_item_tenant_work_order'
  ) THEN
    ALTER TABLE settlement_item
      ADD CONSTRAINT uq_settlement_item_tenant_work_order UNIQUE (tenant_id, work_order_id);
    RAISE NOTICE 'created constraint uq_settlement_item_tenant_work_order';
  END IF;
END $$;

-- ============ (b) settlement 增列 created_by（创建人留痕，可空兼容存量行） ============
ALTER TABLE settlement ADD COLUMN IF NOT EXISTS created_by text;
COMMENT ON COLUMN settlement.created_by IS '结算单创建人（账号名/用户名），072 增列；可空兼容 071 期间的历史行';

-- ============ (c) 列表排序索引 ============
CREATE INDEX IF NOT EXISTS idx_settlement_tenant_created
  ON settlement (tenant_id, created_at DESC);
