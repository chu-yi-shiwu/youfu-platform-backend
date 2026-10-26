#!/usr/bin/env bash
# 以数据库属主(postgres)身份幂等应用尚未执行的迁移。
# 应用连接角色 youfu_app 是受 RLS 约束的非属主角色，无权执行 DDL(ALTER/CREATE)，
# 因此迁移必须在 ECS 上以 postgres 身份运行。本脚本保证只应用 _migrations 中未记录的项。
#
# 🔴 上线前必做：Windows 检出会把本文件变成 CRLF（本仓 core.autocrlf=true，
#    git blob 里存的是 LF，只有本地工作副本是 CRLF）。若直接把工作目录打成 tar/scp 到 Linux，
#    解压后 `set -euo pipefail\r` 会报 line N: set: pipefail\r: invalid option name 而整个迁移挂掉
#    （2026-10-26 部署时踩过一次，当时 scripts/ 下 22 个文件全被覆盖成 CRLF）。
#    ⇒ 打包前务必先做 CRLF→LF 归一化（或直接 `git archive` 取已提交的 LF blob，不要拷工作副本）。
set -euo pipefail
BACKEND_DIR="${1:-/opt/youfu/backend}"
# postgres 用户的运行目录：sudo -u 不重置 CWD，若调用时 CWD 是 /root（0700，postgres 无 x 权限）
# 会直接报 "could not change directory to /root: Permission denied" 而失败 ——
# ssh 非交互式远程命令的 CWD 恰好就是 $HOME=/root，用 ssh 包一层必踩。
# 因此先在 BACKEND_DIR 取文件清单，再显式切到 /tmp（1777，任何用户可进入）后才调 psql。
RUN_DIR="${RUN_DIR:-/tmp}"

cd "$BACKEND_DIR"
FILES=$(ls [0-9][0-9][0-9]_*.sql 2>/dev/null | sort || true)
cd "$RUN_DIR"

# 确保追踪表存在
sudo -u postgres psql -d youfu -c "CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())" >/dev/null

for f in $FILES; do
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
    # 注意：$f 必须用绝对路径 —— 上面已 cd 到 RUN_DIR，相对路径会 "No such file or directory"，
    # 使探测恒失败、自带事务的迁移（059）被双层包裹。
    if grep -qiE '^[[:space:]]*BEGIN[[:space:]]*;' "$BACKEND_DIR/$f"; then
      sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f "$BACKEND_DIR/$f"
    else
      sudo -u postgres psql -d youfu --single-transaction -v ON_ERROR_STOP=1 -f "$BACKEND_DIR/$f"
    fi
    sudo -u postgres psql -d youfu -c "INSERT INTO _migrations(name) VALUES ('$f') ON CONFLICT DO NOTHING" >/dev/null
  fi
done
echo "migrate-as-owner: done"
