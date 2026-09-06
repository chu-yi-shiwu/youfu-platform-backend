-- ============================================================================
-- uone_knowledge 知识库去重脚本（2026-09-06）
-- ============================================================================
-- ⚠️ 执行环境与权限（必读）：
--   本脚本在 ECS 生产库执行，必须以 postgres 超管身份运行（psql -U postgres -f ...）。
--   原因：uone_knowledge 受租户 RLS 策略约束（见 060_rls_tenant_scoped_ai_tables.sql），
--   youfu_app 角色的 DELETE 会被 RLS 架空（静默 0 行删除、不报错），
--   只有表 Owner / 超管（BYPASSRLS）能真正删除。
-- 背景：UOne 老平台导入的约 10 万条历史知识中约 12.6% 为内容完全相同的重复记录，
--   污染 src/routes/aiPreview.ts 相似案例检索的 topK。本脚本只删除
--   「全字段完全相同」的重复行（每组保留最小 id），不做任何模糊/近重复清理。
--
-- 列清单（已按 information_schema 核对，与 049_uone_knowledge.sql DDL 一致）：
--   id(bigserial PK), desc_text, title, category, priority, location, source
-- 执行前请再核对一次列清单（若与上面不一致，先停下同步 PARTITION BY）：
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'uone_knowledge' ORDER BY ordinal_position;
-- 上线流程：先跑 uone_knowledge_dedup_precheck_20260906.sql（只读 dry-run）确认
--   预计删除行数符合 ~12.6% 预期，再执行本脚本。
-- ============================================================================

BEGIN;

-- ── 1) 备份：全表快照（含重复行，id 原样保留，可精确回滚） ──────────────────
CREATE TABLE uone_knowledge_backup_20260906 AS
SELECT * FROM uone_knowledge;

-- ── 2) 去重：全业务字段完全相同视为重复，保留每组最小 id ────────────────────
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY desc_text, title, category, priority, location, source
           ORDER BY id ASC
         ) AS rn
  FROM uone_knowledge
)
DELETE FROM uone_knowledge
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- ── 3) 验证（COMMIT 前人工核对，任一不符执行 ROLLBACK 并排查） ─────────────
-- 3.1 行数对账：backup_rows 应等于 049 灌入时的原始行数；after_rows 应 ≈ 原行数 × (1 - 12.6%)
SELECT (SELECT count(*) FROM uone_knowledge)                 AS after_rows,
       (SELECT count(*) FROM uone_knowledge_backup_20260906) AS backup_rows;

-- 3.2 断言：剩余重复组数必须为 0（结果不为 0 则 ROLLBACK）
SELECT count(*) AS dup_groups_left
FROM (
  SELECT desc_text, title, category, priority, location, source
  FROM uone_knowledge
  GROUP BY desc_text, title, category, priority, location, source
  HAVING count(*) > 1
) t;

-- 3.3 备份表与主表差异 = 本次删除行数（应与 precheck 的 rows_to_delete 一致）
SELECT (SELECT count(*) FROM uone_knowledge_backup_20260906)
     - (SELECT count(*) FROM uone_knowledge) AS deleted_rows;

COMMIT;

-- ============================================================================
-- 4) 回滚（仅确认误删时使用；注释形式保存，需单独以 postgres 超管执行）：
-- BEGIN;
-- TRUNCATE TABLE uone_knowledge;
-- INSERT INTO uone_knowledge (id, desc_text, title, category, priority, location, source)
-- SELECT id, desc_text, title, category, priority, location, source
--   FROM uone_knowledge_backup_20260906
--  ORDER BY id;
-- COMMIT;
-- 回滚确认：SELECT count(*) FROM uone_knowledge; 应恢复为备份表行数。
-- ============================================================================
