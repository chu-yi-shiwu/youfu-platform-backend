-- 070_role_permission_roles_widen.sql —— 架构评审 R1：role_permission.role CHECK 未随 069 放宽（硬雷）。
-- 背景：046 建表时 role_permission.role 的 CHECK 是**内联**写法（CHECK (role IN ('admin','operator',
--       'dispatcher','worker'))），约束名为自动生成的 role_permission_role_check，仅放行 4 角色。
--       069 只放宽了 account_user.role，未同步本表。注册制批次二为开通流程新增「行业权限基线」第④步，
--       将按 6 角色写 role_permission 行 → 命中 23514 check_violation → 新租户开通事务整体回滚。
-- 放宽 CHECK 只增不改，对存量行零风险。应用侧（ROLES 单一事实源）已含全部 6 角色。
-- 幂等性：目标命名约束（role_permission_role_check）已存在且定义一致 → 跳过；否则先 DO 循环删除
--         本表一切含 'admin' 的旧 CHECK（含 046 内联生成的无名同名约束），再 ADD。可重复执行，收敛到同一终态。
--         一致性比对对两侧定义做「空格+逗号+括号全归一」（QA 实测 PG15：ANY(ARRAY[...]) 会被
--         pg_get_constraintdef 渲染为双层括号 CHECK ((role = ANY (ARRAY[...])))，仅去空白会误判不一致）。
-- 执行：DDL 须用 superuser：sudo -u postgres psql youfu -f 070_role_permission_roles_widen.sql

DO $$
DECLARE
  con text;
  target_def text;
  already_ok boolean;
BEGIN
  -- 目标定义（与 069 account_user 白名单同款写法）：6 角色放行
  target_def := 'CHECK (role = ANY (ARRAY[''admin''::text, ''operator''::text, ''dispatcher''::text, ''worker''::text, ''reviewer''::text, ''service_desk''::text]))';

  -- 先判断：同名且定义一致（空格+逗号+括号全归一比对，兼容 pg_get_constraintdef 的渲染差异）→ 跳过
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'role_permission'::regclass AND contype = 'c'
      AND conname = 'role_permission_role_check'
      AND regexp_replace(pg_get_constraintdef(oid), '[\s(),]', '', 'g')
          = regexp_replace(target_def, '[\s(),]', '', 'g')
  ) INTO already_ok;

  IF already_ok THEN
    RAISE NOTICE 'role_permission_role_check 已存在且定义一致（6 角色），跳过';
  ELSE
    -- 防重名：删除 role_permission 上一切含 'admin' 的旧 CHECK
    -- （覆盖 046 内联生成的 role_permission_role_check 及任何历史遗留命名）
    FOR con IN
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'role_permission'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%admin%'
    LOOP
      EXECUTE format('ALTER TABLE role_permission DROP CONSTRAINT %I', con);
    END LOOP;

    ALTER TABLE role_permission ADD CONSTRAINT role_permission_role_check
      CHECK (role = ANY (ARRAY[
        'admin'::text, 'operator'::text, 'dispatcher'::text, 'worker'::text,
        'reviewer'::text, 'service_desk'::text
      ]));
    RAISE NOTICE 'role_permission.role CHECK 已放宽为 6 角色';
  END IF;
END $$;
