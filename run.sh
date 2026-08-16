#!/usr/bin/env bash
# 优服家后端最小闭环 运行脚本（bash，路径无 PowerShell 变量）
# 全部操作仅限本目录 (backend/)，不触碰 80/443 运行中的一站式服务平台。
#
# 用法:
#   ./run.sh install   # 安装依赖（仅本目录）
#   ./run.sh migrate   # 执行 001_init.sql（需 PG 就绪且已建 youfu_app 角色）
#   ./run.sh dev       # 启动开发服务（watch，端口 4001）
#   ./run.sh start     # 启动生产服务（端口 4001）

set -euo pipefail

# 解析脚本自身绝对路径，兼容含中文的父目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PG_READY="${PGHOST:-127.0.0.1}"

case "${1:-help}" in
  install)
    echo "[run.sh] npm install (backend/ only)"
    npm install
    ;;

  migrate)
    echo "[run.sh] ensure .env exists"
    if [ ! -f .env ]; then
      echo "  .env not found, copying from .env.example — please fill PGPASSWORD"
      cp .env.example .env
    fi
    echo "[run.sh] running migration against PG at $PG_READY"
    echo "  注意：执行前需已在 PG 创建非 superuser 角色 youfu_app 并授权库 youfu"
    npm run migrate
    ;;

  dev)
    echo "[run.sh] starting dev server on PORT=4001 (watch)"
    npm run dev
    ;;

  start)
    echo "[run.sh] starting server on PORT=4001"
    npm run start
    ;;

  *)
    echo "usage: ./run.sh {install|migrate|dev|start}"
    exit 1
    ;;
esac
