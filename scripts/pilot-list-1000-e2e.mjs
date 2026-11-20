// 1000 条工单列表性能测试（真实 API + 真实库）
//
// 目的：验证分页/深分页/工作台在 1000 条数据下的表现。
// 数据：直接 SQL 插入 1000 条临时工单（ext.perf_seed 标记），不走建单 API，
//       因此不触发自动派单、通知、事件写入；结束后按标记删除。
//
// 运行（ECS）：
//   cd /opt/youfu/pilot/backend
//   PGDATABASE=youfu_pilot ENV_FILE=.env \
//     /opt/node16/bin/node pilot-list-1000-e2e.mjs
import { readFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import pg from 'pg';

const { Client } = pg;
const TENANT = process.env.PILOT_TENANT || 'zixing-hospital';
const API = (process.env.PILOT_API_BASE || 'https://youfu.banerz.cn/pilot/api/v1').replace(/\/+$/, '');
const RUN = process.env.PERF_RUN_ID || `l${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const ROWS = Math.max(1, Number(process.env.PERF_LIST_ROWS || 1000));
const ROUNDS = Math.max(1, Number(process.env.PERF_LIST_ROUNDS || 20));

function loadEnv() {
  for (const f of [process.env.ENV_FILE || '.env', '/opt/youfu/pilot/initial-credentials.txt']) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();

const db = new Client({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'youfu_pilot',
  user: process.env.PGUSER || 'youfu_app',
  password: process.env.PGPASSWORD,
});

function request(method, url, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const started = process.hrtime.bigint();
    const req = mod.request(u, {
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { raw }; }
        resolve({ status: res.statusCode, body: parsed, ms });
      });
    });
    req.on('error', (e) => reject(Object.assign(e, { ms: Number(process.hrtime.bigint() - started) / 1e6 })));
    if (data) req.write(data);
    req.end();
  });
}

async function login(username, password, channel) {
  const r = await request('POST', `${API}/auth/login`, { username, password, tenant: TENANT, channel });
  if (r.status !== 200 || !r.body?.token) throw new Error(`login ${username} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); };
function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
function summarize(name, rows) {
  const ok = rows.filter((r) => r.status >= 200 && r.status < 300);
  const lat = ok.map((r) => r.ms);
  const s = {
    name, total: rows.length, ok: ok.length,
    error_rate: rows.length ? Number((((rows.length - ok.length) / rows.length) * 100).toFixed(2)) : 0,
    p50: Number(percentile(lat, 50).toFixed(1)),
    p95: Number(percentile(lat, 95).toFixed(1)),
    p99: Number(percentile(lat, 99).toFixed(1)),
    max: Number((lat.length ? Math.max(...lat) : 0).toFixed(1)),
    statuses: rows.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {}),
  };
  console.log(`[list1000] ${name}:`, JSON.stringify(s));
  return s;
}

async function seed() {
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  const dept = await db.query(`SELECT id FROM dept WHERE tenant_id=$1 AND name='后勤设备科' LIMIT 1`, [TENANT]);
  assert(dept.rowCount === 1, '试点租户缺少 后勤设备科');
  const deptId = dept.rows[0].id;
  await db.query(
    `INSERT INTO work_orders
       (id, tenant_id, order_no, business_type, catalog, priority, location, title, description,
        status, assignee_id, source, department_id, department_source, ext, created_by, def_version,
        sla_minutes, sla_due_at, created_at, updated_at)
     SELECT
       'PERF-LIST-' || $2 || '-' || lpad(i::text, 4, '0'),
       $1,
       'PL-' || $2 || '-' || lpad(i::text, 4, '0'),
       'repair', 'hosp_water', 'normal', '后勤设备科',
       '列表压测-' || i, '自动化列表压测，请忽略',
       CASE WHEN i % 3 = 0 THEN 'completed' ELSE 'assigned' END,
       'HQ016', 'backend', $3, 'default',
       jsonb_build_object('perf_seed', $2), NULL, 0,
       240, now() + interval '4 hours',
       now() - (i || ' minutes')::interval, now() - (i || ' minutes')::interval
     FROM generate_series(1, $4::int) AS i`,
    [TENANT, RUN, deptId, ROWS],
  );
  const count = await db.query(`SELECT count(*)::int c FROM work_orders WHERE tenant_id=$1 AND ext->>'perf_seed'=$2`, [TENANT, RUN]);
  assert(count.rows[0].c === ROWS, `插入行数 ${count.rows[0].c} != ${ROWS}`);
  await db.query('COMMIT');
}

async function cleanup() {
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  const r = await db.query(`DELETE FROM work_orders WHERE tenant_id=$1 AND ext->>'perf_seed'=$2`, [TENANT, RUN]);
  await db.query('COMMIT');
  console.log(`[list1000] cleanup deleted=${r.rowCount}`);
}

async function measure(admin, name, path, rounds) {
  const rows = [];
  for (let i = 0; i < rounds; i += 1) {
    rows.push(await request('GET', `${API}${path}`, undefined, admin));
  }
  return summarize(name, rows);
}

async function main() {
  await db.connect();
  await seed();
  const admin = await login(process.env.admin_user || 'admin', process.env.admin_password, 'pc');

  const page1 = await measure(admin, 'page1(limit=100)', '/open/work_orders?limit=100', ROUNDS);
  assert(page1.p95 < 1500, `page1 p95 ${page1.p95}ms 超过 1500ms`);

  const deep = await measure(admin, 'deep(offset=900,limit=100)', '/open/work_orders?offset=900&limit=100', ROUNDS);
  assert(deep.p95 < 2500, `深分页 p95 ${deep.p95}ms 超过 2500ms`);

  const page200 = await measure(admin, 'page200(offset=800,limit=200)', '/open/work_orders?offset=800&limit=200', Math.max(5, Math.floor(ROUNDS / 2)));
  assert(page200.p95 < 3000, `limit=200 p95 ${page200.p95}ms 超过 3000ms`);

  const wb = await measure(admin, 'workbench', '/stats/workbench', Math.max(5, Math.floor(ROUNDS / 2)));
  assert(wb.p95 < 3000, `工作台 p95 ${wb.p95}ms 超过 3000ms`);

  const total = (await request('GET', `${API}/open/work_orders?limit=1`, undefined, admin)).body?.total;
  assert(total >= ROWS, `列表 total ${total} 应 >= ${ROWS}`);

  console.log('[list1000] SUMMARY', JSON.stringify({ run: RUN, rows: ROWS, total, page1, deep, page200, wb }, null, 2));
  console.log(`[list1000] PASS run=${RUN} rows=${ROWS}`);
}

main()
  .then(async () => { await cleanup(); await db.end(); process.exit(0); })
  .catch(async (e) => {
    console.error('[list1000] FAILED', e.message);
    await cleanup().catch(() => {});
    try { await db.end(); } catch { /* ignore */ }
    process.exit(1);
  });
