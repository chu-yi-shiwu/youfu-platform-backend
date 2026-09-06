-- ============================================================================
-- uone_knowledge 去重预检（只读 dry-run，2026-09-06）
-- ============================================================================
-- ⚠️ 本脚本【不修改任何数据】，纯 SELECT，可随时安全执行。
--   仍建议以 postgres 超管执行（youfu_app 在 RLS 下可能读不全/读不到该表，
--   统计口径会失真）。
-- 用途：上线前确认 uone_knowledge_dedup_20260906.sql 的预计删除规模，
--   应与既知结论一致：约 12.6% 为全字段完全相同的重复行。偏差过大先停下排查。
-- 列清单（与 049_uone_knowledge.sql DDL 一致）：
--   id, desc_text, title, category, priority, location, source
-- ============================================================================

-- 1) 预计删除行数与占比（核心指标：pct 应 ≈ 12.6%）
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY desc_text, title, category, priority, location, source
           ORDER BY id ASC
         ) AS rn
  FROM uone_knowledge
)
SELECT count(*) FILTER (WHERE rn > 1)                          AS rows_to_delete,
       count(*)                                                AS total_rows,
       round(100.0 * count(*) FILTER (WHERE rn > 1) / count(*), 1) AS pct_to_delete
FROM ranked;

-- 2) 重复组大小分布（组内行数 → 组数 / 涉及行数），观察重复形态是否健康
SELECT cnt AS group_size,
       count(*) AS groups,
       sum(cnt) AS rows_in_groups,
       sum(cnt) - count(*) AS deletable_rows
FROM (
  SELECT desc_text, title, category, priority, location, source, count(*) AS cnt
  FROM uone_knowledge
  GROUP BY desc_text, title, category, priority, location, source
  HAVING count(*) > 1
) g
GROUP BY cnt
ORDER BY cnt;

-- 3) 重复最多的类目 Top 20（辅助判断重复是否集中在某些导入批次）
SELECT category,
       count(*) AS dup_groups,
       sum(cnt) AS rows_in_groups,
       sum(cnt) - count(*) AS deletable_rows
FROM (
  SELECT category, desc_text, title, priority, location, source, count(*) AS cnt
  FROM uone_knowledge
  GROUP BY category, desc_text, title, priority, location, source
  HAVING count(*) > 1
) g
GROUP BY category
ORDER BY deletable_rows DESC
LIMIT 20;

-- 4) 抽样预览：将被删除的行示例（每组除最小 id 外的行，前 20 条，人工抽查内容确实相同）
SELECT id, title, category, priority, left(desc_text, 60) AS desc_preview
FROM (
  SELECT id, title, category, priority, desc_text,
         ROW_NUMBER() OVER (
           PARTITION BY desc_text, title, category, priority, location, source
           ORDER BY id ASC
         ) AS rn
  FROM uone_knowledge
) t
WHERE rn > 1
ORDER BY id
LIMIT 20;
