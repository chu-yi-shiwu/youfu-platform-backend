#!/bin/bash
# 优服家 · 可配置能力端到端验证（默认只读；CONFIRM=yes 才写）
set -u
T="${TENANT:-t-phasea}"; CONFIRM="${CONFIRM:-no}"
ENVF=/opt/youfu/backend/.env
NODE=/opt/node16/bin/node; [ -x "$NODE" ] || NODE=$(command -v node)
STEP=init
ok(){ echo "   OK   $*"; }
bad(){ echo; echo "##### FAIL @ $STEP #####"; echo "$*"; echo "已完成步骤见上。未自动回滚，请把输出发我。"; exit 1; }

echo "== 优服家可配置验证 | tenant=$T | 模式=$([ "$CONFIRM" = yes ] && echo 写入 || echo 只读) =="
STEP=pre
[ "$(id -u)" = 0 ] || bad "需 root"
[ -n "${NODE:-}" ] || bad "找不到 node"
[ -f "$ENVF" ] || bad "缺 $ENVF"
BASE=""
for b in http://127.0.0.1:4001 https://youfu.banerz.cn; do
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$b/health")" = 200 ] && { BASE=$b; break; }
done
[ -n "$BASE" ] || bad "/health 不可达"
SECRET=$(grep -E '^JWT_SECRET=' "$ENVF" | head -1 | cut -d= -f2- | tr -d '"'"'"'\r')
[ -n "$SECRET" ] || bad ".env 无 JWT_SECRET"
ok "base=$BASE  secret=已读取"

cat > /tmp/j.js <<'JS'
const c=require('crypto'),s=process.env.K||'',p=JSON.parse(process.argv[2]);
const b=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
const h=b({alg:'HS256',typ:'JWT'}),q=b(p);
process.stdout.write(h+'.'+q+'.'+c.createHmac('sha256',s).update(h+'.'+q).digest('base64url'));
JS
cat > /tmp/g.js <<'JS'
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
 let v;try{v=JSON.parse(s)}catch(e){return process.stdout.write('')}
 for(const k of (process.argv[2]||'').split('.').filter(Boolean)){if(v==null){v=undefined;break}v=v[/^\d+$/.test(k)?+k:k]}
 if(v==null)v='';process.stdout.write(typeof v==='object'?JSON.stringify(v):String(v))});
JS
g(){ "$NODE" /tmp/g.js "$1" </tmp/b 2>/dev/null; }
api(){ local m=$1 p=$2 t=${3:-} d=${4:-}
  if [ -n "$d" ]; then curl -s -o /tmp/b -w '%{http_code}' -X "$m" "$BASE/api/v1$p" -H "Authorization: Bearer $t" -H 'Content-Type: application/json' --max-time 25 -d "$d"
  else curl -s -o /tmp/b -w '%{http_code}' -X "$m" "$BASE/api/v1$p" -H "Authorization: Bearer $t" --max-time 25; fi; }
q(){ sudo -u postgres psql -d youfu -tAc "$1" 2>/dev/null | head -1 | tr -d ' '; }

STEP=体检
echo; echo "--- 该租户现有账号（确认不是敏感真实客户）---"
sudo -u postgres psql -d youfu -c "SELECT username,role,active FROM account_user WHERE tenant_id='$T' ORDER BY role,username" | head -15
B1=$(q "SELECT count(*) FROM role_def WHERE tenant_id='$T'")
B2=$(q "SELECT count(*) FROM role_permission WHERE tenant_id='$T'")
B3=$(q "SELECT count(*) FROM account_user WHERE tenant_id='$T'")
echo "基线: role_def=$B1 role_permission=$B2 account_user=$B3"
LEFT=$(q "SELECT count(*) FROM role_def WHERE tenant_id='$T' AND code LIKE 'verify_%'")
[ "$LEFT" = 0 ] || bad "有 verify_* 残留 $LEFT 行，先清理"
AU=$(q "SELECT id FROM account_user WHERE tenant_id='$T' AND role='admin' AND active LIMIT 1")
AN=$(q "SELECT username FROM account_user WHERE tenant_id='$T' AND role='admin' AND active LIMIT 1")
[ -n "$AU" ] || bad "$T 无 active admin"
ok "审计主体=$AN($AU)"

if [ "$CONFIRM" != yes ]; then
  echo; echo "== 只读体检结束，未写任何数据 =="
  echo "确认上面账号名单可接受后执行： CONFIRM=yes bash $0"
  exit 0
fi

STEP=签token
TOK=$(K="$SECRET" "$NODE" /tmp/j.js "{\"tid\":\"$T\",\"sub\":\"$AU\",\"uid\":\"$AU\",\"username\":\"$AN\",\"role\":\"admin\",\"exp\":$(( $(date +%s)+1800 ))}")
[ "$(api GET /auth/me "$TOK")" = 200 ] || bad "admin token 被拒: $(cat /tmp/b)"
ok "admin token 生效"

