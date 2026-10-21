-- 090_role_def.sql —— 地基返工 ①：角色可配置（租户级自定义角色）
-- ───────────────────────────────────────────────────────────────────────────
-- 根因（实测证据链）：
--   角色被 DB CHECK 锁死为 6 个枚举 —— 007_account.sql:14（admin/operator）
--   → 046_role_permission.sql:24,33（扩 4 档）→ 070_role_permission_roles_widen.sql:20,45（扩 6 档）。
--   后果：单位无法自建岗位 → 遇到真实岗位只能由开发者往枚举里加。
--   AL-002（2026-09-04）补 reviewer / service_desk 即此妥协的直接产物，
--   见 src/middleware/role.ts:8-10 原文："账号层建不出 → 补两角色"。
--   连带后果：审核只能做成「独立岗位」，做不出「可叠加给任何人的权限属性」；
--   dispatcher 这个 PRD §7 岗位表里根本不存在的岗位也由此混入。
--
-- 本步只做数据库地基，**存量账号 role 值零变更**：
--   ① 建 role_def（租户自定义角色表）
--   ② 放宽 account_user.role / role_permission.role 上的枚举 CHECK
--   内置 6 角色继续由代码常量 ROLES 提供（role.ts:14），不落库、不改值 → 平滑过渡。
--
-- 代码层改造（ROLES 常量全仓 26 处引用、ROLE_RANK、DEFAULT_PERM_MATRIX、
--   workflow_def allowedRoles 指向 role_def）为第②③步，**不在本迁移范围**。
--
-- 诚实边界：放宽 CHECK 后，DB 不再约束 role 字面量，校验责任上移到应用层。
--   本迁移落地后、代码层改造完成前，写入路径仍走既有 ROLES 常量校验（存量行为不变），
--   因此本步不引入新的可写面。
--
-- 幂等：全 IF NOT EXISTS / DROP ... IF EXISTS / DO 块收敛，可重复执行。
-- 执行：须属主 sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f 090_role_def.sql
-- ───────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS role_def (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  code        text NOT NULL,                        -- 角色代号：小写字母开头，业务侧唯一
  name        text NOT NULL,                        -- 角色显示名（各单位自己的叫法，如「维修组长」）
  description text,
  enabled     boolean NOT NULL DEFAULT true,
  sort        int NOT NULL DEFAULT 100,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- 形状约束：防空格/大写/特殊字符混入（role 会进入 allowedRoles 与鉴权分支）
  CONSTRAINT role_def_code_format CHECK (code ~ '^[a-z][a-z0-9_]{1,31}$'),
  -- 内置 6 角色由代码常量 ROLES 提供，禁止租户建同名行覆盖其语义。
  -- 注：内置角色的「显示名改叫法」属 PRD 术语配置范畴，另行设计，不在本步。
  CONSTRAINT role_def_code_reserved CHECK (
    code NOT IN ('admin', 'operator', 'dispatcher', 'worker', 'reviewer', 'service_desk')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_role_def_tenant_code ON role_def (tenant_id, code);
CREATE INDEX IF NOT EXISTS idx_role_def_tenant ON role_def (tenant_id, enabled);

ALTER TABLE role_def ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS role_def_tenant_isolation ON role_def;
CREATE POLICY role_def_tenant_isolation ON role_def
  FOR ALL TO youfu_app
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON role_def TO youfu_app;

-- ============ 放宽 account_user.role / role_permission.role 的枚举 CHECK ============
-- 只放宽（DROP 含内置枚举的 CHECK），不替换为新枚举：
--   内置角色 → 代码常量校验；自定义角色 → role_def + 应用层校验。
-- 070 的教训：约束由 CHECK 内联生成时名字不可预期，故按定义内容动态定位，
--   与 070_role_permission_roles_widen.sql:34-41 同手法，只增只删、对存量行零影响。
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT c.conrelid::regclass::text AS tbl, c.conname
    FROM pg_constraint c
    WHERE c.contype = 'c'
      -- to_regclass（表不存在时返回 NULL，不报错）：本迁移可能先于某些表的建立被执行，
      -- 用 ::regclass 会直接抛「关系不存在」而整体失败（本机残缺库实测复现）。
      AND c.conrelid IN (to_regclass('account_user'), to_regclass('role_permission'))
      AND pg_get_constraintdef(c.oid) ILIKE '%role%'
      AND pg_get_constraintdef(c.oid) ILIKE '%admin%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', rec.tbl, rec.conname);
    RAISE NOTICE '090 放宽角色枚举 CHECK：% . %', rec.tbl, rec.conname;
  END LOOP;
END $$;
