#!/bin/bash
# ============================================================
# 优服家 · 生产环境「非代码级可配置」端到端验证
# 建岗 → 配权 → 建号 → 真登录 → 权限真生效 → 无权限 403
#   → 停用只挡新增 → 存量不动 → 清理回基线
#
# 用法（必须 root）：
#   bash yf-verify-config.sh                  # 只读体检，零写入
#   CONFIRM=yes bash yf-verify-config.sh      # 实际执行（写+验证+清理）
#
# 安全设计：
#   1. 默认只读，必须显式 CONFIRM=yes 才写
#   2. JWT_SECRET 仅在进程环境内使用，绝不打印、不落盘
#   3. 所有写入走产品自己的 API，不写 SQL、不改表结构
#   4. 结束自动清理，并复查三张表行数是否回到执行前基线
#   5. 任一步失败即停，打印已完成步骤，便于手工收尾
# ============================================================
set -u

TENANT="${TENANT:-t-phasea}"
ROLE_A="verify_lead_a"
ROLE_B="verify_lead_b"
USER_A="verify_ua"
USER_B="verify_ub"
USER_C="verify_uc"
PW='Vf2026probe!x'
CONFIRM="${CONFIRM:-no}"

ENVF=/opt/youfu/backend/.env
NODE=/opt/node16/bin/node
[ -x "$NODE" ] || NODE=$(command -v node 2>/dev/null || echo '')
STEP="(未开始)"

say()  { echo "[$STEP] $*"; }
ok()   { echo "   OK   $*"; }
bad()  { echo ""; echo "########## FAIL ##########"; echo "停在：$STEP"; echo "原因：$*"; echo "上方日志已列出完成的步骤。脚本未自动回滚，请把这段输出发我。"; exit 1; }

echo "============================================================"
echo " 优服家 · 可配置能力端到端验证"
echo " tenant = $TENANT"
echo " 模式   = $([ "$CONFIRM" = "yes" ] && echo '写入验证' || echo '只读体检（不写任何数据）')"
echo "============================================================"

# ---------- 0 前置 ----------
STEP="前置检查"
[ "$(id -u)" = "0" ] || bad "需 root 执行（脚本要 sudo -u postgres 查库）"
[ -n "$NODE" ] || bad "找不到 node"
[ -f "$ENVF" ] || bad "缺 $ENVF"
command -v sudo >/dev/null 2>&1 || bad "缺 sudo"
command -v curl >/dev/null 2>&1 || bad "缺 curl"

BASE=""
for cand in http://127.0.0.1:4001 https://youfu.banerz.cn; do
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$cand/health" 2>/dev/null)
  [ "$c" = "200" ] && { BASE="$cand"; break; }
done
[ -n "$BASE" ] || bad "/health 不可达（127.0.0.1:4001 与 https://youfu.banerz.cn 均非 200）"
ok "后端可达：$BASE"

