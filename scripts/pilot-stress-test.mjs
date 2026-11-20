// pilot 深度压力测试（2026-11-15）
//
// 目标：在隔离 UAT 租户上做读/写/竞争/混合/上传/大列表/登录限频压力测试，
// 采集客户端延迟分位、错误分布、服务端 RSS/CPU、数据库连接数，并在结束后清理。
//
// 运行（ECS）：
//   cd /opt/youfu/pilot/backend
//   ENV_FILE=.env E2E_RUN_ID=st1 /opt/node16/bin/node scripts/pilot-stress-test.mjs
import { readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;
const BASE = (process.env.PILOT_API_BASE || 'http://127.0.0.1:4101/api/v1').replace(/\/+$/, '');
const ROOT = BASE.replace(/\/api\/v1$/, '');
const UPLOAD_ROOT = process.env.UPLOAD_DIR || '/opt/youfu/pilot/uploads';
const RUN = (process.env.E2E_RUN_ID || `st${Date.now().toString(36)}`).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
const TENANT = `uat-stress-${RUN}`;
const PASS = 'Stress!2026';
const SOURCE_TENANT = process.env.SOURCE_TENANT || 'zixing-hospital';
const LIGHT = process.env.STRESS_LIGHT === '1'; // 主站等共享环境用轻量档：跳过 200 并发/1万单/长 soak

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
const samplerDb = new Client({
  host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'youfu_pilot',
  user: process.env.PGUSER || 'youfu_app', password: process.env.PGPASSWORD,
});

const agent = new http.Agent({ keepAlive: true, maxSockets: 120 });

function request(method, p, body, token, extraHeaders) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const u = new URL(p.startsWith('http') ? p : BASE + p);
    const req = http.request(u, {
      method,
      agent,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(extraHeaders || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = null; }
        resolve({ status: res.statusCode, body: parsed, ms });
      });
    });
    req.on('error', (e) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      resolve({ status: 0, error: e.message, ms });
    });
    if (data) req.write(data);
    req.end();
  });
}

