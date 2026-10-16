-- 093_retired_roles_backfill.sql —— 存量 workflow_def 摘除退场角色 dispatcher / service_desk
--
-- 【为什么需要它（不做会怎样）】
--   用户要求①（原话）：「这两个明明是我设计之初就强调要拿掉的角色」
--   代码层已改（stateMachine.ts / claimHallEdges.ts / themes.ts 的 allowedRoles 摘除两角色）。
--   ⚠️ 但**流程配置是数据**（workflow_def.def jsonb，租户可定制）：存量库已落库的 def
--   仍写着旧角色名 → 只刷代码不刷数据，**存量租户流程里这两个角色依然生效**。
--   本迁移同步存量，让"拿掉"在存量租户上也真正生效。
--
-- 【一次改两类边，顺序与语义】
--   ① dispatch / forward（派单 / 转派）：摘 dispatcher+service_desk，补 allowedPerms:['dispatch.override']
--   ② cancel（撤销，10 条活跃态边）：摘 dispatcher，补 allowedPerms:['ticket.manage']
--   ③ accept / claim（接单 / 抢单）：只摘两角色，不补权限点（admin+worker 本就在白名单内，
--      且接单是师傅职能——补 dispatch.override 反而会把 operator 放进接单门禁，属扩权，不做）
--
-- 【🔴 为什么这是零破坏：能力不中断的完整论证】
--   摘掉边上的角色名后，存量 dispatcher/service_desk 账号会不会突然派不了单？**不会**，因为：
--     - 门禁是 allowedRoles ∪ allowedPerms **并集**（isTransitionAllowed，stateMachine.ts:44）；
--     - DEFAULT_PERM_MATRIX（role.ts）：dispatcher 默认含 dispatch.override + ticket.manage；
--       service_desk 默认含 dispatch.override + ticket.manage；
--     - ⇒ 摘角色后，这两类存量账号**改由权限点放行**，派单/取消能力一字不减。
--   同理 operator 也零损失：operator 默认矩阵本就含 dispatch.override 与 ticket.manage。
--   新增权限点走"补集追加 + 已存在则跳过"，绝不覆盖租户既有 allowedPerms。
--
-- 【严格边界】
--   - 只做**数组元素摘除 + 权限点追加**，绝不新增/删除状态或边，绝不改租户其它字段；
--   - 幂等：WHERE 只筛"确实还含退场角色"的行，二次执行 0 行（DO 块内显式 IF 判定）；
--   - 纯 DML（无 DDL / 无索引 / 无谓词），不触碰 now() 索引谓词问题（077 铁律）；
--   - 存量 account_user.role = 'dispatcher'/'service_desk' 的行**一个不动**
--     （改数据是破坏性动作，须管理员决策后手动改派；本迁移只改流程定义）。
--
-- 🔴 执行纪律（087/089/091/092 同款）：以 postgres 超管执行——workflow_def 有 RLS，
--   youfu_app 无租户上下文裸查恒 0 行（假阴性陷阱）。
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 093_retired_roles_backfill.sql
-- 【回滚】本迁移只摘元素 + 加点，回滚 = 把角色名加回 allowedRoles（结构对称，无数据损失）。

-- ============ ① 盘点（只读）：待改的租户/边 ============
\echo '--- 093① 盘点：仍含退场角色 dispatcher/service_desk 的 workflow_def（待改清单）---'
SELECT w.tenant_id,
       w.entity_type,
       w.version,
       t->>'event'                    AS event,
       t->>'from'                     AS from_state,
       t->>'to'                       AS to_state,
       t->'allowedRoles'              AS allowed_roles_before,
       t->'allowedPerms'              AS allowed_perms_before
FROM workflow_def w
JOIN LATERAL jsonb_array_elements(w.def->'transitions') t ON true
WHERE jsonb_typeof(w.def->'transitions') = 'array'
  AND (
        (t->>'event' IN ('dispatch','forward','accept','claim')
         AND (COALESCE(t->'allowedRoles','[]'::jsonb) ? 'dispatcher'
              OR COALESCE(t->'allowedRoles','[]'::jsonb) ? 'service_desk'))
     OR (t->>'event' = 'cancel'
         AND COALESCE(t->'allowedRoles','[]'::jsonb) ? 'dispatcher')
      )
ORDER BY w.tenant_id, w.entity_type, t->>'event';

