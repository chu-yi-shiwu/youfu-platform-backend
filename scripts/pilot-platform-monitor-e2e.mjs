// 补充模块集成审计（2026-11-14）：网管监控 / 能耗自述 / 平台端 / 试用申请。
// 隔离 UAT 租户 + 临时平台管理员 + 临时试用申请，结束后全部清理。
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;
const BASE = 'http://127.0.0.1:4101/api/v1';
const UPLOAD_ROOT = '/opt/youfu/pilot/uploads';
const RUN = `sup${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const TENANT = `uat-sup-${RUN}`;
const PASS = 'Sup!2026';
const PLATFORM_USER = `e2e_platform_${RUN}`.slice(0, 32);
const TRIAL_PHONE = `199${String(Date.now()).slice(-8)}`;

function loadEnv() {
  for (const f of ['.env', '/opt/youfu/pilot/initial-credentials.txt']) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();

const db = new Client({
  host: process.env.PGHOST || '127.0.0.1', port: 5432, database: process.env.PGDATABASE || 'youfu_pilot',
  user: process.env.PGUSER || 'youfu_app', password: process.env.PGPASSWORD,
});
function hash(p) { const s = crypto.randomBytes(16); return `scrypt$${s.toString('hex')}$${crypto.scryptSync(p, s, 64).toString('hex')}`; }
function request(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const u = new URL(p.startsWith('http') ? p : BASE + p);
    const r = http.request(u, {
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { raw }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); };
const results = [];
function record(name, status, note) { results.push({ name, status, note }); console.log(`[sup] ${status} ${name}${note ? ' — ' + note : ''}`); }

async function sql(q, params = []) {
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  const r = await db.query(q, params);
  await db.query('COMMIT');
  return r;
}
async function cleanup() {
  // 2026-11-17 审计实测：应用账号无权 SET session_replication_role，原清理静默失败并遗留 UAT 租户。
  // 改为 postgres 执行（与其它 UAT 脚本同口径），失败显式报错。
  try {
    const sql = `
