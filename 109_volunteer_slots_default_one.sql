-- 109_volunteer_slots_default_one.sql —— P0 志愿者最小修：数据库默认名额 0 → 1。
--
-- 【为什么需要】
--   应用层已统一为默认 1（volunteer.ts 的 zod default(1)、前端 InputNumber 默认 1），
--   但 012 建表时列默认仍是 0。任何绕过 API 的写入（运维 SQL、未来新脚本、种子）
--   省略 slots 就会得到 0 名额活动；报名守卫是 count >= slots ⇒ 永久满员，
--   发布者表面上"建了个活动"，实际谁都不能报名。
--
-- 【安全边界】
--   - 只改列默认值，不改任何存量行：已存在的 0 名额活动保持 0（尊重既有数据/显式意图）；
--   - 幂等：先比对当前默认值，已是 1 则 NOTICE 跳过；可重复执行；
--   - 无锁表重写（ALTER COLUMN SET DEFAULT 只改 catalog 默认值）。
--
-- 【回退】
--   ALTER TABLE volunteer_activity ALTER COLUMN slots SET DEFAULT 0;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'volunteer_activity'
      AND column_name = 'slots'
      AND column_default IS DISTINCT FROM '1'
  ) THEN
    ALTER TABLE volunteer_activity ALTER COLUMN slots SET DEFAULT 1;
    RAISE NOTICE '109: volunteer_activity.slots 默认值已由 0 对齐为 1';
  ELSE
    RAISE NOTICE '109: volunteer_activity.slots 默认值已是 1，跳过';
  END IF;
END $$;
