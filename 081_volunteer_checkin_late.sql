-- 081_volunteer_checkin_late.sql —— D-2：checkin 过期补签留痕（P3-4，初一拍板"过期 3 天内可补签"2026-09-12）
-- 背景（挂账台账 P3-4/D-2）：volunteer checkin 此前无任何过期守卫、无补签标记——
-- 超期任意久的签到与正常签到在数据上无差别（假考勤风险，QA 20260912 审查遗留）。
-- 方案（最小实现）：仅加一列留痕标记，零新表、零状态机改动、零新端点。
--   check_in_late：签到发生在活动 end_at 之后但在 3 天宽限期内 → true；正常签到 → false。
--   >3 天在路由层 409 CHECKIN_EXPIRED 拒绝（见 src/routes/volunteer.ts D-2 守卫）。
-- 幂等：IF NOT EXISTS，可重复执行。DDL 须以 superuser(postgres) 执行：
--   sudo -u postgres psql youfu -f 081_volunteer_checkin_late.sql

ALTER TABLE volunteer_record
  ADD COLUMN IF NOT EXISTS check_in_late boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN volunteer_record.check_in_late IS
  '补签标记（D-2 20260912）：签到时活动 end_at 已过但在 3 天宽限期内 -> true，防假考勤留痕';

-- 防御段（对齐 080 幂等风格）：重复执行 NOTICE 通过；列缺失则显式报错（预期不可达）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'volunteer_record' AND column_name = 'check_in_late'
  ) THEN
    RAISE EXCEPTION '081: volunteer_record.check_in_late 添加失败（预期不可能到达，请人工核查）';
  END IF;
  RAISE NOTICE '081 ok: volunteer_record.check_in_late 已就位';
END $$;
