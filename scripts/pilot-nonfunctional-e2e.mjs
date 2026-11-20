// 非功能审计（2026-11-14）：未登录/篡改 token、越权、跨租户隔离、幂等、10 并发。
// 双 UAT 租户，结束后按 tenant_id 清理。
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { signJwt } from '../dist/middleware/auth.js';

const { Client } = pg;
const BASE = 'http://127.0.0.1:4101/api/v1';
const UPLOAD_ROOT = '/opt/youfu/pilot/uploads';
const RUN = `nf${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const TA = `uat-nf-a-${RUN}`;
const TB = `uat-nf-b-${RUN}`;
const PASS = 'Nf!2026';

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
function request(method, p, body, token, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const u = new URL(p.startsWith('http') ? p : BASE + p);
    const r = http.request(u, {
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
function record(name, status, note) { results.push({ name, status, note }); console.log(`[nf] ${status} ${name}${note ? ' — ' + note : ''}`); }
async function sqlFor(tenant, q, params = []) {
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [tenant]);
  const r = await db.query(q, params);
  await db.query('COMMIT');
  return r;
}
async function cleanup() {
  for (const tenant of [TA, TB]) {
    try {
      // 2026-11-14：原实现用应用账号 SET session_replication_role → 权限不足，
      // 事务失败后仍打印 cleaned，UAT 租户行残留。改为与其它 UAT 脚本同口径：
      // sudo -u postgres psql 清理（ON_ERROR_STOP，失败会显式抛错而不是假成功）。
      const sql = `
