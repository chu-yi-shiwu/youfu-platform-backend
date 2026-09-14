-- 089_volunteer_intake_perm_backfill.sql —— 放宽向权限点覆盖行回填（086 同款范式）。
--
-- 【为什么需要它】
--   两批"放宽向"权限点改了代码层默认矩阵（role.ts DEFAULT_PERM_MATRIX），但 role_permission
--   的语义是「(tenant, role) 有覆盖行即只用覆盖集合，不再看默认矩阵」——存量租户里已配过
--   覆盖行的 operator / worker 拿不到新点，对应入口当场 403：
--   ① operator 缺 volunteer.view / volunteer.manage / volunteer.audit
--      （V1 批次 20260911 补进默认矩阵的志愿者三点；operator 端志愿者列表/管理/核销）；
--   ② worker 缺 intake.create
--      （#942 R15 补进默认矩阵：陪检登记等登录态录入复用建单引擎，worker 端建单入口）。
--   本迁移把"逐租户人工补行"转成确定性脚本（一次性数据修正，086 consumable.consume 同病灶）。
--
-- 【严格边界（086 红线，逐条对齐）】
--   - 只回填上述 4 个 (role, perm) 组合，共 2 角色 4 点；**不碰**其它任何权限点；
--   - **只给「已有覆盖行的 (tenant, role)」生成行**——数据源就是 role_permission 自身，
--     无覆盖行的租户**零行生成**（保持默认矩阵语义，不凭空造覆盖）；
--   - admin 不参与（恒全放行，代码层禁改，本就无覆盖行）；
--   - ON CONFLICT (tenant_id, role, perm) DO NOTHING → 幂等，重复执行行数不变；
--   - 🔴 纯 DML（无 DDL、无索引、无谓词），不含 now() 索引谓词问题。
--
-- 🔴 执行纪律（087 同款）：必须以 postgres 超管执行——role_permission 有 RLS（046:39-44，
--   TO youfu_app），youfu_app 无租户上下文裸查恒 0 行（假阴性陷阱，纵切①实证）。
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 089_volunteer_intake_perm_backfill.sql
--   分段：① 盘点（只读，先看量）② 回填 ③ 复核（应 0 行）④ 红线自证（应 0 行）
--
-- 🔴 快照声明：回填依据 = src/middleware/role.ts DEFAULT_PERM_MATRIX（operator 含志愿者三点、
--   worker 含 intake.create）在 2026-09-14 的内容。若未来矩阵变更，重跑前先核对快照语义。

-- ============ ① 盘点（只读）：有覆盖行的 (tenant, role) 及其是否已含目标权限点 ============
\echo '--- 089① 盘点：有覆盖行的 operator/worker 及其是否已含本次 4 个目标点 ---'
SELECT rp.tenant_id,
       rp.role,
       COUNT(*)::int                                                                    AS perm_count,
       BOOL_OR(rp.perm = 'volunteer.view')                                              AS has_volunteer_view,
       BOOL_OR(rp.perm = 'volunteer.manage')                                            AS has_volunteer_manage,
       BOOL_OR(rp.perm = 'volunteer.audit')                                             AS has_volunteer_audit,
       BOOL_OR(rp.perm = 'intake.create')                                               AS has_intake_create
FROM role_permission rp
WHERE rp.role IN ('operator', 'worker')
GROUP BY rp.tenant_id, rp.role
ORDER BY rp.tenant_id, rp.role;

-- ============ ② 回填：只给已有覆盖行的 (tenant, role) 补目标权限点 ============
\echo '--- 089② 回填：operator×志愿者三点 + worker×intake.create（仅已有覆盖行的组合）---'
INSERT INTO role_permission (tenant_id, role, perm)
SELECT DISTINCT rp.tenant_id, rp.role, p.perm
FROM role_permission rp
JOIN (
  -- 放宽向目标点（与 DEFAULT_PERM_MATRIX 快照逐字对齐；新增目标点在此登记）
  VALUES ('operator', 'volunteer.view'),
         ('operator', 'volunteer.manage'),
         ('operator', 'volunteer.audit'),
         ('worker', 'intake.create')
) AS p(role, perm)
  ON p.role = rp.role
WHERE rp.role IN ('operator', 'worker')
  -- 显式表达「该 (tenant,role) 确实已有覆盖行」：rp 自身即证据，此 EXISTS 为可读性冗余但语义自证
  AND EXISTS (
    SELECT 1 FROM role_permission x
    WHERE x.tenant_id = rp.tenant_id AND x.role = rp.role
  )
ON CONFLICT (tenant_id, role, perm) DO NOTHING;

-- ============ ③ 复核：应返回 0 行 ============
\echo '--- 089③ 复核：有覆盖行但仍缺目标点的组合=回填后仍会 403 的 (tenant, role)（期望 0 行）---'
SELECT rp.tenant_id,
       rp.role,
       string_agg(DISTINCT missing.perm, ',' ORDER BY missing.perm) AS still_missing
FROM role_permission rp
JOIN (
  VALUES ('operator', 'volunteer.view'),
         ('operator', 'volunteer.manage'),
         ('operator', 'volunteer.audit'),
         ('worker', 'intake.create')
) AS p(role, perm) ON p.role = rp.role
JOIN (
  VALUES ('operator', 'volunteer.view'),
         ('operator', 'volunteer.manage'),
         ('operator', 'volunteer.audit'),
         ('worker', 'intake.create')
) AS missing(role, perm) ON missing.role = rp.role
WHERE rp.role IN ('operator', 'worker')
  AND NOT EXISTS (
    SELECT 1 FROM role_permission y
    WHERE y.tenant_id = rp.tenant_id AND y.role = rp.role AND y.perm = missing.perm
  )
GROUP BY rp.tenant_id, rp.role
ORDER BY rp.tenant_id, rp.role;

-- ============ ④ 红线自证：未被回填的租户必须仍然零行 ============
-- 说明：无覆盖行的 (tenant,role) 组合在本迁移中不可能被创建；此处列出「该租户 operator/worker
-- 仅含本次 4 个目标点中的某些行」的异常形态（正常应为 0 行——那意味着我们凭空造了覆盖行）。
\echo '--- 089④ 红线自证：凭空生成的覆盖行（期望 0 行）---'
SELECT rp.tenant_id, rp.role
FROM role_permission rp
WHERE rp.role IN ('operator', 'worker')
  AND rp.perm IN ('volunteer.view', 'volunteer.manage', 'volunteer.audit', 'intake.create')
GROUP BY rp.tenant_id, rp.role
HAVING COUNT(*) = COUNT(*) FILTER (
  WHERE rp.perm IN ('volunteer.view', 'volunteer.manage', 'volunteer.audit', 'intake.create')
)
   AND NOT EXISTS (
    SELECT 1 FROM role_permission x
    WHERE x.tenant_id = rp.tenant_id AND x.role = rp.role
      AND x.perm NOT IN ('volunteer.view', 'volunteer.manage', 'volunteer.audit', 'intake.create')
  )
ORDER BY rp.tenant_id, rp.role;
