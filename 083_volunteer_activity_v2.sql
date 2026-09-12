-- 083_volunteer_activity_v2.sql —— E-6 清扫批次 V2-D：志愿者活动表补三列（路线图台账 V2-D）。
-- 三列全部可空：零回填、零断链、存量行零影响；为后续独立批次（GPS 签到等）预铺数据面。
--   user_id          TEXT NULL        预留关联账号（account_user.id），建活动人/负责人口径未定，仅占位
--   signup_deadline  timestamptz NULL 报名截止（业务校验「必须早于 end_at 若同给」在应用层 volunteer.ts 做，
--                                     DB 层不加 CHECK——与 012 现状一致，避免历史行回填争议）
--   description      TEXT NULL        活动描述（长文案，与 title/batch 短字段分离）
-- 编号顺延：082_account_phone.sql 已占用（账号权限一期），本迁移用 083。
-- 幂等：可重复执行。DDL 须以 superuser(postgres) 执行：
--   sudo -u postgres psql youfu -f 083_volunteer_activity_v2.sql

ALTER TABLE volunteer_activity ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE volunteer_activity ADD COLUMN IF NOT EXISTS signup_deadline timestamptz;
ALTER TABLE volunteer_activity ADD COLUMN IF NOT EXISTS description TEXT;

COMMENT ON COLUMN volunteer_activity.user_id IS
  '预留关联账号（E-6/V2-D 20260913）：TEXT NULL 占位，后续 GPS 签到等批次接入时定语义';
COMMENT ON COLUMN volunteer_activity.signup_deadline IS
  '报名截止（E-6/V2-D 20260913）：应用层校验须早于 end_at（若同给）；NULL=不设截止';
COMMENT ON COLUMN volunteer_activity.description IS
  '活动描述（E-6/V2-D 20260913）：长文案，NULL=未填';

-- volunteer_activity 已有 RLS TO youfu_app（012）与表级 GRANT（012），新列自动随行级策略生效，
-- 列级无需额外 GRANT；无新索引（三列均非高频过滤列，避免过度索引）。
-- 存量零回填：新列全 NULL，旧代码不读该列零影响。

-- 防御段（对齐 080/081/082 幂等风格）：重复执行 NOTICE 通过；列缺失则显式报错（预期不可达）
DO $$
DECLARE
  missing int;
BEGIN
  SELECT COUNT(*) INTO missing FROM information_schema.columns
  WHERE table_name = 'volunteer_activity'
    AND column_name IN ('user_id', 'signup_deadline', 'description');
  IF missing <> 3 THEN
    RAISE EXCEPTION '083: volunteer_activity 三列未全部就位（缺 % 列，预期不可能到达，请人工核查）', 3 - missing;
  END IF;
  RAISE NOTICE '083 ok: volunteer_activity.user_id/signup_deadline/description 已就位';
END $$;
