-- 118：巡更点位扫码签到（方向 B）
-- 1) 点位加 checkin_code（二维码内容），历史点位按 id 派生稳定码并回填。
-- 2) 租户内唯一，便于扫码后按码定位点位。
-- 3) 不改变既有任务/签到结构；checkins 继续用 jsonb，新增 via/code_verified 字段由应用写入。
ALTER TABLE patrol_point ADD COLUMN IF NOT EXISTS checkin_code text;

UPDATE patrol_point
   SET checkin_code = upper(substr(md5(id::text), 1, 8))
 WHERE checkin_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_patrol_point_checkin_code
  ON patrol_point (tenant_id, checkin_code)
  WHERE checkin_code IS NOT NULL;