SECRET=$(grep -E '^JWT_SECRET=' "$ENVF" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r')
[ -n "$SECRET" ] || bad ".env 无 JWT_SECRET"
ok "JWT_SECRET 已读取（不打印）"

echo ""
echo "---- 后端认证模式 ----"
systemctl show youfu-backend -p Environment --no-pager 2>/dev/null | tr ' ' '\n' | grep -E '^(AUTH_MODE|NODE_ENV)=' || echo " (systemd 未设，以 .env 为准)"
grep -E '^AUTH_MODE=' "$ENVF" 2>/dev/null || echo " (.env 无 AUTH_MODE)"

# ---------- 工具 ----------
cat > /tmp/yf_jwt.js <<'JS'
const crypto = require('crypto');
const secret = process.env.YF_SECRET || '';
const payload = JSON.parse(process.argv[2]);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const h = b64({ alg: 'HS256', typ: 'JWT' });
const p = b64(payload);
const sig = crypto.createHmac('sha256', secret).update(h + '.' + p).digest('base64url');
process.stdout.write(h + '.' + p + '.' + sig);
JS

cat > /tmp/yf_jget.js <<'JS'
let s = '';
process.stdin.on('data', (d) => { s += d; }).on('end', () => {
  const path = process.argv[2] || '';
  let v;
  try { v = JSON.parse(s); } catch (e) { process.stdout.write(''); return; }
  for (const k of path.split('.').filter(Boolean)) {
    if (v === null || v === undefined) { v = undefined; break; }
    v = v[/^\d+$/.test(k) ? Number(k) : k];
  }
  if (v === undefined || v === null) process.stdout.write('');
  else if (typeof v === 'object') process.stdout.write(JSON.stringify(v));
  else process.stdout.write(String(v));
});
JS

jget() { "$NODE" /tmp/yf_jget.js "$1" < /tmp/yf_body 2>/dev/null; }

api() { # method path token [body] → 打印 http code；body 落 /tmp/yf_body
  local m="$1" p="$2" t="${3:-}" b="${4:-}"
  if [ -n "$b" ]; then
    curl -s -o /tmp/yf_body -w '%{http_code}' -X "$m" "$BASE/api/v1$p" \
      -H "Authorization: Bearer $t" -H 'Content-Type: application/json' --max-time 25 -d "$b"
  else
    curl -s -o /tmp/yf_body -w '%{http_code}' -X "$m" "$BASE/api/v1$p" \
      -H "Authorization: Bearer $t" --max-time 25
  fi
}

dbq() { sudo -u postgres psql -d youfu -tAc "$1" 2>/dev/null | head -1 | tr -d ' '; }

# ---------- 1 只读体检 ----------
STEP="体检"
echo ""
echo "---- 1.1 $TENANT 现有账号（看一眼是不是敏感真实客户）----"
sudo -u postgres psql -d youfu -c \
  "SELECT username, role, active FROM account_user WHERE tenant_id='$TENANT' ORDER BY role, username" 2>&1 | head -20

echo ""
echo "---- 1.2 基线行数（验证后必须回到这些数字）----"
B_ROLEDEF=$(dbq "SELECT count(*) FROM role_def WHERE tenant_id='$TENANT'")
B_ROLEPERM=$(dbq "SELECT count(*) FROM role_permission WHERE tenant_id='$TENANT'")
B_ACCT=$(dbq "SELECT count(*) FROM account_user WHERE tenant_id='$TENANT'")
echo " role_def        = ${B_ROLEDEF:-?}"
echo " role_permission = ${B_ROLEPERM:-?}"
echo " account_user    = ${B_ACCT:-?}"
[ -n "$B_ROLEDEF" ] || bad "查不到 role_def 行数（psql 权限或库名不对）"

echo ""
echo "---- 1.3 上次残留检查 ----"
LEFT=$(dbq "SELECT count(*) FROM role_def WHERE tenant_id='$TENANT' AND code LIKE 'verify_%'")
echo " verify_* 岗位残留 = ${LEFT:-?}"
[ "${LEFT:-0}" = "0" ] || bad "有残留（${LEFT} 行）。先手工清理再跑，否则岗位名冲突：sudo -u postgres psql -d youfu -c \"DELETE FROM role_permission WHERE tenant_id='$TENANT' AND role LIKE 'verify_%'; DELETE FROM account_user WHERE tenant_id='$TENANT' AND username LIKE 'verify_u%'; DELETE FROM role_def WHERE tenant_id='$TENANT' AND code LIKE 'verify_%';\""

echo ""
echo "---- 1.4 取一个真实 admin 做审计主体 ----"
ADMIN_UID=$(dbq "SELECT id FROM account_user WHERE tenant_id='$TENANT' AND role='admin' AND active LIMIT 1")
ADMIN_NAME=$(dbq "SELECT username FROM account_user WHERE tenant_id='$TENANT' AND role='admin' AND active LIMIT 1")
[ -n "$ADMIN_UID" ] || bad "$TENANT 里没有 active 的 admin 账号，无法自签合法 token"
ok "审计主体：$ADMIN_NAME（$ADMIN_UID）"

if [ "$CONFIRM" != "yes" ]; then
  echo ""
  echo "============================================================"
  echo " 以上为只读体检，未写任何数据。"
  echo " 确认 1.1 的账号名单不是敏感真实客户后，执行："
  echo "   CONFIRM=yes bash $0"
  echo "============================================================"
  exit 0
fi

# ---------- 2 签 admin token ----------
STEP="签 token"
EXP=$(( $(date +%s) + 1800 ))
ADMIN_TOK=$(YF_SECRET="$SECRET" "$NODE" /tmp/yf_jwt.js "{\"tid\":\"$TENANT\",\"sub\":\"$ADMIN_UID\",\"uid\":\"$ADMIN_UID\",\"username\":\"$ADMIN_NAME\",\"role\":\"admin\",\"exp\":$EXP}" 2>/dev/null)
[ -n "$ADMIN_TOK" ] || bad "token 签发失败"
C=$(api GET /auth/me "$ADMIN_TOK")
[ "$C" = "200" ] || bad "自签 admin token 被拒（/auth/me=$C，body=$(cat /tmp/yf_body)）"
ok "admin token 生效（/auth/me 200，role=$(jget user.role)）"

# ---------- 3 建岗位 A + 配权 ----------
STEP="建岗位A"
C=$(api POST /accounts/roles "$ADMIN_TOK" "{\"code\":\"$ROLE_A\",\"name\":\"验证组长临时\",\"description\":\"端到端验证用，验完即删\"}")
[ "$C" = "200" ] || [ "$C" = "201" ] || bad "建岗位 A 失败 HTTP=$C body=$(cat /tmp/yf_body)"
N=$(dbq "SELECT count(*) FROM role_def WHERE tenant_id='$TENANT' AND code='$ROLE_A'")
[ "$N" = "1" ] || bad "接口报成功但 role_def 查不到 $ROLE_A（假成功）"
ok "岗位 A 真落库（role_def=1）"

STEP="配权限"
C=$(api PUT "/accounts/roles/$ROLE_A/permissions" "$ADMIN_TOK" '{"perms":["workflow.approve"]}')
[ "$C" = "200" ] || bad "配权限失败 HTTP=$C body=$(cat /tmp/yf_body)"
N=$(dbq "SELECT count(*) FROM role_permission WHERE tenant_id='$TENANT' AND role='$ROLE_A' AND perm='workflow.approve'")
[ "$N" = "1" ] || bad "role_permission 查不到该行（假成功）"
ok "权限真落库（role_permission=1，workflow.approve）"

# ---------- 4 建账号 A + 真登录 ----------
STEP="建账号A"
C=$(api POST /accounts "$ADMIN_TOK" "{\"username\":\"$USER_A\",\"password\":\"$PW\",\"role\":\"$ROLE_A\",\"display_name\":\"验证账号A\"}")
[ "$C" = "200" ] || [ "$C" = "201" ] || bad "建账号 A 失败 HTTP=$C body=$(cat /tmp/yf_body)"
UID_A=$(jget item.id)
[ -n "$UID_A" ] || bad "建账号 A 未返回 id"
R=$(dbq "SELECT role FROM account_user WHERE tenant_id='$TENANT' AND username='$USER_A'")
[ "$R" = "$ROLE_A" ] || bad "账号 A 的 role 不是 $ROLE_A（实际 '$R'）"
ok "账号 A 落库，role=$ROLE_A（自定义岗位）"

STEP="账号A登录"
C=$(curl -s -o /tmp/yf_body -w '%{http_code}' -X POST "$BASE/api/v1/auth/login" \
  -H 'Content-Type: application/json' --max-time 25 \
  -d "{\"username\":\"$USER_A\",\"password\":\"$PW\",\"tenant\":\"$TENANT\"}")
[ "$C" = "200" ] || bad "账号 A 登录失败 HTTP=$C body=$(cat /tmp/yf_body)"
TOK_A=$(jget token)
[ -n "$TOK_A" ] || bad "登录未返回 token"
ok "账号 A 真登录成功（真密码→真 token）"

STEP="验权限生效"
C=$(api GET /workflow-defs/pending "$TOK_A")
[ "$C" = "200" ] || bad "配了 workflow.approve 但 /pending 返回 $C（body=$(cat /tmp/yf_body)）→ 权限没真生效"
ok "配了 workflow.approve → /workflow-defs/pending = 200 ✅"
C=$(api GET /auth/me "$TOK_A")
PERMS=$(jget permissions)
echo "   /auth/me permissions = $PERMS"
case "$PERMS" in
  *workflow.approve*) ok "登录态权限点含 workflow.approve" ;;
  *) bad "登录态权限点里没有 workflow.approve：$PERMS" ;;