function pct(values, p) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1));
}
function summary(results) {
  const lat = results.map((r) => r.ms);
  const by = {};
  for (const r of results) by[String(r.status)] = (by[String(r.status)] || 0) + 1;
  const five = results.filter((r) => r.status >= 500).length;
  return {
    total: results.length,
    ok: results.filter((r) => r.status >= 200 && r.status < 300).length,
    p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: pct(lat, 100),
    byStatus: by, five, errors: results.filter((r) => r.status === 0).length,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runPool(concurrency, total, fn) {
  const out = new Array(total);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= total) return;
      out[i] = await fn(i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

function hashPassword(p) {
  const s = crypto.randomBytes(16);
  return `scrypt$${s.toString('hex')}$${crypto.scryptSync(p, s, 64).toString('hex')}`;
}
function uuid() { return crypto.randomUUID(); }

const results = [];
function record(name, data, verdict) {
  results.push({ name, ...data, verdict });
  console.log(`\n[${verdict}] ${name}`, JSON.stringify(data));
}

function serverPid() {
  try {
    const out = execSync("ss -ltnp 2>/dev/null | grep ':4101' | head -1", { encoding: 'utf8' });
    const m = /pid=(\d+)/.exec(out);
    return m ? m[1] : null;
  } catch { return null; }
}
function sampleServer(pid) {
  if (!pid) return null;
  try {
    const out = execSync(`ps -o rss=,%cpu= -p ${pid}`, { encoding: 'utf8' }).trim().split(/\s+/);
    return { rssMB: Math.round(Number(out[0]) / 1024), cpu: Number(out[1]) };
  } catch { return null; }
}

async function dbStats() {
  try {
    const r = await samplerDb.query(`SELECT state, count(*)::int c FROM pg_stat_activity WHERE datname=current_database() GROUP BY state`);
    const row = await samplerDb.query(`SELECT count(*)::int c FROM pg_stat_activity WHERE datname=current_database()`);
    return { total: row.rows[0].c, byState: Object.fromEntries(r.rows.map((x) => [x.state || 'null', x.c])) };
  } catch (e) { return { error: e.message }; }
}

async function tenantQuery(sql, params = []) {
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  const r = await db.query(sql, params);
  await db.query('COMMIT');
  return r;
}

async function setup() {
  await db.connect();
  // 源流程
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [SOURCE_TENANT]);
  const src = await db.query(`SELECT def, version FROM workflow_def WHERE tenant_id=$1 AND entity_type='work_order' ORDER BY version DESC LIMIT 1`, [SOURCE_TENANT]);
  await db.query('COMMIT');
  if (!src.rowCount) throw new Error('source workflow_def missing: ' + SOURCE_TENANT);

  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  await db.query(`INSERT INTO tenant_registry (tenant_id,name,status) VALUES ($1,'压测租户','active')`, [TENANT]);
  const dept = await db.query(`INSERT INTO dept (tenant_id,name,code,is_default,enabled) VALUES ($1,'压测部门','STRESS',true,true) RETURNING id`, [TENANT]);
  const deptId = dept.rows[0].id;
  await db.query(`INSERT INTO fault_category (tenant_id,code,name,business_type,skill_tags,sort,enabled) VALUES ($1,'STRESS','压测故障','repair','[]'::jsonb,1,true)`, [TENANT]);
  await db.query(`INSERT INTO location_dict (tenant_id,code,name,category,enabled) VALUES ($1,'STRESS-LOC','压测位置','位置',true)`, [TENANT]);
  const stressDef = JSON.parse(JSON.stringify(src.rows[0].def));
  stressDef.transitions = Array.isArray(stressDef.transitions) ? stressDef.transitions : [];
  if (!stressDef.transitions.some((t) => t.event === 'claim')) {
    stressDef.transitions.push({ from: 'pending', to: 'assigned', event: 'claim', allowedRoles: ['admin', 'worker'] });
  }
  await db.query(`INSERT INTO workflow_def (tenant_id,entity_type,def,version,updated_by) VALUES ($1,'work_order',$2::jsonb,$3,'stress')`, [TENANT, JSON.stringify(stressDef), src.rows[0].version]);

  const accounts = {};
  for (const [u, role] of [['stress_admin', 'admin'], ['stress_op', 'operator'], ...Array.from({ length: 10 }, (_, i) => [`stress_w${i + 1}`, 'worker'])]) {
    const acc = await db.query(`INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active) VALUES ($1,$2,$3,$4,$5,true) RETURNING id`, [TENANT, u, hashPassword(PASS), u, role]);
    accounts[u] = acc.rows[0].id;
    if (role === 'worker') {
      await db.query(`INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id,department_id) VALUES ($1,$2,$3,'{}'::text[],0,true,$1,$4)`, [acc.rows[0].id, TENANT, u, deptId]);
    }
  }

  // 基础读数据
  await db.query(`INSERT INTO work_orders (id,tenant_id,order_no,business_type,title,status,source,department_id,def_version,priority)
    SELECT gen_random_uuid(), $1, 'STRESS-'||g, 'repair', '压测工单 '||g, 'pending', 'backend', $2, 0, 'normal' FROM generate_series(1,300) g`, [TENANT, deptId]);
  await db.query(`INSERT INTO notification (tenant_id,recipient,recipient_kind,type,work_order_id,title,payload)
    SELECT $1, $2, 'worker', 'stress', 'wo-'||g, '压测通知 '||g, '{}'::jsonb FROM generate_series(1,200) g`, [TENANT, accounts.stress_admin]);
  await db.query(`INSERT INTO asset (tenant_id,asset_no,name,status,location) SELECT $1, 'STRESS-A-'||g, '压测资产 '||g, 'in_use', '压测位置' FROM generate_series(1,100) g`, [TENANT]);
  await db.query(`INSERT INTO inspection_task (tenant_id,title,status,type,items_json) SELECT $1, '压测巡检 '||g, 'pending', 'free', '[]'::jsonb FROM generate_series(1,100) g`, [TENANT]);
  await db.query('COMMIT');

  // JWT 直签（避免登录限频影响压力测试）
  const jwt = await import('../dist/middleware/auth.js');
  const now = Math.floor(Date.now() / 1000);
  const tokenOf = (u, role) => jwt.signJwt({ sub: accounts[u], tid: TENANT, role, username: u, tv: 0, iat: now, exp: now + 7200 }, process.env.JWT_SECRET);
  return { deptId, accounts, admin: tokenOf('stress_admin', 'admin'), op: tokenOf('stress_op', 'operator'), workers: Array.from({ length: 10 }, (_, i) => tokenOf(`stress_w${i + 1}`, 'worker')) };
}

async function cleanup() {
  try {
    const sql = `
BEGIN;
SET LOCAL session_replication_role = replica;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id'
  LOOP EXECUTE format('DELETE FROM %I WHERE tenant_id=$1', r.table_name) USING '${TENANT}'; END LOOP;
END $$;
COMMIT;`;
    execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', process.env.PGDATABASE || 'youfu_pilot', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' });
    execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', process.env.PGDATABASE || 'youfu_pilot', '-v', 'ON_ERROR_STOP=1', '-c', `DELETE FROM platform_audit WHERE target_tenant='${TENANT}'`], { stdio: 'pipe' });
    // 清理所有可能的 uploads 根：主站默认 /opt/youfu/uploads，pilot 默认 /opt/youfu/pilot/uploads；
    // 历史脚本只按 UPLOAD_ROOT 删，跨环境会漏删（2026-11-15 实测遗留 uat-* 目录）。
    for (const root of new Set([process.env.UPLOAD_DIR, '/opt/youfu/uploads', '/opt/youfu/pilot/uploads'].filter(Boolean))) {
      rmSync(path.join(root, TENANT), { recursive: true, force: true });
    }
    console.log('[stress] cleaned', TENANT);
  } catch (e) { console.error('[stress] cleanup failed', e.message); }
}

