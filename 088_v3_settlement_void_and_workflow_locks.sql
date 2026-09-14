-- 088_v3_settlement_void_and_workflow_locks.sql —— V3 机制修复批次（D1/D2/D6 共用部署单元）
--
-- 【设计稿】《优服家_V3_机制修复设计_20260914.md》§7（本文件为其落地版，两处按当前盘面微调：
--   ① CHECK 约束删除改用 DO 块按 conname 前缀动态匹配——071:36 是行内 CHECK，PG 自动命名惯例为
--     settlement_status_check，但历史库若存在同名残留会带 _1 后缀，等值 DROP 会漏删导致 ADD CONSTRAINT 失败；
--   ② 自证段追加 085④-4 哨兵 v2（排除 manual_edited 行）——085 已在 ECS 应用过，属已应用迁移不可回改，
--     哨兵升级查询随 088 固化（语义等价于设计稿 D1 第 5 点）。
--
-- 【内容】
--   ① D1：settlement_item 加 manual_edited boolean NOT NULL DEFAULT false（人工改价保护）；
--   ② D2：settlement 加 voided_by/voided_at/voided_reason/voided_snapshot 四列
--          + status CHECK 放宽为 ('draft','confirmed','voided')（独立成段可单独回退）；
--   ④ D6：workflow_def_change 加 rev int NOT NULL DEFAULT 1（草稿乐观锁）。
--   （D3/D4/D5 无迁移。）
--
-- 【幂等】全部 IF NOT EXISTS / 判存后执行，真库可重复跑。
-- 🔴 谓词纪律（077 铁律）：本文件无任何索引谓词，亦不含 now() 等易变函数（列默认值均为常量）。
-- 【向后兼容】加列默认值对存量行零影响；CHECK 放宽为超集，旧代码对 voided 行可见行为 = 列表多一种状态。
-- 【部署契约】迁移只创建不执行（部署窗口由发布人执行）：
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 088_v3_settlement_void_and_workflow_locks.sql
-- 【回滚】代码回滚后列保留无害；唯一需数据动作的点 = CHECK 段（②-3）：
--   回退 CHECK 前先 UPDATE settlement SET status='confirmed' WHERE status='voided'（设计稿 §8 回滚总表）。

-- ============ ① D1 人工改价保护 ============
ALTER TABLE settlement_item ADD COLUMN IF NOT EXISTS manual_edited boolean NOT NULL DEFAULT false;

-- ============ ② D2 作废路径（四列 + CHECK 放宽） ============
ALTER TABLE settlement ADD COLUMN IF NOT EXISTS voided_by      text;
ALTER TABLE settlement ADD COLUMN IF NOT EXISTS voided_at     timestamptz;
ALTER TABLE settlement ADD COLUMN IF NOT EXISTS voided_reason text;
ALTER TABLE settlement ADD COLUMN IF NOT EXISTS voided_snapshot jsonb;

-- ②-3 CHECK 放宽（独立段，可单独回退）：先删旧两态 CHECK（等值名 + 前缀兜底双保险），再落三态。
ALTER TABLE settlement DROP CONSTRAINT IF EXISTS settlement_status_check;

DO $$
DECLARE
  con record;
BEGIN
  -- 兜底：行内 CHECK 的自动命名可能带同名后缀（settlement_status_check1 等），
  -- 按前缀匹配全部摘除，保证下方 ADD CONSTRAINT 不会因残留同名约束失败。
  FOR con IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'settlement'::regclass
      AND c.contype = 'c'
      AND c.conname LIKE 'settlement_status_check%'
  LOOP
    EXECUTE format('ALTER TABLE settlement DROP CONSTRAINT %I', con.conname);
    RAISE NOTICE '088: dropped residual status check % on settlement', con.conname;
  END LOOP;
END $$;

ALTER TABLE settlement ADD CONSTRAINT settlement_status_check
  CHECK (status IN ('draft', 'confirmed', 'voided'));

-- ============ ④ D6 草稿乐观锁 ============
ALTER TABLE workflow_def_change ADD COLUMN IF NOT EXISTS rev int NOT NULL DEFAULT 1;

-- ============ 自证段（部署窗口执行并回贴输出，同 085④ 惯例；本地不执行） ============
\echo '--- 088 自证：三组新列就位 + CHECK 三态 ---'
SELECT column_name, data_type, column_default FROM information_schema.columns
 WHERE table_name IN ('settlement_item','settlement','workflow_def_change')
   AND column_name IN ('manual_edited','voided_by','voided_at','voided_reason','voided_snapshot','rev')
 ORDER BY table_name, column_name;
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conrelid = 'settlement'::regclass AND conname = 'settlement_status_check';

-- 085④-4 哨兵 v2（V3-D1 升级：排除 manual_edited 行——人工行与事实源的"不一致"是语义内的，不告警。
--   原 085④-4 保持原样不动（已应用迁移不可回改）；本查询在 088 部署后取代其巡检口径。期望 0 行。）
\echo '--- 088 哨兵 v2：material 行 qty 与事实源聚合不一致（排除 manual_edited，期望 0 行）---'
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
  AND NOT si.manual_edited
  AND si.qty <> COALESCE(lg.out_qty, 0)
ORDER BY si.work_order_id, si.material_id
LIMIT 50;