BEGIN;
SET LOCAL session_replication_role = replica;
DO $$ DECLARE r record; BEGIN
FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id'
LOOP EXECUTE format('DELETE FROM %I WHERE tenant_id=$1', r.table_name) USING '${tenant}'; END LOOP; END $$;
COMMIT;`;
      execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', process.env.PGDATABASE || 'youfu_pilot', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' });
    } catch (e) { console.error('cleanup', tenant, e.message); }
    rmSync(path.join(UPLOAD_ROOT, tenant), { recursive: true, force: true });
  }
}

async function main() {
  await db.connect();
  const now = Math.floor(Date.now() / 1000);
  const tokens = {};
  for (const tenant of [TA, TB]) {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [tenant]);
    await db.query(`INSERT INTO tenant_registry (tenant_id,name,status) VALUES ($1,'NF UAT','active')`, [tenant]);
    await db.query(`INSERT INTO dept (tenant_id,name,code,is_default) VALUES ($1,'后勤部','NF-DEPT',true)`, [tenant]);
    const admin = await db.query(`INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active) VALUES ($1,'nf_admin',$2,'NF管理员','admin',true) RETURNING id`, [tenant, hash(PASS)]);
    const worker = await db.query(`INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active) VALUES ($1,'nf_worker',$2,'NF工人','worker',true) RETURNING id`, [tenant, hash(PASS)]);
    await db.query(`INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id) VALUES ($1,$2,'NF工人','{}'::text[],0,true,$3)`, [`NFW-${tenant}`, tenant, worker.rows[0].id]);
    await db.query('COMMIT');
    tokens[tenant] = {
      admin: signJwt({ sub: admin.rows[0].id, tid: tenant, role: 'admin', username: 'nf_admin', tv: 0, iat: now, exp: now + 3600 }, process.env.JWT_SECRET),
      worker: signJwt({ sub: worker.rows[0].id, tid: tenant, role: 'worker', username: 'nf_worker', tv: 0, iat: now, exp: now + 3600 }, process.env.JWT_SECRET),
    };
  }

  // 1) 未登录 / 篡改 token
  const noAuth = await request('GET', '/open/work_orders');
  record('未登录访问 → 401', noAuth.status === 401 ? 'PASS' : `HTTP ${noAuth.status}`);
  const bad = await request('GET', '/open/work_orders', undefined, tokens[TA].admin + 'x');
  record('篡改 token → 401', bad.status === 401 ? 'PASS' : `HTTP ${bad.status}`);

  // 2) worker 越权
  const workerCreate = await request('POST', '/volunteer/activities', { title: '越权活动', slots: 1 }, tokens[TA].worker);
  record('worker 建志愿活动 → 403', workerCreate.status === 403 ? 'PASS' : `HTTP ${workerCreate.status}`);
  const workerAccounts = await request('GET', '/accounts', undefined, tokens[TA].worker);
  record('worker 读账号 → 403', workerAccounts.status === 403 ? 'PASS' : `HTTP ${workerAccounts.status}`);
  const workerSettle = await request('GET', '/settlements', undefined, tokens[TA].worker);
  record('worker 读结算 → 403', workerSettle.status === 403 ? 'PASS' : `HTTP ${workerSettle.status}`);

  // 3) 跨租户隔离（B 建资产/活动，A 不可见）
  const bAsset = await request('POST', '/assets', { name: 'B租户资产', status: 'in_use' }, tokens[TB].admin);
  assert(bAsset.status === 201, `建 B 资产 ${bAsset.status}`);
  const aList = await request('GET', '/assets?code=' + encodeURIComponent(bAsset.body.item.asset_no), undefined, tokens[TA].admin);
  record('跨租户资产列表 → 0', aList.status === 200 && (aList.body.items || []).length === 0 ? 'PASS' : `HTTP ${aList.status}`);

  const bAct = await request('POST', '/volunteer/activities', { title: 'B租户活动', slots: 2 }, tokens[TB].admin);
  assert(bAct.status === 201, `建 B 活动 ${bAct.status}`);
  const aAct = await request('GET', `/volunteer/activities/${bAct.body.item.id}`, undefined, tokens[TA].admin);
  record('跨租户志愿活动 → 404', aAct.status === 404 ? 'PASS' : `HTTP ${aAct.status}`);

  // 4) 幂等建单
  const idem = crypto.randomUUID();
  const key = 'nf-' + crypto.randomUUID();
  const body = { id: idem, title: '幂等测试单', description: '幂等', business_type: 'repair', catalog: 'repair' };
  const w1 = await request('POST', '/open/work_order', body, tokens[TA].admin, { 'Idempotency-Key': key });
  const w2 = await request('POST', '/open/work_order', body, tokens[TA].admin, { 'Idempotency-Key': key });
  record('建单幂等：两次返回同一单', w1.status < 300 && w2.status < 300 && w1.body.id === w2.body.id ? 'PASS' : `HTTP ${w1.status}/${w2.status}`);
  const cnt = await sqlFor(TA, `SELECT count(*)::int c FROM work_orders WHERE tenant_id=$1 AND id=$2`, [TA, idem]);
  record('建单幂等：库中仅 1 条', Number(cnt.rows[0].c) === 1 ? 'PASS' : `count=${cnt.rows[0].c}`);

  // 5) 10 并发抢最后 1 名额
  const act = await request('POST', '/volunteer/activities', { title: '并发最后名额', slots: 1 }, tokens[TA].admin);
  assert(act.status === 201, `建并发活动 ${act.status}`);
  const racers = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    request('POST', `/volunteer/activities/${act.body.item.id}/signup`, { user_name: `并发${i}` }, tokens[TA].admin)));
  const wins = racers.filter((r) => r.status === 201).length;
  const dup = racers.filter((r) => r.status === 409).length;
  record('10 并发抢 1 名额：恰好 1 成功', wins === 1 && dup === 9 ? 'PASS' : `201=${wins} 409=${dup}`);

  // 6) 10 并发重复巡更签到
  const pt = await request('POST', '/patrol/points', { name: '并发点位', seq: 1 }, tokens[TA].admin);
  const task = await request('POST', '/patrol/tasks', { title: '并发巡更', assignee: `NFW-${TA}`, point_ids: [pt.body.item.id] }, tokens[TA].admin);
  const code = pt.body.item.checkin_code;
  const checks = await Promise.all(Array.from({ length: 10 }, () =>
    request('POST', `/patrol/tasks/${task.body.item.id}/checkin`, { code }, tokens[TA].admin)));
  const ok = checks.filter((r) => r.status === 200).length;
  record('10 并发同点签到：恰好 1 成功', ok === 1 ? 'PASS' : `200=${ok}`);

  const fails = results.filter((r) => r.status !== 'PASS');
  console.log('[nf] SUMMARY', JSON.stringify(results, null, 2));
  console.log(fails.length ? `[nf] GAPS=${fails.length}` : '[nf] NO_GAPS');
}

try {
  await main();
} finally {
  await cleanup();
  await db.end();
  console.log('[nf] cleaned', TA, TB);
}
