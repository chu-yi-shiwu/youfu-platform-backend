-- workflow_def 到场态（arrived）补丁 · 备份与对账 SQL（2026-09-06 任务⑤）
--
-- !! 主补丁由 tools/wfdef_arrived_patch_20260906.mjs 做（node 逐行 JSON 增量打补丁，
--    异构图防御：只增不改不删）。本 SQL 只做两件事：① 幂等备份表；② 执行前/后对账查询。
--    本文件不包含任何 UPDATE——请勿手工把本文件当补丁跑。
--
-- 运行环境：ECS CentOS7，root 下：sudo -u postgres psql -d youfu -f 本文件
-- （备份语句与对账查询均为只读/建表幂等，重复执行安全；但建议先跑 mjs --dry-run 看清单）。

-- ═══════════════════════════ ① 备份（幂等，已存在则跳过） ═══════════════════════════
DO $$
BEGIN
  IF to_regclass('public.workflow_def_backup_20260906') IS NULL THEN
    CREATE TABLE workflow_def_backup_20260906 AS SELECT * FROM workflow_def;
    RAISE NOTICE 'backup table workflow_def_backup_20260906 created';
  ELSE
    RAISE NOTICE 'backup table workflow_def_backup_20260906 already exists, skipped';
  END IF;
END $$;

-- ═══════════════════════════ ② 执行补丁前的对账基线 ═══════════════════════════
-- 每租户 def 总数 / 其中 work_order 图 / 其中已含 arrived 的图（补丁前应大多为 0）。
SELECT tenant_id,
       count(*)                                              AS def_total,
       count(*) FILTER (WHERE entity_type = 'work_order')    AS work_order_defs,
       count(*) FILTER (WHERE def->'states' ? 'arrived')     AS defs_with_arrived
  FROM workflow_def
 GROUP BY tenant_id
 ORDER BY tenant_id;

-- 将被补丁命中的行（states 同时含 assigned+processing 且不含 arrived）：
-- mjs --dry-run 打印的清单应与本查询结果一一对应（异构防御口径同源）。
SELECT tenant_id, entity_type, version,
       def->'states' AS states_before
  FROM workflow_def
 WHERE def->'states' ? 'assigned'
   AND def->'states' ? 'processing'
   AND NOT def->'states' ? 'arrived'
 ORDER BY tenant_id, entity_type;

-- ═══════════════════════════ ③ 执行补丁后的对账 ═══════════════════════════
-- 改了多少行：version 高于备份快照的行数（备份快照留存补丁前 version）。
SELECT count(*) AS patched_rows
  FROM workflow_def w
  JOIN workflow_def_backup_20260906 b
    ON b.tenant_id = w.tenant_id AND b.entity_type = w.entity_type
 WHERE w.version > b.version;

-- 每租户补丁后状态：def 总数 / 已含 arrived 的 def 数（work_order 图应全部 ≥1；巡检等异构图保持 0 属预期）。
SELECT tenant_id,
       count(*)                                          AS def_total,
       count(*) FILTER (WHERE def->'states' ? 'arrived') AS defs_with_arrived
  FROM workflow_def
 GROUP BY tenant_id
 ORDER BY tenant_id;

-- 抽查：确认 arrived 三边字段与 stateMachine.ts RICH 定义一致
-- （assigned--arrive-->arrived / arrived--start-->processing / arrived--cancel-->cancelled）。
SELECT tenant_id, entity_type, edge
  FROM workflow_def,
       LATERAL (
         SELECT jsonb_build_object('from', t->>'from', 'event', t->>'event', 'to', t->>'to') AS edge
           FROM jsonb_array_elements(def->'transitions') t
          WHERE (t->>'from', t->>'event', t->>'to') IN (
                  ('assigned', 'arrive', 'arrived'),
                  ('arrived', 'start', 'processing'),
                  ('arrived', 'cancel', 'cancelled'))
       ) e
 WHERE def->'states' ? 'arrived'
 ORDER BY tenant_id, entity_type;