esac

# ---------- 5 对照组：不配权必须 403 ----------
STEP="对照组"
C=$(api POST /accounts/roles "$ADMIN_TOK" "{\"code\":\"$ROLE_B\",\"name\":\"验证普通临时\",\"description\":\"对照组，不配任何权限\"}")
[ "$C" = "200" ] || [ "$C" = "201" ] || bad "建岗位 B 失败 HTTP=$C body=$(cat /tmp/yf_body)"
C=$(api POST /accounts "$ADMIN_TOK" "{\"username\":\"$USER_B\",\"password\":\"$PW\",\"role\":\"$ROLE_B\",\"display_name\":\"验证账号B\"}")
[ "$C" = "200" ] || [ "$C" = "201" ] || bad "建账号 B 失败 HTTP=$C body=$(cat /tmp/yf_body)"
UID_B=$(jget item.id)
C=$(curl -s -o /tmp/yf_body -w '%{http_code}' -X POST "$BASE/api/v1/auth/login" \
  -H 'Content-Type: application/json' --max-time 25 \
  -d "{\"username\":\"$USER_B\",\"password\":\"$PW\",\"tenant\":\"$TENANT\"}")
[ "$C" = "200" ] || bad "账号 B 登录失败 HTTP=$C body=$(cat /tmp/yf_body)"
TOK_B=$(jget token)
C=$(api GET /workflow-defs/pending "$TOK_B")
[ "$C" = "403" ] || bad "没配权限的岗位拿到 /pending（HTTP=$C）→ 权限门失效"
ok "没配 workflow.approve → /pending = 403 ✅（守卫有效）"

