-- 087_zombie_perm_rows_cleanup.sql —— 纵切① P0-1 治理：清理「与默认矩阵逐字相同」的僵尸覆盖行。
--
-- 【为什么需要它】
--   role_permission 的语义是「有行=冻结快照，无行=随平台默认矩阵升级」。代码侧守卫已落
--   （commit 19965d7：PUT /accounts/roles/:role/permissions 保存默认矩阵时只 DELETE 不 INSERT），
--   但存量库里已有「权限页不改直接保存」产生的僵尸行——内容与默认矩阵逐字相同，却把租户定格在
--   落库那一刻，此后平台新增/修改权限该租户永远收不到（086 同源病灶；纵切①生产实查实证）。
--   本迁移清理存量：删除「与当前默认矩阵完全一致」的组 → hasPerm 回退默认矩阵，集合相同结果
--   相同，**零行为变化**，仅解除定格。
--
-- 【严格边界】
--   - 只删「集合与默认矩阵逐字相同」的 (tenant, role) 组：count = N 且组内全部 ∈ 期望集合
--     （(tenant_id, role, perm) 唯一，无重复行，故该条件=精确集合相等）；多一个点或少一个点都不动；
--   - admin 不参与（恒全放行，代码层禁改，本就无覆盖行）；
--   - 纯 DML，无 DDL，无 now() 索引谓词问题；
--   - 幂等：重复执行第二次删除 0 行。
--
-- 🔴 执行纪律：必须以 postgres 超管执行——role_permission 有 RLS（046:39-44，TO youfu_app），
--   youfu_app 无租户上下文裸查恒 0 行（假阴性陷阱，纵切①实证）。
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 087_zombie_perm_rows_cleanup.sql
--
-- 🔴 快照声明：下方期望集合 = src/middleware/role.ts DEFAULT_PERM_MATRIX 在 2026-09-14 的内容。
--   若未来默认矩阵已变更，请勿盲目重跑本文件——需先按新矩阵重新推导期望集合再清理，
--   否则会把「冻结在旧矩阵」的合法覆盖行误删（删行=升到新矩阵，属行为变更）。

-- ============ ① 盘点（只读）：现有覆盖行分布 + 是否为僵尸形态 ============
\echo '--- 087① 盘点：有覆盖行的 (tenant, role) 及行数 ---'
SELECT tenant_id, role, count(*)::int AS perm_count,
       string_agg(perm, ',' ORDER BY perm) AS perms
FROM role_permission
GROUP BY tenant_id, role
ORDER BY tenant_id, role;

-- ============ ② 删除：仅删「与默认矩阵逐字相同」的组（期望共 2 组 16 行：dispatcher 5 + operator 11）============
\echo '--- 087② 删除：僵尸覆盖行（RETURNING 留痕，期望 dispatcher 5 行 + operator 11 行）---'
-- dispatcher：默认矩阵 5 点（快照 2026-09-14）
DELETE FROM role_permission
WHERE (tenant_id, role) IN (
  SELECT tenant_id, role FROM role_permission
  WHERE role = 'dispatcher'
  GROUP BY tenant_id, role
  HAVING count(*) = 5
     AND count(*) FILTER (WHERE perm = ANY(ARRAY['asset.scan','dashboard.view','dispatch.override','inspect.execute','ticket.manage'])) = 5
)
RETURNING tenant_id, role, perm;

-- operator：默认矩阵 11 点（快照 2026-09-14，E-8 移除 settlement.read / E-9 加 consumable.consume 之后形态）
DELETE FROM role_permission
WHERE (tenant_id, role) IN (
  SELECT tenant_id, role FROM role_permission
  WHERE role = 'operator'
  GROUP BY tenant_id, role
  HAVING count(*) = 11
     AND count(*) FILTER (WHERE perm = ANY(ARRAY['asset.scan','basicdata.edit','consumable.consume','dashboard.view','dispatch.override','inspect.execute','intake.create','ticket.manage','volunteer.audit','volunteer.manage','volunteer.view'])) = 11
)
RETURNING tenant_id, role, perm;

