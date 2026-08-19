#!/usr/bin/env bash
# 以数据库属主(postgres)身份幂等应用尚未执行的迁移。
# 应用连接角色 youfu_app 是受 RLS 约束的非属主角色，无权执行 DDL(ALTER/CREATE)，
# 因此迁移必须在 ECS 上以 postgres 身份运行。本脚本保证只应用 _migrations 中未记录的项。
set -euo pipefail
BACKEND_DIR="${1:-/opt/youfu/backend}"
cd "$BACKEND_DIR"

# 确保追踪表存在
sudo -u postgres psql -d youfu -c "CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())" >/dev/null

for f in $(ls [0-9][0-9][0-9]_*.sql 2>/dev/null | sort); do
  exists=$(sudo -u postgres psql -d youfu -t -c "SELECT 1 FROM _migrations WHERE name='$f'" | tr -d ' ')
  if [ "$exists" = "1" ]; then
    echo "skip (already applied): $f"
  else
    echo "apply: $f"
    sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f "$BACKEND_DIR/$f"
    sudo -u postgres psql -d youfu -c "INSERT INTO _migrations(name) VALUES ('$f') ON CONFLICT DO NOTHING" >/dev/null
  fi
done
echo "migrate-as-owner: done"
