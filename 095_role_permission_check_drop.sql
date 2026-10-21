-- 095_role_permission_check_drop.sql —— 撤销 role_permission.role 的内置角色枚举 CHECK，回到 090 的"放宽"终态。
--
-- 【为什么必须做这一步】
--   090_role_def.sql 为支持「租户自建岗位」，有意 DROP 掉 account_user.role / role_permission.role
--   上的内置枚举 CHECK 且**不替换**（角色合法性改由应用层 isRoleUsable：内置 ROLES ∪ 本租户 role_def）。
--   但 services/roleWhitelist.ts 的启动门写于 070 时代，仍断言「CHECK 必须含 6 角色」，
--   090 一应用 → 服务拒绝启动（2026-10-17 生产实测：重启后 5s 一次失败重启循环）。
--   应急处置时手工补回了 070 的 6 角色 CHECK 让服务起来，代价是**自定义岗位配权限必 23514**
--   （PUT /accounts/roles/:role/permissions 写 role_permission，role 是自建 code → 被 CHECK 拒）。
--
-- 【本迁移做什么】
--   撤销任何残留的内置角色枚举 CHECK（按定义内容 ILIKE '%admin%' 定位，兼容 046 内联生成的
--   不可预期命名），让 role_permission 回到 090 的放宽终态。启动门同步改造为
--   「090 已记账 + 无 CHECK ⇒ 预期终态，放行」（MIG_090_SQL），两侧口径对齐后服务正常启动。
--
-- 【安全性】
--   - 只 DROP 约束，不动数据行（role_permission 生产实测 0 行，且 DROP CHECK 对存量行零影响）；
--   - 表不存在（to_regclass 返回 NULL）→ 循环 0 次，不报错；
--   - 无匹配 CHECK → 循环 0 次，可重复执行，收敛到同一终态。
--
-- 执行：DDL 须用 superuser：sudo -u postgres psql -d youfu -f 095_role_permission_check_drop.sql

DO $$
DECLARE
  con text;
  dropped int := 0;
BEGIN
  FOR con IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.contype = 'c'
       AND c.conrelid = to_regclass('role_permission')
       AND pg_get_constraintdef(c.oid) ILIKE '%admin%'
  LOOP
    EXECUTE format('ALTER TABLE role_permission DROP CONSTRAINT %I', con);
    dropped := dropped + 1;
    RAISE NOTICE '095 撤销 role_permission 角色枚举 CHECK：%', con;
  END LOOP;

  IF dropped = 0 THEN
    RAISE NOTICE '095 未发现内置角色枚举 CHECK（已放宽或表不存在），无需处理';
  END IF;
END $$;
