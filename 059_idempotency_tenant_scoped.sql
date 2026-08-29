-- 059：idempotency_key 幂等键改为「租户内唯一」(tenant_id, key)，而非全局 key 唯一。
--
-- 根因（R9-002）：原 001_init.sql 以 `key text PRIMARY KEY` 作全局唯一。
--   createWithIdem 的查键用 `key=$1 AND tenant_id=$2`（租户内查），但落键用
--   `ON CONFLICT (key) DO NOTHING`（全局冲突）。当不同租户复用同一幂等键时：
--     1) 本租户查键无命中 → 正常建单；
--     2) 落键时与另一租户的 key 冲突 → 静默丢弃本租户的幂等记录；
--     3) 本租户随后同键重试 → 查键仍无命中 → 再次建单 → 产生重复工单。
--   即跨租户键碰撞会静默破坏「本租户」的幂等保证（自损型，非越权泄露）。
--
-- 修复：主键改为 (tenant_id, key)，使幂等语义正确限定在租户内。
-- 应用前提：执行前确保无跨租户 key 重复（下方防御语句先去重，保留最早一条）。
-- 部署：需在有 PG 的环境（ECS）执行；本地 PG 不可用，未跑。

BEGIN;

-- 防御去重：保留每组 (key 跨租户重复) 中 created_at 最小的一条，删其余（UUID 键几乎不碰撞，极少触发）。
DELETE FROM idempotency_key a
USING idempotency_key b
WHERE a.key = b.key
  AND a.tenant_id <> b.tenant_id
  AND a.created_at > b.created_at;

ALTER TABLE idempotency_key DROP CONSTRAINT IF EXISTS idempotency_key_pkey;
ALTER TABLE idempotency_key ADD PRIMARY KEY (tenant_id, key);

COMMIT;
