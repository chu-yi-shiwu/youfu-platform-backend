// 深度探针 v4：平台端写闭环 + 时间边界
//
// 覆盖：
//   A. 平台认证/RBAC
//   B. 租户登记 → 停用/待开通/恢复 → 登录拦截
//   C. LLM 授权、点位/报修人配置
//   D. 试用申请：提交 → 通过（建租户）/ 驳回 / 重复审核
//   E. 开放应用：创建 → 鉴权调用 → 撤销 → 撤销后拒绝
//   F. 模板市场：应用官方模板 → 24h 重复应用拦截
//   G. 平台审计日志
//   H. 时间边界：today / 日期无时区漂移 / 月报边界 / SLA 逾期 / 志愿签到宽限
//
// 运行（ECS）：ENV_FILE=.env E2E_RUN_ID=pt1 node scripts/uat-platform-time-probe.mjs
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;
const BASE = (process.env.PILOT_API_BASE || 'http://127.0.0.1:4101/api/v1').replace(/\/+$/, '');
const UPLOAD_ROOT = process.env.UPLOAD_DIR || '/opt/youfu/uploads';
const RUN = (process.env.E2E_RUN_ID || `pt${Date.now().toString(36)}`).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
const TEN = `uat-plat-${RUN}`;
const TRIAL_TEN = `uat-trial-${RUN}`;
const PUSER = `e2e_pf_${RUN}`.slice(0, 32);
const PASS = 'Plat!2026x';
const trialPhones = [];

