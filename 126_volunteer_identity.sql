-- 126_volunteer_identity.sql（2026-11-20）
-- 志愿者身份从姓名文本迁移到稳定账号 ID；user_name 保留展示与旧数据兼容。
-- 回填仅处理“租户内姓名唯一且已绑定 account_id”的 worker，避免重名误配。
ALTER TABLE volunteer_record ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE volunteer_blacklist ADD COLUMN IF NOT EXISTS user_id uuid;

WITH uniq_worker AS (
  SELECT tenant_id, name, min(account_id) AS account_id
    FROM worker
   WHERE account_id IS NOT NULL
   GROUP BY tenant_id, name
  HAVING count(*) = 1
)
UPDATE volunteer_record r
   SET user_id = u.account_id::uuid
  FROM uniq_worker u
 WHERE r.tenant_id = u.tenant_id
   AND r.user_name = u.name
   AND r.user_id IS NULL;

WITH uniq_worker AS (
  SELECT tenant_id, name, min(account_id) AS account_id
    FROM worker
   WHERE account_id IS NOT NULL
   GROUP BY tenant_id, name
  HAVING count(*) = 1
)
UPDATE volunteer_blacklist b
   SET user_id = u.account_id::uuid
  FROM uniq_worker u
 WHERE b.tenant_id = u.tenant_id
   AND b.user_name = u.name
   AND b.user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_volunteer_record_tenant_user
  ON volunteer_record (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_volunteer_blacklist_tenant_user
  ON volunteer_blacklist (tenant_id, user_id);
