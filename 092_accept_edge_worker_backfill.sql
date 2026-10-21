-- 092_accept_edge_worker_backfill.sql —— 存量 workflow_def 的接单边（accept）补 worker
--
-- 【为什么需要它（不做会怎样）】
--   用户原始诉求②（原话）：「师傅不能接单谁接单？他妈的机制都给老子跑歪了？师傅的职能就是接单执行。」
--   代码根因：RICH_WORK_ORDER_DEF 的 accept 边（pending_accept → pending_dispatch）
--     allowedRoles = ['admin','dispatcher','service_desk'] —— **不含 worker**，
--     即真正上门干活的师傅接不了单，接单权反而落在两个待退场角色上。
--   已在代码层把 accept 边改为 ['admin','worker','dispatcher','service_desk']（纯加法）。
--   ⚠️ 但**流程配置是数据**（workflow_def.def jsonb，租户可定制）：存量库已落库的 def
--   仍是旧三值 → 只刷代码不刷数据，**存量租户的师傅依旧接不了单**。本迁移同步存量。
--
-- 【严格边界（纯加法，零破坏）】
--   - 只动 event='accept' 的边，且**仅当该边的 allowedRoles 尚不含 'worker'**；
--   - 只做 jsonb **数组追加**，绝不删改租户任何既有配置
--     （admin / dispatcher / service_desk 原样保留 → 存量三方接单权限一字不动，零回归）；
--   - 幂等：WHERE 已排除"已含 worker"的行，二次执行 0 行；
--   - 纯 DML（无 DDL / 无索引 / 无谓词），不触碰 now() 索引谓词问题（077 铁律）。
--
-- 【为什么不重跑 seed-workflow-def.ts】
--   该脚本**整份覆盖**写 RICH_WORK_ORDER_DEF，会冲掉租户自己改过的流程配置（091 同款理由）。
--
-- 🔴 执行纪律（087/089/091 同款）：以 postgres 超管执行——workflow_def 有 RLS，
--   youfu_app 无租户上下文裸查恒 0 行（假阴性陷阱）。
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 092_accept_edge_worker_backfill.sql
-- 【回滚】摘掉新增元素即可（把 'worker' 从 accept 边的 allowedRoles 移除），无数据损失：
--   同结构 UPDATE，把 `|| '["worker"]'::jsonb` 换成 `#- '{allowedRoles,N}'`（N 为 worker 下标）。

-- ============ ① 盘点（只读）：待补的租户/边 ============
\echo '--- 092① 盘点：含 accept 边但 allowedRoles 尚不含 worker 的 workflow_def（待补清单）---'
SELECT w.tenant_id,
       w.entity_type,
       w.version,
       t->'allowedRoles' AS allowed_roles_before
FROM workflow_def w
JOIN LATERAL jsonb_array_elements(w.def->'transitions') t ON true
WHERE jsonb_typeof(w.def->'transitions') = 'array'
  AND t->>'event' = 'accept'
  AND NOT COALESCE(t->'allowedRoles', '[]'::jsonb) ? 'worker'
ORDER BY w.tenant_id, w.entity_type;

-- ============ ② 回填：给 accept 边的 allowedRoles 追加 worker ============
\echo '--- 092② 回填：accept 边 allowedRoles 追加 "worker"（纯加法，原三值保留）---'
-- 显式幂等（070/091 同款 DO 块范式）：块内先判定"是否存在待补的边"，
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
        WHERE t->>'event' = 'accept'
          AND NOT COALESCE(t->'allowedRoles', '[]'::jsonb) ? 'worker'
      )
  ) THEN
    UPDATE workflow_def w
    SET def = jsonb_set(
          w.def,
          '{transitions}',
          (
            SELECT jsonb_agg(
                     CASE
                       WHEN t->>'event' = 'accept'
                            AND NOT COALESCE(t->'allowedRoles', '[]'::jsonb) ? 'worker'
                         THEN jsonb_set(
                                t,
                                '{allowedRoles}',
                                COALESCE(t->'allowedRoles', '[]'::jsonb) || '["worker"]'::jsonb
                              )
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
        WHERE t->>'event' = 'accept'
          AND NOT COALESCE(t->'allowedRoles', '[]'::jsonb) ? 'worker'
      );
    RAISE NOTICE '092: 已给 accept 边补 worker（师傅可接单）';
  ELSE
    RAISE NOTICE '092: 无需回填（已含 worker 或无 accept 边），跳过';
  END IF;
END $$;

-- ============ ③ 复核：应返回 0 行（仍缺 worker = 该租户师傅接不了单） ============
\echo '--- 092③ 复核：accept 边 allowedRoles 仍不含 worker 的 def（期望 0 行）---'
SELECT w.tenant_id, w.entity_type, t->'allowedRoles' AS allowed_roles
FROM workflow_def w
JOIN LATERAL jsonb_array_elements(w.def->'transitions') t ON true
WHERE jsonb_typeof(w.def->'transitions') = 'array'
  AND t->>'event' = 'accept'
  AND NOT COALESCE(t->'allowedRoles', '[]'::jsonb) ? 'worker'
ORDER BY w.tenant_id, w.entity_type;

-- ============ ④ 红线自证：存量三方接单权限零损失（原三值必须仍在） ============
\echo '--- 092④ 红线自证：accept 边 allowedRoles 应同时含 admin/worker/dispatcher/service_desk（纯加法）---'
SELECT w.tenant_id,
       w.entity_type,
       t->'allowedRoles'                                                   AS allowed_roles,
       COALESCE(t->'allowedRoles', '[]'::jsonb) ? 'admin'                  AS has_admin,
       COALESCE(t->'allowedRoles', '[]'::jsonb) ? 'worker'                 AS has_worker,
       COALESCE(t->'allowedRoles', '[]'::jsonb) ? 'dispatcher'             AS has_dispatcher,
       COALESCE(t->'allowedRoles', '[]'::jsonb) ? 'service_desk'           AS has_service_desk
FROM workflow_def w
JOIN LATERAL jsonb_array_elements(w.def->'transitions') t ON true
WHERE jsonb_typeof(w.def->'transitions') = 'array'
  AND t->>'event' = 'accept'
ORDER BY w.tenant_id, w.entity_type;
