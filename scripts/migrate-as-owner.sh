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
    # 单事务包裹（防半截）：psql -f 默认是 autocommit，每条语句各自提交。
    # 093 有 203 行多租户 jsonb 改写，一旦中途失败：① 已执行的语句不会回滚，留下
    # "部分租户改了、部分没改"的半截状态；② _migrations 的 INSERT 在整文件成功后才写，
    # 失败时不记账 → 下次重跑从头再来，已改的租户被再改一遍。
    # 用 --single-transaction 让「整个文件」成为原子单元：要么全成，要么全滚。
    # 例外：自带 BEGIN/COMMIT 的迁移（实测 059_idempotency_tenant_scoped.sql）不能再套一层，
    # 否则事务会在文件内部提前 COMMIT，外层再 COMMIT 报 "no transaction in progress"。
    if grep -qiE '^[[:space:]]*BEGIN[[:space:]]*;' "$f"; then
      sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f "$BACKEND_DIR/$f"
    else
      sudo -u postgres psql -d youfu --single-transaction -v ON_ERROR_STOP=1 -f "$BACKEND_DIR/$f"
    fi
    sudo -u postgres psql -d youfu -c "INSERT INTO _migrations(name) VALUES ('$f') ON CONFLICT DO NOTHING" >/dev/null
  fi
done
echo "migrate-as-owner: done"
