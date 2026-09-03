#!/bin/bash
# RLS 跨租户实读真验脚本
# 作用：SSH 到 ECS 生产库，插入两个探针租户的行，验证租户 A 读不到租户 B、反之亦然，
#        并验证各自能读到自己的行，最后 ROLLBACK（不落库）。作为铁底线的每日自动回归。
# 覆盖表：term（原）+ G2 三表 llm_call_log / location_dict / reporter_dict（2026-09-03 扩展，
#        用于闭合"探针仅覆盖 term、对 G2 缺口表是盲区"的披露项；须 067_rls_dict_llm_fix.sql
#        部署到 ECS 后这 3 表才隔离，否则下方泄漏断言 >0 → 铁底线如实捕获线上缺口）。
# 退出：通过 exit 0；任一泄漏或可见性异常 exit 1；无法连接 ECS 也 exit 1（不静默通过）。
set -uo pipefail

ECS_HOST="${ECS_HOST:-8.136.107.153}"
ECS_KEY="${ECS_KEY:-$HOME/.ssh/aliyun_energy}"
ECS_USER="${ECS_USER:-root}"
REMOTE_ENV="${REMOTE_ENV:-/opt/youfu/backend/.env}"

SQL=$(cat <<'SQLEOF'
BEGIN;
-- ===== term（原有探针）=====
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

-- ===== G2-1 location_dict =====
SET LOCAL app.tenant_id = 'rls_probe_a';
INSERT INTO location_dict (tenant_id, code, name, category) VALUES ('rls_probe_a','rls_probe_loc','A-loc','room');
SET LOCAL app.tenant_id = 'rls_probe_b';
INSERT INTO location_dict (tenant_id, code, name, category) VALUES ('rls_probe_b','rls_probe_loc','B-loc','room');
SET LOCAL app.tenant_id = 'rls_probe_b';
SELECT 'leakA_in_B_loc=' || count(*) FROM location_dict WHERE tenant_id='rls_probe_a';
SET LOCAL app.tenant_id = 'rls_probe_a';
SELECT 'leakB_in_A_loc=' || count(*) FROM location_dict WHERE tenant_id='rls_probe_b';
SET LOCAL app.tenant_id = 'rls_probe_a';
SELECT 'ownA_loc=' || count(*) FROM location_dict WHERE tenant_id='rls_probe_a';
SET LOCAL app.tenant_id = 'rls_probe_b';
SELECT 'ownB_loc=' || count(*) FROM location_dict WHERE tenant_id='rls_probe_b';

-- ===== G2-2 reporter_dict（含报修人姓名/手机号 PII）=====
SET LOCAL app.tenant_id = 'rls_probe_a';
INSERT INTO reporter_dict (tenant_id, code, name, phone, role) VALUES ('rls_probe_a','rls_probe_rep','A-rep','13800000001','nurse');
SET LOCAL app.tenant_id = 'rls_probe_b';
INSERT INTO reporter_dict (tenant_id, code, name, phone, role) VALUES ('rls_probe_b','rls_probe_rep','B-rep','13800000002','nurse');
SET LOCAL app.tenant_id = 'rls_probe_b';
SELECT 'leakA_in_B_rep=' || count(*) FROM reporter_dict WHERE tenant_id='rls_probe_a';
SET LOCAL app.tenant_id = 'rls_probe_a';
SELECT 'leakB_in_A_rep=' || count(*) FROM reporter_dict WHERE tenant_id='rls_probe_b';
SET LOCAL app.tenant_id = 'rls_probe_a';
SELECT 'ownA_rep=' || count(*) FROM reporter_dict WHERE tenant_id='rls_probe_a';
SET LOCAL app.tenant_id = 'rls_probe_b';
SELECT 'ownB_rep=' || count(*) FROM reporter_dict WHERE tenant_id='rls_probe_b';

-- ===== G2-3 llm_call_log（用 SECURITY DEFINER 函数 log_llm_call 写入，绕 youfu_app 序列权限；
--        读隔离仍由下方 SELECT 在 youfu_app 会话（app.tenant_id）下验证）=====
SELECT log_llm_call('rls_probe_a','probe','probe','probe',0,0,0,0,true,null);
SELECT log_llm_call('rls_probe_b','probe','probe','probe',0,0,0,0,true,null);
SET LOCAL app.tenant_id = 'rls_probe_b';
SELECT 'leakA_in_B_llm=' || count(*) FROM llm_call_log WHERE tenant_id='rls_probe_a';
SET LOCAL app.tenant_id = 'rls_probe_a';
SELECT 'leakB_in_A_llm=' || count(*) FROM llm_call_log WHERE tenant_id='rls_probe_b';
SET LOCAL app.tenant_id = 'rls_probe_a';
SELECT 'ownA_llm=' || count(*) FROM llm_call_log WHERE tenant_id='rls_probe_a';
SET LOCAL app.tenant_id = 'rls_probe_b';
SELECT 'ownB_llm=' || count(*) FROM llm_call_log WHERE tenant_id='rls_probe_b';

ROLLBACK;
SQLEOF
)