async function main() {
  const ctx = await setup();
  await samplerDb.connect();
  const { admin, op, workers, deptId, accounts } = ctx;
  const pid = serverPid();
  const samples = [];
  const sampler = setInterval(async () => {
    const s = sampleServer(pid);
    if (s) samples.push({ t: Date.now(), ...s, db: await dbStats() });
  }, 5000);

  const readEndpoints = [
    '/open/work_orders?limit=50',
    '/stats/workbench',
    '/stats',
    '/assets?limit=50',
    '/inspection/tasks?limit=50',
    '/open/notifications?limit=50',
  ];

  // A. 读突发：50 并发 × 200
  const readRes = await runPool(50, 200, (i) => request('GET', readEndpoints[i % readEndpoints.length], undefined, admin));
  const readS = summary(readRes);
  record('读突发 50并发×200', readS, readS.five === 0 && readS.errors === 0 && readS.p95 < 800 ? 'PASS' : 'WARN');

  // A2. 更高并发读：100 / 200 并发，观察连接池排队与 5xx
  for (const [conc, total] of (LIGHT ? [[100, 200]] : [[100, 300], [200, 200]])) {
    const ramp = await runPool(conc, total, (i) => request('GET', readEndpoints[i % readEndpoints.length], undefined, admin));
    const s = summary(ramp);
    record(`读压力 ${conc}并发×${total}`, s, s.five === 0 && s.errors === 0 ? 'PASS' : 'WARN');
  }

  // B. 写突发：20 并发 × 100 建单
  const writeRes = await runPool(20, 100, () => request('POST', '/open/work_order', {
    id: uuid(), business_type: 'repair', catalog: 'STRESS', title: '压测建单 ' + crypto.randomBytes(3).toString('hex'),
    description: 'stress', location: '压测位置', priority: 'normal',
  }, admin, { 'Idempotency-Key': uuid() }));
  const writeS = summary(writeRes);
  record('写突发 20并发×100建单', writeS, writeS.five === 0 && writeS.errors === 0 && writeS.p95 < 2000 ? 'PASS' : 'WARN');

  // B2. 50 并发写 200 单：观察连接池排队/锁竞争（主站轻量档跳过 50，保留 20 并发写）
  const writeRes2 = LIGHT ? [] : await runPool(50, 200, () => request('POST', '/open/work_order', {
    id: uuid(), business_type: 'repair', catalog: 'STRESS', title: '压测建单2 ' + crypto.randomBytes(3).toString('hex'),
    description: 'stress2', location: '压测位置', priority: 'normal',
  }, admin, { 'Idempotency-Key': uuid() }));
  if (!LIGHT) {
    const writeS2 = summary(writeRes2);
    record('写压力 50并发×200建单', writeS2, writeS2.five === 0 && writeS2.errors === 0 ? 'PASS' : 'WARN');
  }

  // C. 流转突发：100 张已派单，20 并发到场
  const ids = [];
  for (let i = 0; i < 100; i++) {
    const r = await request('POST', '/open/work_order', { id: uuid(), business_type: 'repair', catalog: 'STRESS', title: '流转压测 ' + i, description: 'stress', location: '压测位置', priority: 'normal' }, admin, { 'Idempotency-Key': uuid() });
    if (r.body?.id) ids.push(r.body.id);
  }
  // assigned --arrive--> arrived；pending 不能直接 arrived（422），这里直接构造已派单态。
  await tenantQuery(`UPDATE work_orders SET status='assigned', assignee_id=$2 WHERE id = ANY($1::text[])`, [ids, accounts.stress_w1]);
  const transRes = await runPool(20, ids.length, (i) => request('POST', `/open/work_order/${ids[i]}/transition`, { to: 'arrived' }, workers[0]));
  const transS = summary(transRes);
  record('流转突发 20并发×100', transS, transS.five === 0 && transS.byStatus['200'] >= 90 ? 'PASS' : 'WARN');

  // D. 竞争场景
  const contention = {};
  // D1 抢单：1 单 50 并发
  {
    const r = await request('POST', '/open/work_order', { id: uuid(), business_type: 'repair', catalog: 'STRESS', title: '抢单竞争', description: 'stress', location: '压测位置', priority: 'normal' }, admin, { 'Idempotency-Key': uuid() });
    const id = r.body?.id;
    await tenantQuery(`UPDATE work_orders SET status='claim_hall', assignee_id=NULL WHERE id=$1`, [id]);
    const out = await runPool(50, 50, (i) => request('POST', `/open/work_order/${id}/claim`, {}, workers[i % workers.length]));
    const s = summary(out);
    contention.claim = s;
    record('抢单竞争 50并发', s, s.byStatus['200'] === 1 && s.five === 0 ? 'PASS' : 'WARN');
  }
  // D2 巡更扫码：1 任务 50 并发
  {
    const p = await request('POST', '/patrol/points', { name: '压测巡更点', location: '压测位置', seq: 1 }, admin);
    const t = await request('POST', '/patrol/tasks', { title: '压测巡更', assignee: accounts.stress_w1, point_ids: [p.body?.item?.id] }, admin);
    const code = p.body?.item?.checkin_code;
    const tid = t.body?.item?.id;
    const out = code && tid ? await runPool(50, 50, () => request('POST', `/patrol/tasks/${tid}/checkin`, { code }, workers[0])) : [];
    const s = summary(out);
    contention.patrol = s;
    record('巡更扫码竞争 50并发', s, s.byStatus['200'] === 1 && s.five === 0 ? 'PASS' : 'WARN');
  }
  // D3 库存超卖：10 件，50 并发各出 1
  {
    const m = await request('POST', '/materials', { code: `STRESS-M-${RUN}`, name: '压测耗材', unit: '个', price: 1, enabled: true }, admin);
    const mid = m.body?.item?.id;
    await request('POST', '/inventory/in', { material_id: mid, qty: 10 }, admin);
    const out = await runPool(50, 50, () => request('POST', '/inventory/out', { material_id: mid, qty: 1 }, admin));
    const s = summary(out);
    const inv = await request('GET', '/inventory', undefined, admin);
    const row = (inv.body?.items || []).find((x) => x.material_id === mid);
    contention.inventory = { ...s, qty: row?.qty };
    record('库存超卖 50并发', contention.inventory, s.byStatus['200'] === 10 && Number(row?.qty) === 0 && s.five === 0 ? 'PASS' : 'WARN');
  }
  // D4 志愿名额：1 名额 50 并发报名
  {
    const a = await request('POST', '/volunteer/activities', {
      title: '压测志愿', location: '压测位置', slots: 1,
      start_at: new Date(Date.now() + 3600e3).toISOString(),
      end_at: new Date(Date.now() + 7200e3).toISOString(),
    }, admin);
    const aid = a.body?.item?.id;
    const out = aid ? await runPool(50, 50, (i) => request('POST', `/volunteer/activities/${aid}/signup`, { user_name: `压测志愿者${i}` }, admin)) : [];
    const s = summary(out);
    contention.volunteer = s;
    record('志愿名额竞争 50并发', s, s.byStatus['201'] === 1 && s.five === 0 ? 'PASS' : 'WARN');
  }

  // E. 上传压力：10 并发 × 2 轮 1MB
  {
    const b64 = crypto.randomBytes(1024 * 1024).toString('base64');
    const out = [];
    for (let round = 0; round < 2; round++) {
      const r = await runPool(10, 10, () => request('POST', '/upload', { filename: 'stress.png', contentType: 'image/png', base64: b64 }, admin));
      out.push(...r);
    }
    const s = summary(out);
    record('上传压力 10并发×2轮 1MB', s, s.five === 0 && s.byStatus['200'] === 20 && s.p95 < 5000 ? 'PASS' : 'WARN');
  }

  // F. 大列表：1 万单（主站轻量档跳过）
  if (!LIGHT) {
    await tenantQuery(`INSERT INTO work_orders (id,tenant_id,order_no,business_type,title,status,source,department_id,def_version,priority)
      SELECT gen_random_uuid(), $1, 'STRESS-BULK-'||g, 'repair', '大列表 '||g, 'pending', 'backend', $2, 0, 'normal' FROM generate_series(1,10000) g`, [TENANT, deptId]);
    const out = [];
    for (let i = 0; i < 20; i++) {
      out.push(await request('GET', i % 2 ? '/open/work_orders?limit=200&offset=9000' : '/open/work_orders?limit=200', undefined, admin));
    }
    const s = summary(out);
    record('大列表 1万单 20次', s, s.five === 0 && s.p95 < 1500 ? 'PASS' : 'WARN');
  }

  // G. 混合 soak：120s，20 并发，80% 读 / 20% 写
  {
    const durationMs = LIGHT ? 30000 : 120000;
    const endAt = Date.now() + durationMs;
    const out = [];
    const counter = { i: 0 };
    const before = sampleServer(pid);
    await runPool(20, 20, async () => {
      while (Date.now() < endAt) {
        const i = counter.i++;
        await sleep(350 + Math.floor(Math.random() * 250));
        if (i % 5 === 0) {
          out.push(await request('POST', '/open/work_order', { id: uuid(), business_type: 'repair', catalog: 'STRESS', title: 'soak ' + i, description: 'soak', location: '压测位置', priority: 'normal' }, admin, { 'Idempotency-Key': uuid() }));
        } else {
          out.push(await request('GET', readEndpoints[i % readEndpoints.length], undefined, admin));
        }
      }
    });
    const s = summary(out);
    const after = sampleServer(pid);
    const dbNow = await dbStats();
    record('混合 soak 120s', { ...s, rssBefore: before?.rssMB, rssAfter: after?.rssMB, db: dbNow }, s.five === 0 && s.errors === 0 && s.p95 < 1500 ? 'PASS' : 'WARN');
  }

  // H. 登录限频：15 次错误密码
  {
    const out = [];
    for (let i = 0; i < 15; i++) {
      out.push(await request('POST', '/auth/login', { username: 'stress_admin', password: 'wrong', tenant: TENANT, channel: 'pc' }));
    }
    const s = summary(out);
    record('登录限频 15次', { ...s, codes: s.byStatus }, s.byStatus['429'] >= 1 && s.five === 0 ? 'PASS' : 'WARN');
  }

  // 结果与环境
  clearInterval(sampler);
  const finalSrv = sampleServer(pid);
  const finalDb = await dbStats();
  const report = {
    run: RUN, tenant: TENANT, at: new Date().toISOString(),
    serverPid: pid, samples, final: { server: finalSrv, db: finalDb },
    results,
    health: await request('GET', ROOT + '/health/ready'),
  };
  const file = `/tmp/pilot-stress-${RUN}.json`;
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log('\nSTRESS_JSON=' + file);
  console.log('SUMMARY=' + JSON.stringify(results.map((r) => ({ name: r.name, verdict: r.verdict, total: r.total, p95: r.p95, five: r.five, byStatus: r.byStatus }))));

  await cleanup();
  await samplerDb.end();
  await db.end();
}

main().catch(async (e) => {
  console.error('FATAL', e);
  try { await cleanup(); } catch {}
  process.exit(1);
});
