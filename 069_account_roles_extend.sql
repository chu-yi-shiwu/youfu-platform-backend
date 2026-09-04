-- 069_account_roles_extend.sql —— AL-002 修复：account_user.role 白名单扩展。
-- 背景：workflow_def allowedRoles 与 stateMachine 转移早已引用 reviewer / service_desk
--       （approve/reject 用 reviewer；accept/dispatch/forward/claim 用 service_desk），
--       但应用层角色清单与 DB CHECK 约束均未放行 → 这两个角色建不出，审核支线实际仅 admin 可做。
-- 线上现状（2026-09-04 实证）：account_user_role_check = CHECK(role IN ('admin','operator','dispatcher','worker'))。
-- 放宽 CHECK 只增不改，对存量行零风险。应用侧（ROLES/z.enum/AccountRole）由同批代码修复对齐。
-- 执行：DDL 须用 superuser：sudo -u postgres psql youfu -f 069_account_roles_extend.sql

ALTER TABLE account_user DROP CONSTRAINT IF EXISTS account_user_role_check;

ALTER TABLE account_user ADD CONSTRAINT account_user_role_check
  CHECK (role = ANY (ARRAY[
    'admin'::text, 'operator'::text, 'dispatcher'::text, 'worker'::text,
    'reviewer'::text, 'service_desk'::text
  ]));
