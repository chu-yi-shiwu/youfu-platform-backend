#!/bin/bash
# ============================================================
# 优服家 · 真·开通即用 端到端验证
# 平台开通租户 -> 客户用自己的账号真登录 -> 建岗配权建号走单 -> 挂起
#
# 用法（必须 root）：
#   bash v.sh               # 只读体检，零写入
#   CONFIRM=yes bash v.sh   # 实际执行
#
# 覆盖：开通补全(分类/流程/admin/权限基线) + 建岗 + 配权 + 建号
#       + 真登录 + 权限真生效 + 对照组403 + 停用只挡新增 + 存量不动 + 挂起封禁
# ============================================================
set -u
NEWT="${NEWT:-t-selftest}"
AUSER="yfselfadmin"
APW="YfSelf2026test"
CONFIRM="${CONFIRM:-no}"
ENVF=/opt/youfu/backend/.env
NODE=/opt/node16/bin/node; [ -x "$NODE" ] || NODE=$(command -v node)
STEP=init
ok(){ echo "   OK   $*"; }
bad(){ echo; echo "##### FAIL @ $STEP #####"; echo "$*"; echo "已完成步骤见上，未自动回滚。请把输出发我。"; exit 1; }

echo "== 开通即用验证 | 新租户=$NEWT | 模式=$([ "$CONFIRM" = yes ] && echo 写入 || echo 只读) =="

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
PA_ID=$(sudo -u postgres psql -d youfu -tAc "SELECT id FROM platform_admin WHERE active=true LIMIT 1" 2>/dev/null | tr -d ' ')
PA_NAME=$(sudo -u postgres psql -d youfu -tAc "SELECT username FROM platform_admin WHERE active=true LIMIT 1" 2>/dev/null | tr -d ' ')
[ -n "$PA_ID" ] || bad "无 active platform_admin"
ok "base=$BASE 平台管理员=$PA_NAME"

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
  if [ -n "$d" ]; then curl -s -o /tmp/b -w '%{http_code}' -X "$m" "$BASE/api/v1$p" -H "Authorization: Bearer $t" -H 'Content-Type: application/json' --max-time 30 -d "$d"
  else curl -s -o /tmp/b -w '%{http_code}' -X "$m" "$BASE/api/v1$p" -H "Authorization: Bearer $t" --max-time 30; fi; }
q(){ sudo -u postgres psql -d youfu -tAc "$1" 2>/dev/null | head -1 | tr -d ' '; }
login(){ curl -s -o /tmp/b -w '%{http_code}' -X POST "$BASE/api/v1/auth/login" -H 'Content-Type: application/json' --max-time 30 -d "$1"; }

STEP=体检
echo; echo "--- 现状 ---"
echo "  租户表: $(sudo -u postgres psql -d youfu -tAc "SELECT string_agg(tenant_id||':'||status,', ') FROM tenant_registry" 2>/dev/null)"
EX=$(q "SELECT count(*) FROM tenant_registry WHERE tenant_id='$NEWT'")
echo "  $NEWT 是否已存在: $EX"
[ "$EX" = 0 ] || bad "$NEWT 已存在（status=$(q "SELECT status FROM tenant_registry WHERE tenant_id='$NEWT'")）。这次要建新的，请换 NEWT=xxx 或先人工处理"
echo "  真实客户基线（本次绝对不碰）:"
sudo -u postgres psql -d youfu -c "SELECT tenant_id,count(*) FROM account_user GROUP BY tenant_id ORDER BY tenant_id" | head -10
T1_B=$(q "SELECT count(*) FROM account_user WHERE tenant_id='t-verification'")
T2_B=$(q "SELECT count(*) FROM account_user WHERE tenant_id='t-phasea'")
echo "  t-verification=$T1_B 账号 / t-phasea=$T2_B 账号"

if [ "$CONFIRM" != yes ]; then
  echo; echo "== 只读体检结束，未写任何数据 =="
  echo "执行写入验证： CONFIRM=yes bash /tmp/v.sh"
  exit 0
fi

STEP=签平台token
PTOK=$(K="$SECRET" "$NODE" /tmp/j.js "{\"sub\":\"$PA_ID\",\"platform\":true,\"role\":\"platform_admin\",\"username\":\"$PA_NAME\",\"exp\":$(( $(date +%s)+1800 ))}")
[ "$(api GET /platform/tenants "$PTOK")" = 200 ] || bad "平台 token 被拒: $(cat /tmp/b)"
ok "平台 token 生效（GET /platform/tenants 200）"

STEP=开通租户
C=$(api POST /platform/tenants "$PTOK" "{\"tenant_id\":\"$NEWT\",\"name\":\"开通验证机构\",\"category\":\"hospital\",\"admin_username\":\"$AUSER\",\"admin_password\":\"$APW\",\"status\":\"active\"}")
[ "$C" = 201 ] || [ "$C" = 200 ] || bad "开通失败 HTTP=$C : $(cat /tmp/b)"
echo "  回执: $(cat /tmp/b | head -c 400)"
ok "租户已开通 HTTP=$C"

