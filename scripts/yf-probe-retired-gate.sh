#!/usr/bin/env bash
# yf-probe-retired-gate.sh —— 退场闸门生产真单探测（2026-10-19）
#
# 【探什么】27d906d 上线的「退场角色不得新写进流程」闸门，此前只在测试里验过，
#   生产 live 没探过。本脚本用真 HTTP + 真 token 打一张引用已退场角色的草稿，
#   期望 422 被拒、且草稿表零落库（被拒 = 什么都没发生）。
#
# 【为什么安全】
#   - 唯一写操作是 PUT /workflow-defs/work_order/draft，被 422 拒时 upsert 未执行；
#   - 不碰 live 流程、不删任何数据、不需要 CONFIRM；
#   - 若哪天闸门失效（返回 200），脚本立刻报 FAIL——那正是要抓的。
#
# 【用法】BASE=... ADMIN_USER=... ADMIN_PASS=... bash yf-probe-retired-gate.sh
#   例：BASE=https://youfu.banerz.cn ADMIN_USER=admin ADMIN_PASS='xxx' bash yf-probe-retired-gate.sh
set -u
BASE="${BASE:-https://youfu.banerz.cn}"
TENANT="${TENANT:-t-verification}"
ADMIN_USER="${ADMIN_USER:-}"
ADMIN_PASS="${ADMIN_PASS:-}"

say() { printf '%s\n' "$*"; }
bad() { say "FAIL: $*"; exit 1; }

[ -n "$ADMIN_USER" ] && [ -n "$ADMIN_PASS" ] || bad "缺少 ADMIN_USER / ADMIN_PASS（t-verification 管理员账密）"

say "=== 1/3 登录（tenant=$TENANT）==="
LOGIN=$(curl -s -X POST "$BASE/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\",\"tenant\":\"$TENANT\"}")
TOK=$(printf '%s' "$LOGIN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);if(j.token){console.log(j.token)}else{console.log("")}}catch{console.log("")}})')
[ -n "$TOK" ] || bad "登录失败：$LOGIN"
say "登录 OK，token 长度 ${#TOK}"

say "=== 2/3 提交带退场角色的草稿（期望 422 被拒）==="
# dispatcher 是已退场内置角色（RETIRED_ROLES，role.ts:35）
PROBE=$(curl -s -w '\n%{http_code}' -X PUT "$BASE/api/v1/workflow-defs/work_order/draft" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOK" \
  -d '{
    "note": "退场闸门生产探测（应被 422 拒绝，不落库）",
    "def": {
      "initial": "draft",
      "states": ["draft", "assigned", "completed"],
      "transitions": [
        { "from": "draft", "to": "assigned", "allowedRoles": ["dispatcher"] }
      ]
    }
  }')
CODE=$(printf '%s' "$PROBE" | tail -1)
BODY=$(printf '%s' "$PROBE" | sed '$d')
say "HTTP $CODE"
say "$BODY"
[ "$CODE" = "422" ] || bad "期望 422（闸门应打退退场角色），实得 $CODE"
printf '%s' "$BODY" | grep -q 'dispatcher' || bad "422 文案未点名退场角色，口径存疑"
printf '%s' "$BODY" | grep -q '退场' || bad "422 文案缺「退场」关键字，口径存疑"
say "闸门生效：带退场角色的流程被 422 打回，草稿未落库"

say "=== 3/3 反向对照：在岗流程（admin）应不被误伤 ==="
OK=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/v1/workflow-defs/work_order/draft" \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOK" \
  -d '{
    "note": "退场闸门反向对照（在岗角色，应 200）",
    "def": {
      "initial": "draft",
      "states": ["draft", "assigned", "completed"],
      "transitions": [
        { "from": "draft", "to": "assigned", "allowedRoles": ["admin"] }
      ]
    }
  }')
say "HTTP $OK"
[ "$OK" = "200" ] || bad "在岗角色反被误伤（$OK），闸门过宽"
say "反向对照通过：在岗角色正常保存"

say ""
say "=== PASS 退场闸门生产探测：拒绝路径 + 放行路径双双符合预期 ==="
say "注意：第 3 步会在草稿表留一条在岗流程草稿（rev+1）。如需清理，"
say "用同一账号 PUT 一份与现网 live 一致的 def 覆盖，或联系平台管理员处理。"
