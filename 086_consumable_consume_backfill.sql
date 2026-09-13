-- 086_consumable_consume_backfill.sql —— E-9 §14 复议2：consumable.consume 覆盖行回填。
--
-- 【为什么需要它】
--   E-9 新增权限点 consumable.consume 的默认矩阵（role.ts DEFAULT_PERM_MATRIX）已含
--   worker + operator；但**平台代授覆盖表**（role_permission）一旦为某 (tenant, role) 落过行，
--   hasPerm 就走「覆盖集合」语义（不再看默认矩阵）——存量租户里那些已配过覆盖行的 worker/operator
--   会因此拿不到 consumable.consume，工人端领料当场 403，需人工逐个补行才能用。
--   本迁移把这一步自动化（一次性数据修正，人工动作转确定性脚本）。
--
-- 【严格边界（§14 复议2 红线）】
--   - 只回填 `consumable.consume` 一个权限点；**不回填** material.manage / asset.manage
--     （那两个是「管理动作收口 admin」的收紧，回填等于把收紧又放开）；
--   - **只给「已有覆盖行的 (tenant, role)」生成行**——数据源就是 role_permission 自身，
--     无覆盖行的租户**零行生成**（保持默认矩阵语义，不凭空造覆盖）；
--   - 角色限定 worker / operator（默认矩阵里只有这两个角色持有 consume）；
--   - ON CONFLICT (tenant_id, role, perm) DO NOTHING → 幂等，重复执行行数不变。
--
-- 【执行】以属主执行（RLS 对属主不强制；策略只对 youfu_app 生效）：
--   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 086_consumable_consume_backfill.sql
--   分段：① 盘点（只读，先看量）② 回填 ③ 复核（应 0 行）
-- 🔴本文件只做 DML（无 DDL），不含 now() 索引谓词问题。

-- ============ ① 盘点（只读）：现有覆盖行分布 ============
\echo '--- 086① 盘点：有覆盖行的 (tenant, role) 及其是否已含 consumable.consume ---'
SELECT rp.tenant_id,
       rp.role,
       COUNT(*)::int                                                   AS perm_count,
       BOOL_OR(rp.perm = 'consumable.consume')                          AS has_consume
FROM role_permission rp
WHERE rp.role IN ('worker', 'operator')
GROUP BY rp.tenant_id, rp.role
ORDER BY rp.tenant_id, rp.role;

-- ============ ② 回填：只给已有覆盖行的 (tenant, role) 补 consumable.consume ============
\echo '--- 086② 回填：consumable.consume（仅已有覆盖行的 worker/operator）---'
INSERT INTO role_permission (tenant_id, role, perm)
SELECT DISTINCT rp.tenant_id, rp.role, 'consumable.consume'
FROM role_permission rp
WHERE rp.role IN ('worker', 'operator')
  -- 显式表达「该 (tenant,role) 确实已有覆盖行」：rp 自身即证据，此 EXISTS 为可读性冗余但语义自证
  AND EXISTS (
    SELECT 1 FROM role_permission x
    WHERE x.tenant_id = rp.tenant_id AND x.role = rp.role
  )
ON CONFLICT (tenant_id, role, perm) DO NOTHING;

-- ============ ③ 复核：应返回 0 行 ============
\echo '--- 086③ 复核：仍缺 consumable.consume 的覆盖行组合（期望 0 行）---'
SELECT rp.tenant_id, rp.role
FROM role_permission rp
WHERE rp.role IN ('worker', 'operator')
GROUP BY rp.tenant_id, rp.role
HAVING NOT BOOL_OR(rp.perm = 'consumable.consume')
ORDER BY rp.tenant_id, rp.role;

-- ============ ④ 反向复核（红线自证）：未被回填的租户必须仍然零行 ============
-- 说明：无覆盖行的 (tenant,role) 组合在本迁移中不可能被创建；此处列出「该租户 worker/operator
-- 仅有 consumable.consume 一行」的异常形态（正常应为 0 行——那意味着我们凭空造了覆盖行）。
\echo '--- 086④ 红线自证：凭空生成的覆盖行（期望 0 行）---'
SELECT rp.tenant_id, rp.role
FROM role_permission rp
WHERE rp.role IN ('worker', 'operator')
GROUP BY rp.tenant_id, rp.role
HAVING COUNT(*) = 1 AND BOOL_OR(rp.perm = 'consumable.consume')
ORDER BY rp.tenant_id, rp.role;