STEP=建岗A
[ "$(api POST /accounts/roles "$TOK" "{\"code\":\"verify_lead_a\",\"name\":\"验证组长临时\",\"description\":\"验完即删\"}")" = 200 ] || bad "建岗A: $(cat /tmp/b)"
[ "$(q "SELECT count(*) FROM role_def WHERE tenant_id='$T' AND code='verify_lead_a'")" = 1 ] || bad "role_def 未落库"
ok "岗位A 真落库"

STEP=配权
[ "$(api PUT /accounts/roles/verify_lead_a/permissions "$TOK" '{"perms":["workflow.approve"]}')" = 200 ] || bad "配权: $(cat /tmp/b)"
[ "$(q "SELECT count(*) FROM role_permission WHERE tenant_id='$T' AND role='verify_lead_a' AND perm='workflow.approve'")" = 1 ] || bad "role_permission 未落库"
ok "权限真落库"

STEP=建号A
C=$(api POST /accounts "$TOK" "{\"username\":\"verify_ua\",\"password\":\"Vf2026probe7x\",\"role\":\"verify_lead_a\"}")
[ "$C" = 200 ] || [ "$C" = 201 ] || bad "建号A HTTP=$C: $(cat /tmp/b)"
UA=$(g item.id)
[ "$(q "SELECT role FROM account_user WHERE tenant_id='$T' AND username='verify_ua'")" = verify_lead_a ] || bad "账号A role 不对"
ok "账号A role=verify_lead_a id=$UA"

STEP=登录A
[ "$(curl -s -o /tmp/b -w '%{http_code}' -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' --max-time 25 -d "{\"username\":\"verify_ua\",\"password\":\"Vf2026probe7x\",\"tenant\":\"$T\"}")" = 200 ] || bad "登录A: $(cat /tmp/b)"
TA=$(g token); [ -n "$TA" ] || bad "无 token"
ok "账号A 真登录成功"

STEP=验权限
C=$(api GET /workflow-defs/pending "$TA"); [ "$C" = 200 ] || bad "配了 workflow.approve 但 /pending=$C : $(cat /tmp/b)"
ok "有 workflow.approve → /pending=200 ✅"
C=$(api GET /auth/me "$TA"); P=$(g permissions); echo "   perms=$P"
case "$P" in *workflow.approve*) ok "登录态含 workflow.approve";; *) bad "perms 不含 workflow.approve: $P";; esac

STEP=对照组
[ "$(api POST /accounts/roles "$TOK" '{"code":"verify_lead_b","name":"验证普通临时"}')" = 200 ] || bad "建岗B: $(cat /tmp/b)"
C=$(api POST /accounts "$TOK" '{"username":"verify_ub","password":"Vf2026probe7x","role":"verify_lead_b"}')
[ "$C" = 200 ] || [ "$C" = 201 ] || bad "建号B HTTP=$C: $(cat /tmp/b)"
UB=$(g item.id)
[ "$(curl -s -o /tmp/b -w '%{http_code}' -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' --max-time 25 -d "{\"username\":\"verify_ub\",\"password\":\"Vf2026probe7x\",\"tenant\":\"$T\"}")" = 200 ] || bad "登录B: $(cat /tmp/b)"
TB=$(g token)
C=$(api GET /workflow-defs/pending "$TB"); [ "$C" = 403 ] || bad "未配权限却拿到 /pending=$C（权限门失效）"
ok "未配 workflow.approve → /pending=403 ✅"

STEP=停用
[ "$(api PATCH /accounts/roles/verify_lead_a "$TOK" '{"enabled":false}')" = 200 ] || bad "停用: $(cat /tmp/b)"
[ "$(q "SELECT enabled FROM role_def WHERE tenant_id='$T' AND code='verify_lead_a'")" = f ] || bad "enabled 未变 false"
ok "岗位A 已停用"
C=$(api POST /accounts "$TOK" '{"username":"verify_uc","password":"Vf2026probe7x","role":"verify_lead_a"}')
[ "$C" = 400 ] || bad "停用后仍能建号=$C: $(cat /tmp/b)"
[ "$(q "SELECT count(*) FROM account_user WHERE tenant_id='$T' AND username='verify_uc'")" = 0 ] || bad "被拒账号却落库"
ok "停用后新号被拒400且未落库"
STEP=存量
[ "$(curl -s -o /tmp/b -w '%{http_code}' -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' --max-time 25 -d "{\"username\":\"verify_ua\",\"password\":\"Vf2026probe7x\",\"tenant\":\"$T\"}")" = 200 ] || bad "停用后存量A登录失败"
T2=$(g token)
[ "$(api GET /workflow-defs/pending "$T2")" = 200 ] || bad "存量A权限掉了"
ok "停用只挡新增，存量权限仍在 ✅"

STEP=清理
echo "  删账号B=$(api DELETE /accounts/$UB "$TOK") 账号A=$(api DELETE /accounts/$UA "$TOK") 岗位B=$(api DELETE /accounts/roles/verify_lead_b "$TOK") 岗位A=$(api DELETE /accounts/roles/verify_lead_a "$TOK")"
A1=$(q "SELECT count(*) FROM role_def WHERE tenant_id='$T'")
A2=$(q "SELECT count(*) FROM role_permission WHERE tenant_id='$T'")
A3=$(q "SELECT count(*) FROM account_user WHERE tenant_id='$T'")
echo "  清理后: role_def=$A1/$B1 role_permission=$A2/$B2 account_user=$A3/$B3"
R=0
[ "$A1" = "$B1" ] || { echo "  !! role_def 未回基线"; R=1; }
[ "$A2" = "$B2" ] || { echo "  !! role_permission 未回基线"; R=1; }
[ "$A3" = "$B3" ] || { echo "  !! account_user 未回基线"; R=1; }
echo
if [ $R = 0 ]; then
  echo "===== PASS 建岗→配权→建号→真登录→权限生效→无权限403→停用只挡新增→存量不动→零残留 ====="
else
  echo "===== PARTIAL 功能已验通过，清理未回基线。手工收尾："
  echo "sudo -u postgres psql -d youfu -c \"DELETE FROM role_permission WHERE tenant_id='$T' AND role LIKE 'verify_%'; DELETE FROM account_user WHERE tenant_id='$T' AND username LIKE 'verify_u%'; DELETE FROM role_def WHERE tenant_id='$T' AND code LIKE 'verify_%';\""
fi
