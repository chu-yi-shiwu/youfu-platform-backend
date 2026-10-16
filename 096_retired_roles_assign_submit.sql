-- 096_retired_roles_assign_submit.sql —— 补 093 漏掉的 assign / submit 两条边
--
-- 【为什么还需要一个 096（093 做完了什么、漏了什么）】
--   093 的 UPDATE 只覆盖 dispatch / forward / cancel / accept / claim 五个事件。
--   ⚠️ **assign（派单指派）与 submit（提交）两个事件没写进 093 的事件清单**，
--   于是真库 093 跑完后仍残留 2 条含 dispatcher 的边（2026-10-17 真库复核实测）：
--       demo_tenant | work_order | v2 | assign | ["admin","dispatcher"]
--       demo_tenant | work_order | v2 | submit | ["admin","operator","dispatcher"]
--   本迁移收口这最后 2 条，让「退场角色从存量流程里彻底消失」在真库上真正成立。
--
-- 【🔴 口径：只摘不补 —— 与 093 的 accept / claim 完全同一论证，不是偷懒】
--   为什么不照 dispatch/forward 那样补 allowedPerms:['dispatch.override']：
--     1. 退场角色**已不可能再有新账号**——account.ts createUser 与 routes/invite.ts
--        两处 isRoleUsable 闸门已上线（commit 8b2d211），新建/邀请一律拒绝 dispatcher、
--        service_desk；
--     2. 存量 3 个退场账号（真库实测，全部 active=true）：
--          t-verification / dispatch_wang / dispatcher
--          t-phasea      / d1891       / service_desk
--          t-verification/ desk_tai    / service_desk
--        **没有一个在 demo_tenant**，而残留的 2 条边属于 demo_tenant
--        ⇒ 摘掉这两条边，对任何现存账号**零掉权**（这不是推断，是上面两组实测对齐的结论）；
--     3. 补 dispatch.override 的唯一实际效果，是把 demo_tenant 的 operator 放进 assign 门禁
--        = **无收益的扩权**；违背了 093 自己写下的判断：
--        「补 dispatch.override 反而会把 operator 放进接单门禁，属扩权，不做」；
--     4. submit 摘掉后剩 ["admin","operator"]，assign 摘掉后剩 ["admin"]，
--        两者都仍有角色放行，不会退化成无人可操作的死边。
--   ⇒ 结论：**只摘退场角色名，不追加任何权限点**。
--   若将来业务上确实要让 operator 走 assign，应在流程配置界面由管理员显式授权，
--   而不是由迁移脚本代替管理员做扩权决策。
--
-- 【严格边界】
--   - 只改 event IN ('assign','submit') 的边，其它事件（含 093 已处理的）一字不动；
--   - 只做 allowedRoles **数组元素摘除**，绝不新增/删除状态或边，绝不写 allowedPerms；
--   - 幂等：DO 块内先判 EXISTS，二次执行 0 行；WHERE 也只筛确实还含退场角色的行；
--   - 纯 DML（无 DDL / 无索引 / 无谓词），不触碰 now() 索引谓词问题（077 铁律）；
--   - 存量 account_user.role = 'dispatcher'/'service_desk' 的行**一个不动**。
--
-- 🔴 执行纪律（087/089/091/092/093 同款）：以 postgres 超管执行——workflow_def 有 RLS，
--   youfu_app 无租户上下文裸查恒 0 行（假阴性陷阱）。
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 096_retired_roles_assign_submit.sql
-- 【回滚】只摘元素，回滚 = 把角色名加回 allowedRoles（结构对称，无数据损失）。

-- ============ ① 盘点（只读）：待改的边 ============
\echo '--- 096① 盘点：assign/submit 边上仍含退场角色的 workflow_def（待改清单）---'
SELECT w.tenant_id,
       w.entity_type,
       w.version,
       t->>'event'       AS event,
       t->'allowedRoles' AS allowed_roles_before
FROM workflow_def w
JOIN LATERAL jsonb_array_elements(w.def->'transitions') t ON true
WHERE jsonb_typeof(w.def->'transitions') = 'array'
  AND t->>'event' IN ('assign', 'submit')
  AND (COALESCE(t->'allowedRoles', '[]'::jsonb) ? 'dispatcher'
       OR COALESCE(t->'allowedRoles', '[]'::jsonb) ? 'service_desk')
ORDER BY w.tenant_id, w.entity_type, w.version, t->>'event';

-- ============ ② 执行：只摘退场角色名 ============
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM workflow_def w
    WHERE jsonb_typeof(w.def->'transitions') = 'array'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(w.def->'transitions') t
        WHERE t->>'event' IN ('assign', 'submit')
          AND (COALESCE(t->'allowedRoles', '[]'::jsonb) ? 'dispatcher'
               OR COALESCE(t->'allowedRoles', '[]'::jsonb) ? 'service_desk')
      )
  ) THEN
    UPDATE workflow_def w
    SET def = jsonb_set(
          w.def,
          '{transitions}',
          (
            SELECT jsonb_agg(
                     CASE
                       WHEN t->>'event' IN ('assign', 'submit') THEN
                         jsonb_set(
                           t,
                           '{allowedRoles}',
                           COALESCE(
                             (SELECT jsonb_agg(r)
                                FROM jsonb_array_elements(COALESCE(t->'allowedRoles', '[]'::jsonb)) r
                               WHERE r <> '"dispatcher"'::jsonb
                                 AND r <> '"service_desk"'::jsonb),
                             '[]'::jsonb
                           ),
                           false  -- 不创建缺失键：边上本就没有 allowedRoles 时不凭空造一个
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
        WHERE t->>'event' IN ('assign', 'submit')
          AND (COALESCE(t->'allowedRoles', '[]'::jsonb) ? 'dispatcher'
               OR COALESCE(t->'allowedRoles', '[]'::jsonb) ? 'service_desk')
      );
  END IF;
END $$;

-- ============ ③ 复核：全库应 0 行（退场角色彻底消失）============
\echo '--- 096③ 复核：全库所有边上仍含退场角色的行（期望 0 行）---'
SELECT w.tenant_id,
       w.entity_type,
       w.version,
       t->>'event'       AS event,
       t->'allowedRoles' AS allowed_roles_after
FROM workflow_def w
JOIN LATERAL jsonb_array_elements(w.def->'transitions') t ON true
WHERE jsonb_typeof(w.def->'transitions') = 'array'
  AND (COALESCE(t->'allowedRoles', '[]'::jsonb) ? 'dispatcher'
       OR COALESCE(t->'allowedRoles', '[]'::jsonb) ? 'service_desk')
ORDER BY w.tenant_id, w.entity_type, w.version, t->>'event';

-- ============ ④ 复核：存量退场账号一个未动（期望仍 3 行）============
\echo '--- 096④ 复核：存量退场角色账号（期望 3 行，与本迁移执行前一致）---'
SELECT tenant_id, username, role, active
FROM account_user
WHERE role IN ('dispatcher', 'service_desk')
ORDER BY role, tenant_id;