-- worker：默认矩阵 4 点（快照 2026-09-14）
DELETE FROM role_permission
WHERE (tenant_id, role) IN (
  SELECT tenant_id, role FROM role_permission
  WHERE role = 'worker'
  GROUP BY tenant_id, role
  HAVING count(*) = 4
     AND count(*) FILTER (WHERE perm = ANY(ARRAY['inspect.execute','asset.scan','intake.create','consumable.consume'])) = 4
)
RETURNING tenant_id, role, perm;

-- reviewer：默认矩阵 2 点（快照 2026-09-14）
DELETE FROM role_permission
WHERE (tenant_id, role) IN (
  SELECT tenant_id, role FROM role_permission
  WHERE role = 'reviewer'
  GROUP BY tenant_id, role
  HAVING count(*) = 2
     AND count(*) FILTER (WHERE perm = ANY(ARRAY['dashboard.view','ticket.manage'])) = 2
)
RETURNING tenant_id, role, perm;

-- service_desk：默认矩阵 3 点（快照 2026-09-14）
DELETE FROM role_permission
WHERE (tenant_id, role) IN (
  SELECT tenant_id, role FROM role_permission
  WHERE role = 'service_desk'
  GROUP BY tenant_id, role
  HAVING count(*) = 3
     AND count(*) FILTER (WHERE perm = ANY(ARRAY['dashboard.view','ticket.manage','dispatch.override'])) = 3
)
RETURNING tenant_id, role, perm;

-- ============ ③ 复核：僵尸形态应清零（期望 0 行） ============
\echo '--- 087③ 复核：仍与默认矩阵逐字相同的组（期望 0 行）---'
SELECT tenant_id, role, count(*)::int AS perm_count FROM role_permission
WHERE role = 'dispatcher' GROUP BY tenant_id, role
HAVING count(*) = 5 AND count(*) FILTER (WHERE perm = ANY(ARRAY['asset.scan','dashboard.view','dispatch.override','inspect.execute','ticket.manage'])) = 5
UNION ALL
SELECT tenant_id, role, count(*)::int FROM role_permission
WHERE role = 'operator' GROUP BY tenant_id, role
HAVING count(*) = 11 AND count(*) FILTER (WHERE perm = ANY(ARRAY['asset.scan','basicdata.edit','consumable.consume','dashboard.view','dispatch.override','inspect.execute','intake.create','ticket.manage','volunteer.audit','volunteer.manage','volunteer.view'])) = 11
UNION ALL
SELECT tenant_id, role, count(*)::int FROM role_permission
WHERE role = 'worker' GROUP BY tenant_id, role
HAVING count(*) = 4 AND count(*) FILTER (WHERE perm = ANY(ARRAY['inspect.execute','asset.scan','intake.create','consumable.consume'])) = 4
UNION ALL
SELECT tenant_id, role, count(*)::int FROM role_permission
WHERE role = 'reviewer' GROUP BY tenant_id, role
HAVING count(*) = 2 AND count(*) FILTER (WHERE perm = ANY(ARRAY['dashboard.view','ticket.manage'])) = 2
UNION ALL
SELECT tenant_id, role, count(*)::int FROM role_permission
WHERE role = 'service_desk' GROUP BY tenant_id, role
HAVING count(*) = 3 AND count(*) FILTER (WHERE perm = ANY(ARRAY['dashboard.view','ticket.manage','dispatch.override'])) = 3
ORDER BY 1, 2;

-- ============ ④ 红线自证：剩余覆盖行清单（应只剩「真定制」组，当前生产期望 0 行） ============
\echo '--- 087④ 红线自证：清理后仍存在的覆盖行（当前生产期望 0 行；若有，均为内容≠默认矩阵的真定制，已按边界保留）---'
SELECT tenant_id, role, count(*)::int AS perm_count,
       string_agg(perm, ',' ORDER BY perm) AS perms
FROM role_permission
GROUP BY tenant_id, role
ORDER BY tenant_id, role;