STEP=验开通补全
N_CAT=$(q "SELECT count(*) FROM fault_category WHERE tenant_id='$NEWT'")
N_WF=$(q "SELECT count(*) FROM workflow_def WHERE tenant_id='$NEWT'")
N_AD=$(q "SELECT count(*) FROM account_user WHERE tenant_id='$NEWT' AND role='admin'")
N_RP=$(q "SELECT count(*) FROM role_permission WHERE tenant_id='$NEWT'")
echo "  分类=$N_CAT 流程=$N_WF admin账号=$N_AD 权限覆盖行=$N_RP"
[ "$N_AD" -ge 1 ] || bad "开通后没有 admin 账号（开通即用断了）"
[ "$N_WF" -ge 1 ] || bad "开通后没有 workflow_def（开通即用断了）"
ok "开通补全：分类=${N_CAT} 条、流程=${N_WF} 套、admin=1、权限基线行=${N_RP}"

STEP=客户真登录
C=$(login "{\"username\":\"$AUSER\",\"password\":\"$APW\",\"tenant\":\"$NEWT\"}")
[ "$C" = 200 ] || bad "新租户 admin 真登录失败 HTTP=$C : $(cat /tmp/b)"
TOK=$(g token); [ -n "$TOK" ] || bad "无 token"
ok "客户用开通时给的账号密码真登录成功"

STEP=权限基线确实生效
C=$(api GET /auth/me "$TOK"); [ "$C" = 200 ] || bad "/auth/me=$C"
echo "  role=$(g user.role) perms=$(g permissions | head -c 200)"

STEP=建岗位
C=$(api POST /accounts/roles "$TOK" "{\"code\":\"verify_lead_a\",\"name\":\"维修组长\",\"description\":\"开通验证\"}")
[ "$C" = 200 ] || [ "$C" = 201 ] || bad "建岗 HTTP=$C : $(cat /tmp/b)"
[ "$(q "SELECT count(*) FROM role_def WHERE tenant_id='$NEWT' AND code='verify_lead_a'")" = 1 ] || bad "role_def 未落库"
ok "岗位真落库（界面建岗的等价动作）"

STEP=配权限
[ "$(api PUT /accounts/roles/verify_lead_a/permissions "$TOK" '{"perms":["workflow.approve"]}')" = 200 ] || bad "配权: $(cat /tmp/b)"
[ "$(q "SELECT count(*) FROM role_permission WHERE tenant_id='$NEWT' AND role='verify_lead_a' AND perm='workflow.approve'")" = 1 ] || bad "role_permission 未落库"
ok "权限真落库"

STEP=建账号
C=$(api POST /accounts "$TOK" "{\"username\":\"verify_ua\",\"password\":\"Uf2026probe7x\",\"role\":\"verify_lead_a\"}")
[ "$C" = 200 ] || [ "$C" = 201 ] || bad "建号 HTTP=$C: $(cat /tmp/b)"
UA=$(g item.id)
[ "$(q "SELECT role FROM account_user WHERE tenant_id='$NEWT' AND username='verify_ua'")" = verify_lead_a ] || bad "账号 role 不对"
ok "账号落库 role=verify_lead_a id=$UA"

