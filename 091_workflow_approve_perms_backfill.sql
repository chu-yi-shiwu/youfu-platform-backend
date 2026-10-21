-- 091_workflow_approve_perms_backfill.sql —— 存量 workflow_def 补"审核=权限属性"声明（086/089 同款数据修正范式）
--
-- 【为什么需要它（不做会怎样）】
--   地基第二步在代码层把审核从"一个岗位"还原成"可叠加权限属性"：
--     RICH_WORK_ORDER_DEF 的 approve / reject 两条边新增 allowedPerms:['workflow.approve']，
--     src/repo/ticket.ts 的转移门禁改为 allowedRoles ∪ allowedPerms 并集。
--   ⚠️ 但**流程配置是数据**（workflow_def.def jsonb，租户可定制）：存量库里已落库的 def
--   没有 allowedPerms 字段 → 迁移只刷代码不刷数据，新机制对存量租户**不生效**（审核仍只有
--   admin / reviewer 能做、验收仍只有 admin/operator/reviewer 能做）。
--   本迁移就是把"代码新默认值"同步进既有配置。
--
--   【2026-10-16 扩边】用户拍板验收与审核同口径 → 目标边由 2 条扩为 4 条：
--     approve / reject（RICH_WORK_ORDER_DEF，stateMachine.ts:133-134）
--     acceptance_pass / acceptance_reject（ACCEPTANCE_EDGES，acceptanceEdges.ts:15-16）
--
-- 【严格边界】
--   - 只动 event ∈ (上述 4 个) 的边，且**仅当该边尚未声明 allowedPerms**；
--   - 只做 jsonb 加法（t || '{"allowedPerms":[...]}'），**不删不覆盖**租户任何自定义配置
--     （allowedRoles / requiredFields / sideEffects / states / config 一律原样保留）；
--   - 幂等：WHERE 已排除"declare 过 allowedPerms"的行，二次执行 0 行；
--   - 纯 DML（无 DDL / 无索引 / 无谓词），不触碰 now() 索引谓词问题（077 铁律）。
--
-- 【为什么不直接重跑 seed-workflow-def.ts】
--   该脚本是**整份覆盖**（saveWorkflowDef 写 RICH_WORK_ORDER_DEF 全量），会把租户自己改过的
--   流程配置冲掉。本迁移只补缺失字段，是唯一安全的存量刷新方式。
--
-- 🔴 执行纪律（087/089 同款）：以 postgres 超管执行——workflow_def 有 RLS，
--   youfu_app 无租户上下文裸查恒 0 行（假阴性陷阱）。
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 091_workflow_approve_perms_backfill.sql
-- 【回滚】删除新增键即可（把 allowedPerms 从这两条边摘掉），无数据损失：
--   同结构 UPDATE，把 `t || '{"allowedPerms":[...]}'` 换成 `t - 'allowedPerms'`。

-- ============ ① 盘点（只读）：待补的租户/边数量 ============
\echo '--- 091① 盘点：含 approve/reject/acceptance_pass/acceptance_reject 边但尚未声明 allowedPerms 的 workflow_def（待补清单）---'
SELECT w.tenant_id,
       w.entity_type,
       w.version,
       COUNT(*) FILTER (WHERE t->>'event' IN ('approve', 'reject', 'acceptance_pass', 'acceptance_reject')) AS target_edges
FROM workflow_def w
JOIN LATERAL jsonb_array_elements(w.def->'transitions') t ON true
WHERE jsonb_typeof(w.def->'transitions') = 'array'
  AND t->>'event' IN ('approve', 'reject', 'acceptance_pass', 'acceptance_reject')
  AND NOT (t ? 'allowedPerms')
GROUP BY w.tenant_id, w.entity_type, w.version
ORDER BY w.tenant_id, w.entity_type;

-- ============ ② 回填：只给缺失的两条边补 allowedPerms ============
\echo '--- 091② 回填：approve/reject 边补 allowedPerms:["workflow.approve"] ---'
-- 显式幂等（070 同款 DO 块范式）：块内先判定"是否存在待补的边"，
-- 无待补项则 RAISE NOTICE 跳过、不执行任何写（二次执行 = 干净的 no-op）。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM workflow_def w
    WHERE jsonb_typeof(w.def->'transitions') = 'array'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(w.def->'transitions') t
        WHERE t->>'event' IN ('approve', 'reject', 'acceptance_pass', 'acceptance_reject')
          AND NOT (t ? 'allowedPerms')
      )
  ) THEN
    UPDATE workflow_def w
    SET def = jsonb_set(
          w.def,
          '{transitions}',
          (
            SELECT jsonb_agg(
                     CASE
                       WHEN t->>'event' IN ('approve', 'reject', 'acceptance_pass', 'acceptance_reject') AND NOT (t ? 'allowedPerms')
                         THEN t || '{"allowedPerms": ["workflow.approve"]}'::jsonb
                       ELSE t
                     END
                   )
            FROM jsonb_array_elements(w.def->'transitions') t
          ),
          false
        ),
        updated_at = now()
    WHERE jsonb_typeof(w.def->'transitions') = 'array'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(w.def->'transitions') t
        WHERE t->>'event' IN ('approve', 'reject', 'acceptance_pass', 'acceptance_reject')
          AND NOT (t ? 'allowedPerms')
      );
    RAISE NOTICE '091: 已回填 approve/reject 边的 allowedPerms';
  ELSE
    RAISE NOTICE '091: 无需回填（已声明或无边），跳过';
  END IF;
END $$;

-- ============ ③ 复核：应返回 0 行（仍缺声明 = 新机制在该租户不生效） ============
\echo '--- 091③ 复核：approve/reject 边仍缺 allowedPerms 的 def（期望 0 行）---'
SELECT w.tenant_id, w.entity_type, t->>'event' AS event
FROM workflow_def w
JOIN LATERAL jsonb_array_elements(w.def->'transitions') t ON true
WHERE jsonb_typeof(w.def->'transitions') = 'array'
  AND t->>'event' IN ('approve', 'reject', 'acceptance_pass', 'acceptance_reject')
  AND NOT (t ? 'allowedPerms')
ORDER BY w.tenant_id, w.entity_type;

-- ============ ④ 红线自证：存量自定义配置零损失（allowedRoles 必须原样保留） ============
\echo '--- 091④ 红线自证：4 条审批边的 allowedRoles 仍为原值（审核 admin+reviewer、验收 admin+operator+reviewer 应完整保留）---'
SELECT w.tenant_id,
       w.entity_type,
       t->>'event'                       AS event,
       t->'allowedRoles'                 AS allowed_roles,
       t->'allowedPerms'                 AS allowed_perms
FROM workflow_def w
JOIN LATERAL jsonb_array_elements(w.def->'transitions') t ON true
WHERE jsonb_typeof(w.def->'transitions') = 'array'
  AND t->>'event' IN ('approve', 'reject', 'acceptance_pass', 'acceptance_reject')
ORDER BY w.tenant_id, w.entity_type, event;