-- ============ ② 回填：摘退场角色 + 补权限点 ============
\echo '--- 093② 回填：摘 dispatcher/service_desk，dispatch|forward 补 dispatch.override、cancel 补 ticket.manage ---'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM workflow_def w
    WHERE jsonb_typeof(w.def->'transitions') = 'array'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(w.def->'transitions') t
        WHERE (t->>'event' IN ('dispatch','forward','accept','claim')
               AND (COALESCE(t->'allowedRoles','[]'::jsonb) ? 'dispatcher'
                    OR COALESCE(t->'allowedRoles','[]'::jsonb) ? 'service_desk'))
           OR (t->>'event' = 'cancel'
               AND COALESCE(t->'allowedRoles','[]'::jsonb) ? 'dispatcher')
      )
  ) THEN
    UPDATE workflow_def w
    SET def = jsonb_set(
          w.def,
          '{transitions}',
          (
            SELECT jsonb_agg(
                     CASE
                       -- ① 派单 / 转派：摘两角色 + 补 dispatch.override
                       WHEN t->>'event' IN ('dispatch','forward') THEN
                         jsonb_set(
                           jsonb_set(
                             t,
                             '{allowedRoles}',
                             COALESCE(
                               (SELECT jsonb_agg(r)
                                  FROM jsonb_array_elements(COALESCE(t->'allowedRoles','[]'::jsonb)) r
                                 WHERE r <> '"dispatcher"'::jsonb
                                   AND r <> '"service_desk"'::jsonb),
                               '[]'::jsonb
                             ),
                             false
                           ),
                           '{allowedPerms}',
                           CASE
                             WHEN COALESCE(t->'allowedPerms','[]'::jsonb) ? 'dispatch.override'
                               THEN COALESCE(t->'allowedPerms','[]'::jsonb)
                             ELSE COALESCE(t->'allowedPerms','[]'::jsonb) || '["dispatch.override"]'::jsonb
                           END,
                           true
                         )
                       -- ② 撤销：摘 dispatcher + 补 ticket.manage
                       WHEN t->>'event' = 'cancel' THEN
                         jsonb_set(
                           jsonb_set(
                             t,
                             '{allowedRoles}',
                             COALESCE(
                               (SELECT jsonb_agg(r)
                                  FROM jsonb_array_elements(COALESCE(t->'allowedRoles','[]'::jsonb)) r
                                 WHERE r <> '"dispatcher"'::jsonb),
                               '[]'::jsonb
                             ),
                             false
                           ),
                           '{allowedPerms}',
                           CASE
                             WHEN COALESCE(t->'allowedPerms','[]'::jsonb) ? 'ticket.manage'
                               THEN COALESCE(t->'allowedPerms','[]'::jsonb)
                             ELSE COALESCE(t->'allowedPerms','[]'::jsonb) || '["ticket.manage"]'::jsonb
                           END,
                           true
                         )
                       -- ③ 接单 / 抢单：只摘两角色，不补权限点（防扩权到 operator）
                       WHEN t->>'event' IN ('accept','claim') THEN
                         jsonb_set(
                           t,
                           '{allowedRoles}',
                           COALESCE(
                             (SELECT jsonb_agg(r)
                                FROM jsonb_array_elements(COALESCE(t->'allowedRoles','[]'::jsonb)) r
                               WHERE r <> '"dispatcher"'::jsonb
                                 AND r <> '"service_desk"'::jsonb),
                             '[]'::jsonb
                           ),
                           false
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
        WHERE (t->>'event' IN ('dispatch','forward','accept','claim')
               AND (COALESCE(t->'allowedRoles','[]'::jsonb) ? 'dispatcher'
                    OR COALESCE(t->'allowedRoles','[]'::jsonb) ? 'service_desk'))
           OR (t->>'event' = 'cancel'
               AND COALESCE(t->'allowedRoles','[]'::jsonb) ? 'dispatcher')
      );
    RAISE NOTICE '093: 已摘除退场角色 dispatcher/service_desk 并补挂权限点';
  ELSE
    RAISE NOTICE '093: 无需回填（无含退场角色的边），跳过';
  END IF;
END $$;

-- ============ ③ 复核：应返回 0 行（仍有退场角色 = 该租户流程还没拿掉） ============
\echo '--- 093③ 复核：仍含 dispatcher/service_desk 的边（期望 0 行）---'
SELECT w.tenant_id, w.entity_type, t->>'event' AS event, t->'allowedRoles' AS allowed_roles
FROM workflow_def w
JOIN LATERAL jsonb_array_elements(w.def->'transitions') t ON true
WHERE jsonb_typeof(w.def->'transitions') = 'array'
  AND (COALESCE(t->'allowedRoles','[]'::jsonb) ? 'dispatcher'
       OR COALESCE(t->'allowedRoles','[]'::jsonb) ? 'service_desk')
ORDER BY w.tenant_id, w.entity_type, t->>'event';

-- ============ ④ 红线自证：能力零损失（摘角色后必须有权限点接住） ============
\echo '--- 093④ 红线自证：dispatch/forward 必含 dispatch.override；cancel 必含 ticket.manage（has_perm 列应全为 true）---'
SELECT w.tenant_id,
       w.entity_type,
       t->>'event'                                                        AS event,
       t->'allowedRoles'                                                  AS allowed_roles_after,
       t->'allowedPerms'                                                  AS allowed_perms_after,
       CASE
         WHEN t->>'event' IN ('dispatch','forward')
           THEN COALESCE(t->'allowedPerms','[]'::jsonb) ? 'dispatch.override'
         WHEN t->>'event' = 'cancel'
           THEN COALESCE(t->'allowedPerms','[]'::jsonb) ? 'ticket.manage'
         ELSE NULL
       END                                                                AS has_perm
FROM workflow_def w
JOIN LATERAL jsonb_array_elements(w.def->'transitions') t ON true
WHERE jsonb_typeof(w.def->'transitions') = 'array'
  AND t->>'event' IN ('dispatch','forward','cancel')
ORDER BY w.tenant_id, w.entity_type, t->>'event';

-- ============ ⑤ 存量账号盘点（只读，不改）：管理员据此决策改派 ============
\echo '--- 093⑤ 存量账号盘点：仍挂退场角色的账号（需管理员手动改派；本迁移不动这些数据）---'
SELECT tenant_id, role, COUNT(*)::int AS accounts
FROM account_user
WHERE role IN ('dispatcher','service_desk')
GROUP BY tenant_id, role
ORDER BY tenant_id, role;