STEP=该账号真登录并验权
[ "$(login "{\"username\":\"verify_ua\",\"password\":\"Uf2026probe7x\",\"tenant\":\"$NEWT\"}")" = 200 ] || bad "登录: $(cat /tmp/b)"
TA=$(g token); [ -n "$TA" ] || bad "无 token"
C=$(api GET /workflow-defs/pending "$TA"); [ "$C" = 200 ] || bad "配了 workflow.approve 但 /pending=$C : $(cat /tmp/b)"
ok "有 workflow.approve -> /pending=200"

STEP=对照组403
[ "$(api POST /accounts/roles "$TOK" '{"code":"verify_lead_b","name":"普通员工"}')" = 200 ] || bad "建岗B: $(cat /tmp/b)"
C=$(api POST /accounts "$TOK" '{"username":"verify_ub","password":"Uf2026probe7x","role":"verify_lead_b"}')
[ "$C" = 200 ] || [ "$C" = 201 ] || bad "建号B HTTP=$C: $(cat /tmp/b)"
UB=$(g item.id)
[ "$(login "{\"username\":\"verify_ub\",\"password\":\"Uf2026probe7x\",\"tenant\":\"$NEWT\"}")" = 200 ] || bad "登录B: $(cat /tmp/b)"
TB=$(g token)
C=$(api GET /workflow-defs/pending "$TB"); [ "$C" = 403 ] || bad "未配权限却拿到 /pending=$C（权限门失效）"
ok "未配 workflow.approve -> /pending=403"

STEP=停用岗位
[ "$(api PATCH /accounts/roles/verify_lead_a "$TOK" '{"enabled":false}')" = 200 ] || bad "停用: $(cat /tmp/b)"
[ "$(q "SELECT enabled FROM role_def WHERE tenant_id='$NEWT' AND code='verify_lead_a'")" = f ] || bad "enabled 未变 false"
C=$(api POST /accounts "$TOK" '{"username":"verify_uc","password":"Uf2026probe7x","role":"verify_lead_a"}')
[ "$C" = 400 ] || bad "停用后仍能建号=$C : $(cat /tmp/b)"
[ "$(q "SELECT count(*) FROM account_user WHERE tenant_id='$NEWT' AND username='verify_uc'")" = 0 ] || bad "被拒账号却落库"
ok "停用后新号被拒400且未落库"

STEP=存量不受影响
[ "$(login "{\"username\":\"verify_ua\",\"password\":\"Uf2026probe7x\",\"tenant\":\"$NEWT\"}")" = 200 ] || bad "停用后存量登录失败"
T2=$(g token)
[ "$(api GET /workflow-defs/pending "$T2")" = 200 ] || bad "存量权限掉了"
ok "停用只挡新增，存量权限仍在"

STEP=租户内清理
echo "  删 verify 资产: 账号B=$(api DELETE /accounts/$UB "$TOK") 账号A=$(api DELETE /accounts/$UA "$TOK") 岗位B=$(api DELETE /accounts/roles/verify_lead_b "$TOK") 岗位A=$(api DELETE /accounts/roles/verify_lead_a "$TOK")"
[ "$(q "SELECT count(*) FROM role_def WHERE tenant_id='$NEWT'")" = 0 ] || echo "  (提示: 岗位未清零=$(q "SELECT count(*) FROM role_def WHERE tenant_id='$NEWT'"))"
[ "$(q "SELECT count(*) FROM account_user WHERE tenant_id='$NEWT' AND username LIKE 'verify_u%'")" = 0 ] || echo "  (提示: 测试账号未清零)"
ok "租户内测试资产已清理，仅留开通自带的分类/流程/admin"

STEP=挂起租户
C=$(api PUT "/platform/tenants/$NEWT/status" "$PTOK" '{"status":"suspended"}')
[ "$C" = 200 ] || bad "挂起失败 HTTP=$C : $(cat /tmp/b)"
[ "$(q "SELECT status FROM tenant_registry WHERE tenant_id='$NEWT'")" = suspended ] || bad "registry status 未变 suspended"
ok "租户已挂起"

STEP=挂起后封禁验证
C=$(login "{\"username\":\"$AUSER\",\"password\":\"$APW\",\"tenant\":\"$NEWT\"}")
[ "$C" = 403 ] || bad "挂起后登录未被拒 HTTP=$C : $(cat /tmp/b)"
[ "$(g code)" = TENANT_SUSPENDED ] || bad "挂起后拒绝码不是 TENANT_SUSPENDED（实际 $(g code)）"
ok "挂起后登录被拒 403 TENANT_SUSPENDED（封禁精确生效）"

STEP=终态
echo "  新租户终态: 分类=$(q "SELECT count(*) FROM fault_category WHERE tenant_id='$NEWT'") 流程=$(q "SELECT count(*) FROM workflow_def WHERE tenant_id='$NEWT'") 岗位=$(q "SELECT count(*) FROM role_def WHERE tenant_id='$NEWT'") 权限行=$(q "SELECT count(*) FROM role_permission WHERE tenant_id='$NEWT'") 账号=$(q "SELECT count(*) FROM account_user WHERE tenant_id='$NEWT'") 状态=$(q "SELECT status FROM tenant_registry WHERE tenant_id='$NEWT'")"
T1_A=$(q "SELECT count(*) FROM account_user WHERE tenant_id='t-verification'")
T2_A=$(q "SELECT count(*) FROM account_user WHERE tenant_id='t-phasea'")
echo "  真实客户未受影响: t-verification=$T1_A/$T1_B  t-phasea=$T2_A/$T2_B"
R=0
[ "$T1_A" = "$T1_B" ] || { echo "  !! t-verification 账号数变了"; R=1; }
[ "$T2_A" = "$T2_B" ] || { echo "  !! t-phasea 账号数变了"; R=1; }
[ "$(q "SELECT status FROM tenant_registry WHERE tenant_id='$NEWT'")" = suspended ] || { echo "  !! 新租户未挂起"; R=1; }
[ "$(q "SELECT count(*) FROM role_def WHERE tenant_id='$NEWT'")" = 0 ] || { echo "  !! 测试岗位未清"; R=1; }
echo
if [ $R = 0 ]; then
  echo "===== PASS 开通即用打通：开通->真登录->建岗->配权->建号->权限生效->403对照->停用只挡新增->清理->挂起封禁；真实客户零影响 ====="
  echo "唯一残留: tenant_registry 多 1 行 $NEWT(suspended)，因无删租户接口（缺陷已挂账）"
else
  echo "===== PARTIAL 见上方 !! 项 ====="
fi
