-- 052_transport_track_photo.sql —— 运送轨迹点支持照片凭证（取件/签收防造假）
-- 初一 2026-08-24 业务合理性：取标本/送标本需拍照确认，照片随轨迹点落库审计
-- 本迁移为 DDL，须以 superuser(postgres) 执行：
--   psql "$DATABASE_URL_POSTGRES" -f 052_transport_track_photo.sql
ALTER TABLE transport_track_point ADD COLUMN IF NOT EXISTS photo text;
