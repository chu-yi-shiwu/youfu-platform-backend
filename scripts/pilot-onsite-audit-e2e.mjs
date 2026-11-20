// 方向 B 现场真实性 · 线上审计（隔离 UAT 租户）
// 覆盖：巡更点位扫码签到（扫码/手工/错码）、巡检定位策略（warn/block）、巡检逾期派生。
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
const RUN = `on${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const TENANT = `uat-onsite-${RUN}`;
const PASS = 'Onsite!2026';

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
function record(name, status, note) { results.push({ name, status, note }); console.log(`[onsite] ${status} ${name}${note ? ' — ' + note : ''}`); }

async function sql(q, params = []) {
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  const r = await db.query(q, params);
  await db.query('COMMIT');
  return r;
}
async function cleanup() {
  const q = `BEGIN; SET LOCAL session_replication_role = replica;
DO $$ DECLARE r record; BEGIN
FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id'
LOOP EXECUTE format('DELETE FROM %I WHERE tenant_id=$1', r.table_name) USING '${TENANT}'; END LOOP; END $$; COMMIT;`;
  try { execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', process.env.PGDATABASE || 'youfu_pilot', '-v', 'ON_ERROR_STOP=1', '-c', q], { stdio: 'pipe' }); } catch (e) { console.error('cleanup', e.message); }
  rmSync(path.join(UPLOAD_ROOT, TENANT), { recursive: true, force: true });
}

async function main() {
  await db.connect();
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  await db.query(`INSERT INTO tenant_registry (tenant_id,name,status) VALUES ($1,'Onsite UAT','active')`, [TENANT]);
  await db.query(`INSERT INTO dept (tenant_id,name,code,is_default) VALUES ($1,'后勤部','ON-DEPT',true)`, [TENANT]);
  const admin = await db.query(`INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active) VALUES ($1,'onsite_admin',$2,'现场管理员','admin',true) RETURNING id`, [TENANT, hash(PASS)]);
  const wacc = await db.query(`INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active) VALUES ($1,'onsite_worker',$2,'巡更员','worker',true) RETURNING id`, [TENANT, hash(PASS)]);
  const worker = await db.query(`INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id) VALUES ($1,$2,'巡更员','{}'::text[],0,true,$3) RETURNING id`, [`OW-${RUN}`, TENANT, wacc.rows[0].id]);
  await db.query('COMMIT');

  const now = Math.floor(Date.now() / 1000);
  const adminToken = signJwt({ sub: admin.rows[0].id, tid: TENANT, role: 'admin', username: 'onsite_admin', tv: 0, iat: now, exp: now + 3600 }, process.env.JWT_SECRET);
  const workerToken = signJwt({ sub: wacc.rows[0].id, tid: TENANT, role: 'worker', username: 'onsite_worker', tv: 0, iat: now, exp: now + 3600 }, process.env.JWT_SECRET);
  const workerId = worker.rows[0].id;

  // ===== 巡更扫码 =====
  const point = await request('POST', '/patrol/points', { name: '东门', location: '1F 大厅', seq: 1 }, adminToken);
  assert(point.status === 201, `建点位 ${point.status}`);
  const pointId = point.body.item.id;
  const code = point.body.item.checkin_code;
  record('巡更点位：创建即生成签到码', !!code ? 'PASS' : 'FAIL', String(code));

  const task = await request('POST', '/patrol/tasks', { title: '扫码审计任务', assignee: workerId, point_ids: [pointId] }, adminToken);
  assert(task.status === 201, `建任务 ${task.status}`);
  const taskId = task.body.item.id;

  const noScan = await request('POST', `/patrol/tasks/${taskId}/checkin`, { point_id: pointId }, workerToken);
  record('巡更：worker 不扫码 → 403 SCAN_REQUIRED', noScan.status === 403 && noScan.body.code === 'SCAN_REQUIRED' ? 'PASS' : `HTTP ${noScan.status} code=${noScan.body.code}`);
  const wrong = await request('POST', `/patrol/tasks/${taskId}/checkin`, { code: 'WRONGCODE' }, workerToken);
  record('巡更：错误签到码 → 404', wrong.status === 404 ? 'PASS' : `HTTP ${wrong.status}`);
  const scan = await request('POST', `/patrol/tasks/${taskId}/checkin`, { code }, workerToken);
  const checkins = scan.body.item?.checkins ?? [];
  record('巡更：扫码签到 200 + via=scan', scan.status === 200 && checkins[0]?.via === 'scan' ? 'PASS' : `HTTP ${scan.status} via=${checkins[0]?.via}`);

  const task2 = await request('POST', '/patrol/tasks', { title: '手工补签任务', assignee: workerId, point_ids: [pointId] }, adminToken);
  const manual = await request('POST', `/patrol/tasks/${task2.body.item.id}/checkin`, { point_id: pointId }, adminToken);
  record('巡更：管理端手工补签 200 + via=manual', manual.status === 200 && manual.body.item?.checkins?.[0]?.via === 'manual' ? 'PASS' : `HTTP ${manual.status}`);

  // ===== 巡检定位策略 =====
  const ip = await request('POST', '/inspection/points', { name: '配电房', code: `IP-${RUN}`, lat: 30, lng: 110 }, adminToken);
  assert(ip.status === 201, `建巡检点 ${ip.status}`);
  const ipId = ip.body.item.id;
  const mkTask = async (title, scheduledAt) => {
    const r = await request('POST', '/inspection/tasks', { title, point_id: ipId, assignee: workerId, scheduled_at: scheduledAt }, adminToken);
    assert(r.status === 201, `建巡检单 ${title} ${r.status}`);
    return r.body.item.id;
  };
  const yesterday = new Date(Date.now() - 86400e3).toISOString();
  const overdueTask = await mkTask('逾期巡检', yesterday);
  const list = await request('GET', '/inspection/tasks?overdue=1', undefined, adminToken);
  record('巡检：overdue=1 命中逾期任务', list.status === 200 && (list.body.items || []).some((x) => x.id === overdueTask && x.overdue === true) ? 'PASS' : `HTTP ${list.status}`);
  const stats = await request('GET', '/inspection/stats', undefined, adminToken);
  record('巡检：统计 overdue 计数', stats.status === 200 && Number(stats.body.stats?.overdue) >= 1 ? 'PASS' : `HTTP ${stats.status} overdue=${stats.body.stats?.overdue}`);

  await request('PUT', '/config/system', { items: [{ key: 'inspection_geo_policy', value: 'warn' }] }, adminToken);
  const t2 = await mkTask('定位 warn 任务', new Date(Date.now() + 3600e3).toISOString());
  const noGeo = await request('POST', `/inspection/tasks/${t2}/checkin`, {}, adminToken);
  record('巡检：warn 未带定位 → 422 GEO_REQUIRED', noGeo.status === 422 && noGeo.body.code === 'GEO_REQUIRED' ? 'PASS' : `HTTP ${noGeo.status} code=${noGeo.body.code}`);
  const near = await request('POST', `/inspection/tasks/${t2}/checkin`, { geo_lat: 30.0001, geo_lng: 110.0001 }, adminToken);
  record('巡检：warn 带定位（近）→ 200', near.status === 200 ? 'PASS' : `HTTP ${near.status}`);

  await request('PUT', '/config/system', { items: [{ key: 'inspection_geo_policy', value: 'block' }] }, adminToken);
  const t3 = await mkTask('定位 block 任务', new Date(Date.now() + 3600e3).toISOString());
  const far = await request('POST', `/inspection/tasks/${t3}/checkin`, { geo_lat: 31, geo_lng: 111 }, adminToken);
  record('巡检：block 超 500m → 422 GEO_TOO_FAR', far.status === 422 && far.body.code === 'GEO_TOO_FAR' ? 'PASS' : `HTTP ${far.status} code=${far.body.code}`);

  const fails = results.filter((r) => r.status !== 'PASS');
  console.log('[onsite] SUMMARY', JSON.stringify(results, null, 2));
  console.log(fails.length ? `[onsite] GAPS=${fails.length}` : '[onsite] NO_GAPS');
  await db.end();
}

try {
  await main();
} finally {
  await cleanup();
  console.log('[onsite] cleaned', TENANT);
}