# ---------- 6 停用：只挡新增，不动存量 ----------
STEP="停用岗位A"
C=$(api PATCH "/accounts/roles/$ROLE_A" "$ADMIN_TOK" '{"enabled":false}')
[ "$C" = "200" ] || bad "停用岗位 A 失败 HTTP=$C body=$(cat /tmp/yf_body)"
E=$(dbq "SELECT enabled FROM role_def WHERE tenant_id='$TENANT' AND code='$ROLE_A'")
[ "$E" = "f" ] || bad "role_def.enabled 未变 false（实际 '$E'）"
ok "岗位 A 已停用（enabled=false）"

STEP="停用后建号"
C=$(api POST /accounts "$ADMIN_TOK" "{\"username\":\"$USER_C\",\"password\":\"$PW\",\"role\":\"$ROLE_A\"}")
[ "$C" = "400" ] || bad "停用岗位还能建号（HTTP=$C body=$(cat /tmp/yf_body)）→ 闸门失效"
ok "停用岗位 → 新建账号被拒 400（$(jget code)）"
N=$(dbq "SELECT count(*) FROM account_user WHERE tenant_id='$TENANT' AND username='$USER_C'")
[ "$N" = "0" ] || bad "被拒的新号居然落库了"
ok "被拒账号未落库（0 行）"

STEP="存量不受影响"
C=$(curl -s -o /tmp/yf_body -w '%{http_code}' -X POST "$BASE/api/v1/auth/login" \
  -H 'Content-Type: application/json' --max-time 25 \
  -d "{\"username\":\"$USER_A\",\"password\":\"$PW\",\"tenant\":\"$TENANT\"}")
[ "$C" = "200" ] || bad "岗位停用后存量账号 A 登录失败（HTTP=$C）→ 越权影响存量"
ok "存量账号 A 仍可登录"
TOK_A2=$(jget token)
C=$(api GET /workflow-defs/pending "$TOK_A2")
[ "$C" = "200" ] || bad "存量账号 A 权限掉了（HTTP=$C）→ 停用不该回收存量权限"
ok "存量账号 A 权限仍在（/pending 仍 200）"

# ---------- 7 清理 ----------
STEP="清理"
CA=$(api DELETE "/accounts/$UID_B" "$ADMIN_TOK"); echo "   删账号 B → $CA"
CB=$(api DELETE "/accounts/$UID_A" "$ADMIN_TOK"); echo "   删账号 A → $CB"
CC=$(api DELETE "/accounts/roles/$ROLE_B" "$ADMIN_TOK"); echo "   删岗位 B → $CC"
CD=$(api DELETE "/accounts/roles/$ROLE_A" "$ADMIN_TOK"); echo "   删岗位 A → $CD"

A_ROLEDEF=$(dbq "SELECT count(*) FROM role_def WHERE tenant_id='$TENANT'")
A_ROLEPERM=$(dbq "SELECT count(*) FROM role_permission WHERE tenant_id='$TENANT'")
A_ACCT=$(dbq "SELECT count(*) FROM account_user WHERE tenant_id='$TENANT'")
echo ""
echo "---- 清理后 vs 基线 ----"
echo " role_def        : $A_ROLEDEF / $B_ROLEDEF"
echo " role_permission : $A_ROLEPERM / $B_ROLEPERM"
echo " account_user    : $A_ACCT / $B_ACCT"

RC=0
[ "$A_ROLEDEF" = "$B_ROLEDEF" ]   || { echo "   !! role_def 未回基线"; RC=1; }
[ "$A_ROLEPERM" = "$B_ROLEPERM" ] || { echo "   !! role_permission 未回基线"; RC=1; }
[ "$A_ACCT" = "$B_ACCT" ]         || { echo "   !! account_user 未回基线"; RC=1; }
[ "$RC" = "0" ] && ok "三张表全部回到基线（零残留）"

echo ""
if [ "$RC" = "0" ]; then
  echo "============================================================"
  echo " PASS  建岗→配权→建号→真登录→权限生效→无权限403"
  echo "       →停用只挡新增→存量不动→清理零残留"
  echo "============================================================"
  exit 0
else
  echo "============================================================"
  echo " PARTIAL  功能验证通过，但清理未回基线，手工收尾："
  echo " sudo -u postgres psql -d youfu -c \"DELETE FROM role_permission WHERE tenant_id='$TENANT' AND role LIKE 'verify_%'; DELETE FROM account_user WHERE tenant_id='$TENANT' AND username LIKE 'verify_u%'; DELETE FROM role_def WHERE tenant_id='$TENANT' AND code LIKE 'verify_%';\""
  echo "============================================================"
  exit 1
fi