function loadEnv() {
  for (const f of [process.env.ENV_FILE || '.env']) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();

const db = new Client({
  host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'youfu_pilot',
  user: process.env.PGUSER || 'youfu_app', password: process.env.PGPASSWORD,
});

function hashPassword(p) {
  const s = crypto.randomBytes(16);
  return `scrypt$${s.toString('hex')}$${crypto.scryptSync(p, s, 64).toString('hex')}`;
}
function request(method, p, body, token, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const u = new URL(p.startsWith('http') ? p : BASE + p);
    const req = http.request(u, {
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(extraHeaders || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { raw }; }
        resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const results = [];
function record(cat, name, expect, r, note) {
  const ok = Array.isArray(expect) ? expect.includes(r.status) : r.status === expect;
  const five = r.status >= 500;
  results.push({ cat, name, expect: String(expect), actual: r.status, ok, five, note: note || '', code: r.body?.code, msg: (r.body?.message || '').slice(0, 140) });
  console.log(`[${five ? 'FIVE' : ok ? 'ok' : 'MISMATCH'}] ${cat} | ${name} | expect=${Array.isArray(expect) ? expect.join('/') : expect} actual=${r.status} ${five || !ok ? JSON.stringify({ code: r.body?.code, message: r.body?.message }) : ''}`);
}
function recordCustom(cat, name, ok, detail, five) {
  results.push({ cat, name, expect: 'custom', actual: five ? 500 : ok ? 200 : 0, ok, five: !!five, note: detail });
  console.log(`[${five ? 'FIVE' : ok ? 'ok' : 'MISMATCH'}] ${cat} | ${name} | ${detail}`);
}

async function dbQuery(sql, params = [], tenant = TEN) {
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [tenant]);
  const r = await db.query(sql, params);
  await db.query('COMMIT');
  return r;
}

async function cleanup() {
  // 租户业务数据（含试用通过后创建的租户）
  for (const t of [TEN, TRIAL_TEN]) {
    try {
      const sql = `
BEGIN;
SET LOCAL session_replication_role = replica;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns
           WHERE table_schema='public' AND column_name='tenant_id'
  LOOP
    EXECUTE format('DELETE FROM %I WHERE tenant_id=$1', r.table_name) USING '${t}';
  END LOOP;
END $$;
COMMIT;`;
      execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', process.env.PGDATABASE || 'youfu_pilot', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' });
    } catch (e) { console.error('[cleanup tenant]', t, e.message); }
    // 清理所有可能的 uploads 根：主站默认 /opt/youfu/uploads，pilot 默认 /opt/youfu/pilot/uploads；
    // 历史脚本只按 UPLOAD_ROOT 删，跨环境会漏删（2026-11-15 实测遗留 uat-* 目录）。
    for (const root of new Set([process.env.UPLOAD_DIR, '/opt/youfu/uploads', '/opt/youfu/pilot/uploads'].filter(Boolean))) {
      rmSync(path.join(root, t), { recursive: true, force: true });
    }
  }
  // 平台侧测试数据（精确到本轮 actor / 目标租户）
  try {
    await db.query(`DELETE FROM platform_audit WHERE actor=$1 OR target_tenant IN ($2,$3)`, [PUSER, TEN, TRIAL_TEN]);
    if (trialPhones.length > 0) {
      await db.query(`DELETE FROM trial_applications WHERE phone = ANY($1::text[])`, [trialPhones]);
    }
    await db.query(`DELETE FROM open_api_call_log WHERE app_id IN (SELECT id FROM open_api_app WHERE app_name LIKE $1)`, [`E2E-APP-${RUN}%`]);
    await db.query(`DELETE FROM open_api_app WHERE app_name LIKE $1`, [`E2E-APP-${RUN}%`]);
    await db.query(`DELETE FROM platform_template WHERE name LIKE $1 OR contributor_tenant = $2`, [`%${RUN}%`, TEN]);
    await db.query(`DELETE FROM platform_admin WHERE username=$1`, [PUSER]);
  } catch (e) { console.error('[cleanup platform]', e.message); }
}

async function main() {
  await db.connect();
  // 平台管理员（全局，无租户）
  await db.query(`INSERT INTO platform_admin (username,password_hash,display_name,active) VALUES ($1,$2,'E2E平台探针',true)`, [PUSER, hashPassword(PASS)]);

  // ============ A. 平台认证 ============
  const A = '平台认证';
  record(A, '平台登录空 body', [400, 401, 422], await request('POST', '/platform/auth/login', {}));
  record(A, '平台登录密码错误', [401], await request('POST', '/platform/auth/login', { username: PUSER, password: 'bad' }));
  const pl = await request('POST', '/platform/auth/login', { username: PUSER, password: PASS });
  let pt = pl.body?.token;
  recordCustom(A, '平台登录成功', pl.status === 200 && !!pt, `status=${pl.status}`, pl.status >= 500);
  record(A, '无 token 读平台汇总', [401], await request('GET', '/platform/summary'));
  record(A, '篡改 token 读平台汇总', [401], await request('GET', '/platform/summary', undefined, String(pt).slice(0, -3) + 'abc'));
  const pc = await request('PUT', '/platform/auth/password', { old_password: PASS, new_password: 'Plat!2026y' }, pt);
  record(A, '平台修改自己密码', [200, 204], pc);
  if (pc.status === 200 || pc.status === 204) {
    const relogin = await request('POST', '/platform/auth/login', { username: PUSER, password: 'Plat!2026y' });
    recordCustom(A, '新平台密码可登录', relogin.status === 200, `status=${relogin.status}`, relogin.status >= 500);
    // 改回，并用新 token 继续（避免旧 token 因改密失效）
    const pt2 = relogin.body?.token;
    await request('PUT', '/platform/auth/password', { old_password: 'Plat!2026y', new_password: PASS }, pt2);
    const again = await request('POST', '/platform/auth/login', { username: PUSER, password: PASS });
    if (again.body?.token) pt = again.body.token;
  }
  // 平台 token 不能当租户 token
  record(A, '平台 token 访问租户接口', [401], await request('GET', '/open/work_orders', undefined, pt));

  // ============ B. 租户登记 / 停用 / 恢复 ============
  const B = '租户生命周期';
  const regBad = await request('POST', '/platform/tenants', { tenant_id: 'A', name: 'x', category: 'other' }, pt);
  record(B, '登记非法租户 ID', [400, 422], regBad);
  const reg = await request('POST', '/platform/tenants', {
    tenant_id: TEN, name: `UAT平台探针 ${RUN}`, category: 'other',
    admin_username: 'pf_admin', admin_password: 'UatPlat!2026',
  }, pt);
  record(B, '登记新租户', [201], reg);
  record(B, '重复登记租户', [409], await request('POST', '/platform/tenants', { tenant_id: TEN, name: 'dup', category: 'other' }, pt));
  const loginTenant = (pw = 'UatPlat!2026') => request('POST', '/auth/login', { username: 'pf_admin', password: pw, tenant: TEN, channel: 'pc' });
  const loginOk = await loginTenant();
  recordCustom(B, '新租户管理员可登录', loginOk.status === 200 && !!loginOk.body?.token, `status=${loginOk.status}`, loginOk.status >= 500);
  const suspend = await request('PUT', `/platform/tenants/${TEN}/status`, { status: 'suspended' }, pt);
  record(B, '停用租户', [200], suspend);
  record(B, '停用后登录被拒', [403], await loginTenant());
  const pending = await request('PUT', `/platform/tenants/${TEN}/status`, { status: 'pending' }, pt);
  record(B, '置为待开通', [200], pending);
  record(B, '待开通登录被拒', [403], await loginTenant());
  record(B, '恢复租户', [200], await request('PUT', `/platform/tenants/${TEN}/status`, { status: 'active' }, pt));
  const restoredLogin = await loginTenant();
  recordCustom(B, '恢复后可登录', restoredLogin.status === 200, 'login');
  record(B, '非法状态值', [400, 422], await request('PUT', `/platform/tenants/${TEN}/status`, { status: 'deleted' }, pt));
  record(B, '停用不存在租户', [404], await request('PUT', '/platform/tenants/no-such-tenant/status', { status: 'active' }, pt));

  // ============ C. LLM / 点位 / 报修人 ============
  const C = '租户配置';
  record(C, '开启 LLM', [200], await request('PUT', `/platform/tenants/${TEN}/llm`, { enabled: true }, pt));
  const tl = await request('GET', '/platform/tenants', undefined, pt);
  const trow = (tl.body?.items || []).find((x) => x.tenant_id === TEN);
  recordCustom(C, 'LLM 开关可读回', String(trow?.llm_enabled) === 'true' || trow?.llm_enabled === true, `llm_enabled=${trow?.llm_enabled}`);
  record(C, '关闭 LLM', [200], await request('PUT', `/platform/tenants/${TEN}/llm`, { enabled: false }, pt));
  const loc = await request('POST', `/platform/tenants/${TEN}/locations`, { code: `PL-${RUN}`, name: `平台点位-${RUN}`, category: '平台' }, pt);
  record(C, '新增平台点位', [200, 201], loc);
  const locList = await request('GET', `/platform/tenants/${TEN}/locations`, undefined, pt);
  recordCustom(C, '点位列表可见', (locList.body?.items || []).length > 0, `items=${(locList.body?.items || []).length}`, locList.status >= 500);
  const rep = await request('POST', `/platform/tenants/${TEN}/reporters`, { code: `PR-${RUN}`, name: `平台报修人-${RUN}`, phone: '13800000001' }, pt);
  record(C, '新增报修人', [200, 201], rep);
  record(C, '报修人非法手机号', [400, 422], await request('POST', `/platform/tenants/${TEN}/reporters`, { name: 'x', phone: '123' }, pt));

  // ============ D. 试用申请 ============
  const D = '试用申请';
  const phone = `199${String(Date.now()).slice(-8)}`;
  trialPhones.push(phone);
  const apply = await request('POST', '/public/trial-applications', {
    org_name: `E2E试用机构 ${RUN}`, contact_name: '联系人', phone, category: 'hospital', note: '自动探针',
  });
  record(D, '提交试用申请', [200, 201], apply);
  const tlist = await request('GET', '/platform/trial-applications?status=pending&limit=200', undefined, pt);
  const mine = (tlist.body?.items || []).find((x) => x.phone === phone);
  recordCustom(D, '平台列表可见申请', !!mine, `found=${!!mine}`, tlist.status >= 500);
  if (mine) {
    record(D, '通过缺 tenant_id', [422], await request('POST', `/platform/trial-applications/${mine.id}/review`, { action: 'approve' }, pt));
    const apr = await request('POST', `/platform/trial-applications/${mine.id}/review`, { action: 'approve', tenant_id: TRIAL_TEN, admin_username: 'trial_admin' }, pt);
    record(D, '试用通过并建租户', [200, 201], apr);
    const dup = await request('POST', `/platform/trial-applications/${mine.id}/review`, { action: 'approve', tenant_id: TRIAL_TEN }, pt);
    record(D, '重复审核被拒', [409], dup);
  }
  // 驳回路径
  const phone2 = `199${String(Date.now() + 1).slice(-8)}`;
  trialPhones.push(phone2);
  const apply2 = await request('POST', '/public/trial-applications', { org_name: `E2E驳回 ${RUN}`, contact_name: 'x', phone: phone2, category: 'other' });
  const tlist2 = await request('GET', '/platform/trial-applications?status=pending&limit=200', undefined, pt);
  const mine2 = (tlist2.body?.items || []).find((x) => x.phone === phone2);
  if (apply2.status < 300 && mine2) {
    record(D, '驳回申请', [200], await request('POST', `/platform/trial-applications/${mine2.id}/review`, { action: 'reject', reason: '探针驳回' }, pt));
    record(D, '重复驳回被拒', [409], await request('POST', `/platform/trial-applications/${mine2.id}/review`, { action: 'reject' }, pt));
  }
  record(D, '审核不存在申请', [404], await request('POST', `/platform/trial-applications/${crypto.randomUUID()}/review`, { action: 'reject' }, pt));

  // ============ E. 开放应用 ============
  const E = '开放应用';
  const appName = `E2E-APP-${RUN}`;
  const app = await request('POST', '/platform/apps', { name: appName, owner: 'E2E', scopes: ['summary:read'], quotas: { qps: 0 } }, pt);
  record(E, '创建开放应用', [201], app);
  const key = app.body?.item?.app_key;
  const secret = app.body?.item?.app_secret;
  recordCustom(E, '创建返回 key+secret（仅一次）', !!key && !!secret, `key=${key}`);
  if (key && secret) {
    const ok = await request('GET', '/open-api/tenants/summary', undefined, undefined, { 'X-App-Key': key, 'X-App-Secret': secret });
    record(E, '应用凭证可调用开放 API', [200], ok);
    const perTenant = await request('GET', `/open-api/tenants/summary?tenant_id=${TEN}`, undefined, undefined, { 'X-App-Key': key, 'X-App-Secret': secret });
    record(E, '低权限应用不可按租户汇总', [403], perTenant);
    const badSecret = await request('GET', '/open-api/tenants/summary', undefined, undefined, { 'X-App-Key': key, 'X-App-Secret': 'wrong' });
    record(E, '错误 secret 被拒', [401], badSecret);
    record(E, '无凭证调用被拒', [401], await request('GET', '/open-api/tenants/summary'));
    const revoke = await request('PUT', `/platform/apps/${app.body.item.id}/revoke`, {}, pt);
    record(E, '撤销应用', [200], revoke);
    const afterRevoke = await request('GET', '/open-api/tenants/summary', undefined, undefined, { 'X-App-Key': key, 'X-App-Secret': secret });
    record(E, '撤销后调用被拒', [403], afterRevoke);
  }
  record(E, '创建应用缺 name', [400, 422], await request('POST', '/platform/apps', {}, pt));

  // ============ F. 模板市场 ============
  const F = '模板市场';
  const tpls = await request('GET', '/platform/templates?status=published&limit=20', undefined, pt);
  record(F, '模板列表', [200], tpls);
  // 平台侧新建（默认 published）→ 应用到租户 → 24h 重复拦截
  const tplDef = { initial: 'draft', states: ['draft', 'processing', 'done'], transitions: [{ from: 'draft', to: 'processing', event: 'start' }, { from: 'processing', to: 'done', event: 'finish' }] };
  const createdTpl = await request('POST', '/platform/templates', {
    name: `E2E-TPL-${RUN}`, category: 'other', entity_type: 'work_order', description: '探针模板',
    playbook: { workflow_def: tplDef },
  }, pt);
  record(F, '平台新建模板', [201], createdTpl);
  const tplId = createdTpl.body?.item?.id;
  if (tplId) {
    record(F, '应用官方模板到租户', [200, 201], await request('POST', `/platform/templates/${tplId}/apply`, { tenantId: TEN }, pt));
    record(F, '24h 内重复应用被拒', [409], await request('POST', `/platform/templates/${tplId}/apply`, { tenantId: TEN }, pt));
    record(F, '应用到不存在租户', [404], await request('POST', `/platform/templates/${tplId}/apply`, { tenantId: 'no-such-tenant' }, pt));
    record(F, '模板详情可读', [200], await request('GET', `/platform/templates/${tplId}`, undefined, pt));
  }
  record(F, '审查不存在的模板', [404], await request('PUT', `/platform/templates/${crypto.randomUUID()}/review`, { action: 'approve' }, pt));
  record(F, '模板违反 playbook 校验', [400], await request('POST', '/platform/templates', { name: `E2E-TPL-${RUN}`, playbook: {} }, pt));

  // UGC：租户提交 → 平台审核（通过 / 驳回）
  if (restoredLogin.body?.token) {
    const ugc1 = await request('POST', '/template-contributions', { name: `E2E-TPL-UGC-${RUN}`, description: '租户贡献' }, restoredLogin.body.token);
    record(F, '租户提交 UGC 模板', [201], ugc1);
    const ugcId = ugc1.body?.item?.id;
    if (ugcId) {
      record(F, '平台通过 UGC', [200], await request('PUT', `/platform/templates/${ugcId}/review`, { action: 'approve' }, pt));
      record(F, '重复审核 UGC 被拒', [409], await request('PUT', `/platform/templates/${ugcId}/review`, { action: 'approve' }, pt));
    }
    const ugc2 = await request('POST', '/template-contributions', { name: `E2E-TPL-UGC2-${RUN}`, description: '驳回样本' }, restoredLogin.body.token);
    if (ugc2.body?.item?.id) {
      record(F, '平台驳回 UGC', [200], await request('PUT', `/platform/templates/${ugc2.body.item.id}/review`, { action: 'reject' }, pt));
    }
    record(F, '匿名不可提交 UGC', [401, 403], await request('POST', '/template-contributions', { name: `E2E-TPL-UGC3-${RUN}` }, undefined));
  }

  // ============ G. 审计日志 ============
  const G = '审计日志';
  const audit = await request('GET', '/platform/audit-logs?limit=200', undefined, pt);
  record(G, '审计日志可读', [200], audit);
  recordCustom(G, '审计记录包含本轮动作', (audit.body?.items || []).some((x) => String(x.action || '').includes('tenant.create')), `items=${(audit.body?.items || []).length}`, audit.status >= 500);
  const auditBig = await request('GET', '/platform/audit-logs?limit=100000', undefined, pt);
  recordCustom(G, '审计分页上限收敛', (auditBig.body?.items || []).length <= 200, `items=${(auditBig.body?.items || []).length}`, auditBig.status >= 500);
  record(G, '非法 action 注入', [200, 400], await request('GET', `/platform/audit-logs?action=${encodeURIComponent("' OR 1=1--")}`, undefined, pt));

  // ============ H. 时间边界 ============
  const H = '时间边界';
  // 用平台新建租户的管理员做业务断言（复用恢复登录的 token，避免触发登录限频）
  const tt = restoredLogin.body?.token;
  recordCustom('准备', '租户管理员登录', !!tt, `status=${restoredLogin.status}`, restoredLogin.status >= 500);
  if (tt) {
    // H1 today：直接改 created_at 到「今天 00:00:30」与「昨天 23:59:30」（+08 会话时区）
    const mk = async (title) => {
      const r = await request('POST', '/open/work_order', { id: crypto.randomUUID(), business_type: 'repair', title, description: 'time probe', location: '平台点位', priority: 'normal' }, tt);
      if (!r.body?.id) recordCustom('准备', `建单失败：${title}`, false, `status=${r.status} ${r.body?.code || ''} ${r.body?.message || ''}`, r.status >= 500);
      return r.body?.id;
    };
    const idToday = await mk('时间-今天零点后');
    const idYesterday = await mk('时间-昨天最后一分钟');
    recordCustom('准备', '创建时间边界工单', !!idToday && !!idYesterday, `today=${!!idToday} yesterday=${!!idYesterday}`);
    if (idToday && idYesterday) {
      await dbQuery(`UPDATE work_orders SET created_at = date_trunc('day', now()) + interval '30 seconds' WHERE id=$1`, [idToday]);
      await dbQuery(`UPDATE work_orders SET created_at = date_trunc('day', now()) - interval '30 seconds' WHERE id=$1`, [idYesterday]);
      const listToday = await request('GET', '/open/work_orders?today=1&limit=200', undefined, tt);
      const ids = (listToday.body?.items || []).map((x) => x.id);
      recordCustom(H, 'today=1 含今日 00:00:30', ids.includes(idToday), `contains=${ids.includes(idToday)} total=${ids.length}`);
      recordCustom(H, 'today=1 不含昨日 23:59:30', !ids.includes(idYesterday), `contains=${ids.includes(idYesterday)}`);
    }

    // H2 日期无时区漂移：date-only 应落到本地 2026-11-30
    const it = await request('POST', '/inspection/tasks', { title: '时间-日期无漂移', type: 'free', scheduled_at: '2026-11-30' }, tt);
    const taskId = it.body?.item?.id;
    if (taskId) {
      const d = await request('GET', `/inspection/tasks/${taskId}`, undefined, tt);
      const iso = (d.body?.item || {}).scheduled_at;
      const local = new Date(iso).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
      recordCustom(H, 'date-only 不漂移（本地 2026/11/30）', local === '2026/11/30', `iso=${iso} local=${local}`);
      // H3 月报边界
      await dbQuery(`UPDATE inspection_task SET scheduled_at = timestamptz '2026-10-31 23:30:00+08' WHERE id=$1`, [taskId]);
      const expOct = await request('GET', '/inspection/export?month=2026-10', undefined, tt);
      const expNov = await request('GET', '/inspection/export?month=2026-11', undefined, tt);
      recordCustom(H, '月报 2026-10 含 10/31 23:30', expOct.status === 200 && expOct.raw.includes('时间-日期无漂移'), `status=${expOct.status} found=${expOct.raw.includes('时间-日期无漂移')}`);
      recordCustom(H, '月报 2026-11 不含 10/31 23:30', expNov.status === 200 && !expNov.raw.includes('时间-日期无漂移'), `status=${expNov.status} found=${expNov.raw.includes('时间-日期无漂移')}`);
      await dbQuery(`UPDATE inspection_task SET scheduled_at = timestamptz '2026-11-01 00:30:00+08' WHERE id=$1`, [taskId]);
      const expNov2 = await request('GET', '/inspection/export?month=2026-11', undefined, tt);
      recordCustom(H, '月报 2026-11 含 11/1 00:30', expNov2.status === 200 && expNov2.raw.includes('时间-日期无漂移'), `status=${expNov2.status}`);
    }

    // H4 SLA 逾期：已到期计入、未到期不计入
    const slaPast = await mk('时间-SLA已逾期');
    const slaFuture = await mk('时间-SLA未逾期');
    await dbQuery(`UPDATE work_orders SET sla_due_at = now() - interval '1 hour' WHERE id=$1`, [slaPast]);
    await dbQuery(`UPDATE work_orders SET sla_due_at = now() + interval '1 hour' WHERE id=$1`, [slaFuture]);
    const over = await request('GET', '/stats/overdue', undefined, tt);
    const overdueTotal = Number(over.body?.overdue?.overdue_total ?? -1);
    recordCustom(H, 'SLA 逾期计数含已到期单', over.status === 200 && overdueTotal >= 1, `status=${over.status} total=${overdueTotal}`, over.status >= 500);

    // H5 志愿签到宽限：结束 2 天内可签，结束 4 天拒绝
    const mkAct = async (title, endOffset) => {
      const r = await request('POST', '/volunteer/activities', {
        title, location: '平台点位', slots: 1,
        start_at: new Date(Date.now() - 5 * 86400e3).toISOString(),
        end_at: new Date(Date.now() + endOffset).toISOString(),
      }, tt);
      return r.body?.item?.id;
    };
    const actOk = await mkAct('时间-志愿宽限内', -2 * 86400e3);
    const actLate = await mkAct('时间-志愿超宽限', -4 * 86400e3);
    // 已结束活动不能再报名（报名窗口按设计关闭）——记录用直插构造，专门验证签到宽限窗口。
    const mkRec = async (aid) => {
      if (!aid) return null;
      const r = await dbQuery(
        `INSERT INTO volunteer_record (tenant_id, activity_id, user_name, status) VALUES ($1,$2,'时间志愿者','registered') RETURNING id`,
        [TEN, aid],
      );
      return r.rows[0]?.id;
    };
    const rOk = await mkRec(actOk);
    const rLate = await mkRec(actLate);
    if (rOk) record(H, '活动结束 2 天内可签到', [200], await request('POST', `/volunteer/records/${rOk}/checkin`, {}, tt));
    if (rLate) record(H, '活动结束 4 天拒绝签到', [409], await request('POST', `/volunteer/records/${rLate}/checkin`, {}, tt));
    if (!rOk || !rLate) recordCustom(H, '志愿宽限探针前置数据', false, `actOk=${!!actOk} actLate=${!!actLate}`);
  }

  const five = results.filter((r) => r.five);
  const mismatch = results.filter((r) => !r.ok && !r.five);
  console.log('\n========== SUMMARY ==========');
  console.log(`total=${results.length} pass=${results.filter((r) => r.ok).length} mismatch=${mismatch.length} 5xx=${five.length}`);
  if (mismatch.length) console.log('MISMATCH:\n' + mismatch.map((r) => `- [${r.cat}] ${r.name} expect=${r.expect} actual=${r.actual} ${r.code || ''} ${r.msg || ''}`).join('\n'));
  if (five.length) console.log('5XX:\n' + five.map((r) => `- [${r.cat}] ${r.name} actual=${r.actual} ${r.code || ''} ${r.msg || ''}`).join('\n'));
  console.log('RESULT_JSON=' + JSON.stringify(results.filter((r) => r.five || !r.ok)));

  await cleanup();
  await db.end();
}

main().catch(async (e) => {
  console.error('FATAL', e);
  try { await cleanup(); } catch {}
  process.exit(1);
});