BEGIN;
SET LOCAL session_replication_role = replica;
DO $$ DECLARE r record; BEGIN
FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id'
LOOP EXECUTE format('DELETE FROM %I WHERE tenant_id=$1', r.table_name) USING '${TENANT}'; END LOOP; END $$;
COMMIT;`;
    execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', process.env.PGDATABASE || 'youfu_pilot', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' });
  } catch (e) { console.error('tenant cleanup', e.message); }
  try {
    await db.query(`DELETE FROM platform_admin WHERE username=$1`, [PLATFORM_USER]);
    await db.query(`DELETE FROM trial_applications WHERE phone=$1`, [TRIAL_PHONE]);
  } catch (e) { console.error('platform cleanup', e.message); }
  rmSync(path.join(UPLOAD_ROOT, TENANT), { recursive: true, force: true });
}

async function main() {
  await db.connect();
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  await db.query(`INSERT INTO tenant_registry (tenant_id,name,status) VALUES ($1,'Sup UAT','active')`, [TENANT]);
  await db.query(`INSERT INTO dept (tenant_id,name,code,is_default) VALUES ($1,'后勤部','SUP-DEPT',true)`, [TENANT]);
  const admin = await db.query(`INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active) VALUES ($1,'sup_admin',$2,'补充管理员','admin',true) RETURNING id`, [TENANT, hash(PASS)]);
  await db.query('COMMIT');

  // 平台管理员（独立体系）
  await db.query(`INSERT INTO platform_admin (username,password_hash,display_name,active) VALUES ($1,$2,'E2E平台',true)`, [PLATFORM_USER, hash(PASS)]);
  const now = Math.floor(Date.now() / 1000);
  const jwt = await import('../dist/middleware/auth.js');
  const adminToken = jwt.signJwt({ sub: admin.rows[0].id, tid: TENANT, role: 'admin', username: 'sup_admin', tv: 0, iat: now, exp: now + 3600 }, process.env.JWT_SECRET);

  // ===== 网管监控 =====
  const dev = await request('POST', '/monitor/devices', { name: 'E2E监控设备', ip: '10.0.0.9', category: 'server', status: 'online' }, adminToken);
  assert(dev.status === 201, `建设备 ${dev.status} ${JSON.stringify(dev.body)}`);
  const devId = dev.body.item.id;
  const alert = await request('POST', `/monitor/devices/${devId}/alert`, { level: 'critical', message: 'E2E断网' }, adminToken);
  record('监控：设备告警创建', alert.status === 201 ? 'PASS' : `HTTP ${alert.status}`);
  const alertId = alert.body.item.id;
  const resolve = await request('POST', `/monitor/alerts/${alertId}/resolve`, {}, adminToken);
  record('监控：告警处置', resolve.status === 200 ? 'PASS' : `HTTP ${resolve.status}`);
  const alert2 = await request('POST', `/monitor/devices/${devId}/alert`, { level: 'warning', message: 'E2E转单' }, adminToken);
  const convert = await request('POST', `/monitor/alerts/${alert2.body.item.id}/convert`, {}, adminToken);
  record('监控：告警转工单', convert.status === 200 && !!(convert.body.result && convert.body.result.orderNo) ? 'PASS' : `HTTP ${convert.status} ${JSON.stringify(convert.body)}`);
  const devList = await request('GET', '/monitor/devices', undefined, adminToken);
  record('监控：设备列表', devList.status === 200 && (devList.body.items || []).some((x) => x.id === devId) ? 'PASS' : `HTTP ${devList.status}`);

  // ===== 能耗 =====
  const edef = await request('GET', '/energy/def');
  record('能耗：状态图自述', edef.status === 200 && !!edef.body.def ? 'PASS' : `HTTP ${edef.status}`);

  // ===== 平台端 + 试用 =====
  const login = await request('POST', '/platform/auth/login', { username: PLATFORM_USER, password: PASS });
  assert(login.status === 200 && login.body.token, `平台登录 ${login.status} ${JSON.stringify(login.body)}`);
  const pt = login.body.token;
  const summary = await request('GET', '/platform/summary', undefined, pt);
  record('平台：总览', summary.status === 200 ? 'PASS' : `HTTP ${summary.status}`);
  const tenants = await request('GET', '/platform/tenants', undefined, pt);
  record('平台：租户列表', tenants.status === 200 ? 'PASS' : `HTTP ${tenants.status}`);
  const unauth = await request('GET', '/platform/summary');
  record('平台：无 token 401', unauth.status === 401 ? 'PASS' : `HTTP ${unauth.status}`);

  const apply = await request('POST', '/public/trial-applications', {
    org_name: 'E2E试用机构', contact_name: '测试联系人', phone: TRIAL_PHONE, category: 'hospital', note: '自动化测试',
  });
  record('试用：提交申请', apply.status === 201 || apply.status === 200 ? 'PASS' : `HTTP ${apply.status}`);
  const trials = await request('GET', '/platform/trial-applications?status=pending', undefined, pt);
  const mine = (trials.body.items || []).find((x) => x.phone === TRIAL_PHONE);
  record('试用：平台列表可见', trials.status === 200 && !!mine ? 'PASS' : `HTTP ${trials.status}`);
  if (mine) {
    const reject = await request('POST', `/platform/trial-applications/${mine.id}/review`, { action: 'reject', reason: 'E2E自动化退回' }, pt);
    record('试用：驳回', reject.status === 200 ? 'PASS' : `HTTP ${reject.status}`);
  }

  const fails = results.filter((r) => r.status !== 'PASS');
  console.log('[sup] SUMMARY', JSON.stringify(results, null, 2));
  console.log(fails.length ? `[sup] GAPS=${fails.length}` : '[sup] NO_GAPS');
}

try {
  await main();
} finally {
  await cleanup();
  await db.end();
  console.log('[sup] cleaned', TENANT);
}