OUT=$(ssh -i "$ECS_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=20 "$ECS_USER@$ECS_HOST" \
  "bash -c 'PW=\$(grep \"^PGPASSWORD=\" $REMOTE_ENV | head -1 | cut -d= -f2-); export PGPASSWORD=\"\$PW\"; psql -h 127.0.0.1 -p 5432 -U youfu_app -d youfu -t -A -f -'" <<< "$SQL") || {
  echo "RLS 跨租户实读：无法连接 ECS / 执行失败 ❌"
  exit 1
}

echo "$OUT"
# term
leakA=$(echo "$OUT" | grep '^leakA_in_B=' | cut -d= -f2)
leakB=$(echo "$OUT" | grep '^leakB_in_A=' | cut -d= -f2)
ownA=$(echo "$OUT" | grep '^ownA=' | cut -d= -f2)
ownB=$(echo "$OUT" | grep '^ownB=' | cut -d= -f2)
# location_dict
leakA_loc=$(echo "$OUT" | grep '^leakA_in_B_loc=' | cut -d= -f2)
leakB_loc=$(echo "$OUT" | grep '^leakB_in_A_loc=' | cut -d= -f2)
ownA_loc=$(echo "$OUT" | grep '^ownA_loc=' | cut -d= -f2)
ownB_loc=$(echo "$OUT" | grep '^ownB_loc=' | cut -d= -f2)
# reporter_dict
leakA_rep=$(echo "$OUT" | grep '^leakA_in_B_rep=' | cut -d= -f2)
leakB_rep=$(echo "$OUT" | grep '^leakB_in_A_rep=' | cut -d= -f2)
ownA_rep=$(echo "$OUT" | grep '^ownA_rep=' | cut -d= -f2)
ownB_rep=$(echo "$OUT" | grep '^ownB_rep=' | cut -d= -f2)
# llm_call_log
leakA_llm=$(echo "$OUT" | grep '^leakA_in_B_llm=' | cut -d= -f2)
leakB_llm=$(echo "$OUT" | grep '^leakB_in_A_llm=' | cut -d= -f2)
ownA_llm=$(echo "$OUT" | grep '^ownA_llm=' | cut -d= -f2)
ownB_llm=$(echo "$OUT" | grep '^ownB_llm=' | cut -d= -f2)

if [ "$leakA" = "0" ] && [ "$leakB" = "0" ] && [ "$ownA" = "1" ] && [ "$ownB" = "1" ] \
   && [ "$leakA_loc" = "0" ] && [ "$leakB_loc" = "0" ] && [ "$ownA_loc" = "1" ] && [ "$ownB_loc" = "1" ] \
   && [ "$leakA_rep" = "0" ] && [ "$leakB_rep" = "0" ] && [ "$ownA_rep" = "1" ] && [ "$ownB_rep" = "1" ] \
   && [ "$leakA_llm" = "0" ] && [ "$leakB_llm" = "0" ] && [ "$ownA_llm" = "1" ] && [ "$ownB_llm" = "1" ]; then
  echo "RLS 跨租户实读：通过 ✅（term + location_dict + reporter_dict + llm_call_log 全覆盖）"
  exit 0
else
  echo "RLS 跨租户实读：未通过 ❌ (term: leakA_in_B=$leakA leakB_in_A=$leakB ownA=$ownA ownB=$ownB | location_dict: leakA_in_B=$leakA_loc leakB_in_A=$leakB_loc ownA=$ownA_loc ownB=$ownB_loc | reporter_dict: leakA_in_B=$leakA_rep leakB_in_A=$leakB_rep ownA=$ownA_rep ownB=$ownB_rep | llm_call_log: leakA_in_B=$leakA_llm leakB_in_A=$leakB_llm ownA=$ownA_llm ownB=$ownB_llm)"
  echo "  注：若仅 term 通过、3 表泄漏>0 → 067_rls_dict_llm_fix.sql 尚未部署到 ECS（线上仍缺 RLS，须 sudo -u postgres psql -d youfu -f 067_... 部署后重跑）"
  exit 1
fi
