-- 113_evaluated_score_check.sql —— 评价态必须有分数（数据完整性兜底）。
--
-- 背景：025 只给 satisfaction_score 加了 0-5 的区间 CHECK，但允许 NULL；
--       evaluated 状态如果因历史数据/自定义流程缺分数，工作台与统计会把「已评价」
--       与「未评分」混在一起（data_quality.evaluated_missing_score 长期非 0）。
--
-- 本迁移：
--   1) 把「已评价但无分数」的历史行还原为 completed（不伪造分数，语义诚实）；
--   2) 增加 DB CHECK：evaluated 状态必须带 satisfaction_score。
--
-- 执行：sudo -u postgres psql -d <db> -v ON_ERROR_STOP=1 -f 113_evaluated_score_check.sql

-- 1) 历史脏数据：无分数的 evaluated 不是真评价，退回完成态。
UPDATE work_orders
SET status = 'completed',
    updated_at = now()
WHERE status = 'evaluated'
  AND satisfaction_score IS NULL;

-- 2) 约束：先查约束是否存在，再添加，保证可重复执行。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'work_orders_evaluated_score_chk'
      AND conrelid = 'work_orders'::regclass
  ) THEN
    ALTER TABLE work_orders
      ADD CONSTRAINT work_orders_evaluated_score_chk
      CHECK (status <> 'evaluated' OR satisfaction_score IS NOT NULL);
  END IF;
END $$;

COMMENT ON CONSTRAINT work_orders_evaluated_score_chk ON work_orders IS
  '已评价状态必须带满意度分数（防止 evaluated 与未评分混用）';
