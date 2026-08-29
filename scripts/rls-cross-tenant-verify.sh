#!/bin/bash
# RLS 跨租户实读真验脚本
# 作用：SSH 到 ECS 生产库，插入两个探针租户的行，验证租户 A 读不到租户 B、反之亦然，
#        并验证各自能读到自己的行，最后 ROLLBACK（不落库）。作为铁底线的每日自动回归。
# 退出：通过 exit 0；任一泄漏或可见性异常 exit 1；无法连接 ECS 也 exit 1（不静默通过）。
set -uo pipefail

ECS_HOST="${ECS_HOST:-8.136.107.153}"
ECS_KEY="${ECS_KEY:-$HOME/.ssh/aliyun_energy}"
ECS_USER="${ECS_USER:-root}"
REMOTE_ENV="${REMOTE_ENV:-/opt/youfu/backend/.env}"

SQL=$(cat <<'SQLEOF'
BEGIN;
SET LOCAL app.tenant_id = 'rls_probe_a';
INSERT INTO term (tenant_id, code, default_label) VALUES ('rls_probe_a','rls_probe','A');
SET LOCAL app.tenant_id = 'rls_probe_b';
INSERT INTO term (tenant_id, code, default_label) VALUES ('rls_probe_b','rls_probe','B');
SET LOCAL app.tenant_id = 'rls_probe_b';
SELECT 'leakA_in_B=' || count(*) FROM term WHERE tenant_id='rls_probe_a';
SET LOCAL app.tenant_id = 'rls_probe_a';
SELECT 'leakB_in_A=' || count(*) FROM term WHERE tenant_id='rls_probe_b';
SET LOCAL app.tenant_id = 'rls_probe_a';
SELECT 'ownA=' || count(*) FROM term WHERE tenant_id='rls_probe_a';
SET LOCAL app.tenant_id = 'rls_probe_b';
SELECT 'ownB=' || count(*) FROM term WHERE tenant_id='rls_probe_b';
ROLLBACK;
SQLEOF
)

OUT=$(ssh -i "$ECS_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=20 "$ECS_USER@$ECS_HOST" \
  "bash -c 'PW=\$(grep \"^PGPASSWORD=\" $REMOTE_ENV | head -1 | cut -d= -f2-); export PGPASSWORD=\"\$PW\"; psql -h 127.0.0.1 -p 5432 -U youfu_app -d youfu -t -A -f -'" <<< "$SQL") || {
  echo "RLS 跨租户实读：无法连接 ECS / 执行失败 ❌"
  exit 1
}

echo "$OUT"
leakA=$(echo "$OUT" | grep '^leakA_in_B=' | cut -d= -f2)
leakB=$(echo "$OUT" | grep '^leakB_in_A=' | cut -d= -f2)
ownA=$(echo "$OUT" | grep '^ownA=' | cut -d= -f2)
ownB=$(echo "$OUT" | grep '^ownB=' | cut -d= -f2)

if [ "$leakA" = "0" ] && [ "$leakB" = "0" ] && [ "$ownA" = "1" ] && [ "$ownB" = "1" ]; then
  echo "RLS 跨租户实读：通过 ✅"
  exit 0
else
  echo "RLS 跨租户实读：未通过 ❌ (leakA_in_B=$leakA leakB_in_A=$leakB ownA=$ownA ownB=$ownB)"
  exit 1
fi
