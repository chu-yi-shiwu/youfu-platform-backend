-- 082_account_phone.sql —— 账号权限一期：账号手机号字段（设计稿 §2，编号按任务书纠正 081→082：
-- 081 已被 D-2 批次 081_volunteer_checkin_late.sql 占用，BE main=a92bf33 已 live）
-- phone TEXT NULL：短信网关未接（外部依赖缺口），一期仅档案字段+展示，不做验证码登录。
-- 唯一性：同租户内不重号；空串视为未填，与 NULL 一并排除出唯一约束。
-- 077 教训遵守：部分索引谓词仅含 IS NOT NULL / <> ''（IMMUTABLE），禁 now()。
-- 幂等：可重复执行。DDL 须以 superuser(postgres) 执行：
--   sudo -u postgres psql youfu -f 082_account_phone.sql

ALTER TABLE account_user ADD COLUMN IF NOT EXISTS phone TEXT;

DROP INDEX IF EXISTS idx_account_phone_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_phone_unique
  ON account_user (tenant_id, phone)
  WHERE phone IS NOT NULL AND phone <> '';

COMMENT ON COLUMN account_user.phone IS
  '账号手机号（账号权限一期 20260913）：一期仅档案展示，不做验证码登录；同租户唯一（NULL/空串不参与唯一约束）';

-- account_user 已有 RLS TO youfu_app（007），新列随行级策略自动生效，无需新策略；
-- 已 GRANT 表级权限（007），列级无需额外 GRANT。
-- 存量零回填：新列全 NULL，唯一索引无冲突风险；旧代码不读该列零影响。

-- 防御段（对齐 081 幂等风格）：重复执行 NOTICE 通过；列缺失则显式报错（预期不可达）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'account_user' AND column_name = 'phone'
  ) THEN
    RAISE EXCEPTION '082: account_user.phone 添加失败（预期不可能到达，请人工核查）';
  END IF;
  RAISE NOTICE '082 ok: account_user.phone 已就位';
END $$;
