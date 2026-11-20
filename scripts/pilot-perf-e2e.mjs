// 试点性能与稳定性 E2E（真实 API + 真实库）
//
// 目标：在 pilot 上做可控的并发压测，不碰真实师傅/真实工单：
//   - 创建临时师傅账号（无微信 openid）+ 唯一技能标签；
//   - 所有压测工单只命中该临时师傅；
//   - 工单写 ext.perf_run 标记，结束后按标记清理；
//   - 上传文件同步删除。
//
// 运行（ECS）：
//   cd /opt/youfu/pilot/backend
//   PGDATABASE=youfu_pilot ENV_FILE=.env \
//     /opt/node16/bin/node pilot-perf-e2e.mjs
//
// 可选：
//   PILOT_API_BASE=https://youfu.banerz.cn/pilot/api/v1
//   PERF_CREATE_TOTAL=50
//   PERF_CONCURRENCY=50
//   PERF_WORKERS=5   # 同技能临时师傅数量，避免单行 worker.load 锁造成假瓶颈
//   PERF_LIST_ROUNDS=20
//   PERF_DETAIL_ROUNDS=20
//   PERF_STATS_ROUNDS=10
//   PERF_UPLOAD_TOTAL=5
//   PERF_SOAK_SECONDS=0
//   PERF_SOAK_INTERVAL_MS=1000   # soak 每轮间隔；24h 建议 1000ms（1 rps）
//   PERF_STRESS=0   # 1 = 压测模式，延迟超线只告警，仍对 5xx/重复单号/失败数硬断言
//
// 默认（验收）：20 单 / 10 并发；50 并发请显式设置 PERF_STRESS=1。
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;
const TENANT = process.env.PILOT_TENANT || 'zixing-hospital';
const API = (process.env.PILOT_API_BASE || 'https://youfu.banerz.cn/pilot/api/v1').replace(/\/+$/, '');
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/opt/youfu/pilot/uploads';
const RUN = process.env.PERF_RUN_ID || `p${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const CREATE_TOTAL = Math.max(1, Number(process.env.PERF_CREATE_TOTAL || 20));
const CONCURRENCY = Math.max(1, Math.min(CREATE_TOTAL, Number(process.env.PERF_CONCURRENCY || 10)));
const LIST_ROUNDS = Math.max(1, Number(process.env.PERF_LIST_ROUNDS || 20));
const DETAIL_ROUNDS = Math.max(1, Number(process.env.PERF_DETAIL_ROUNDS || 20));
const STATS_ROUNDS = Math.max(1, Number(process.env.PERF_STATS_ROUNDS || 10));
const UPLOAD_TOTAL = Math.max(0, Number(process.env.PERF_UPLOAD_TOTAL || 5));
const SOAK_SECONDS = Math.max(0, Number(process.env.PERF_SOAK_SECONDS || 0));
const SOAK_INTERVAL_MS = Math.max(0, Number(process.env.PERF_SOAK_INTERVAL_MS || 1000));
const STRESS = process.env.PERF_STRESS === '1';
const LIMITS = {
  create: Number(process.env.PERF_CREATE_P95_MS || 3000),
  list: Number(process.env.PERF_LIST_P95_MS || 1500),
  detail: Number(process.env.PERF_DETAIL_P95_MS || 800),
  stats: Number(process.env.PERF_STATS_P95_MS || 2000),
  upload: Number(process.env.PERF_UPLOAD_P95_MS || 5000),
};
const WORKER_PREFIX = `E2E-PERF-${RUN}`;
const WORKERS = Math.max(1, Number(process.env.PERF_WORKERS || 5));
const SKILL = `perf_${RUN}`;

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
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(name, rows, unit = 'ms') {
  const ok = rows.filter((r) => r.status >= 200 && r.status < 300);
  const lat = ok.map((r) => r.ms);
  const statuses = {};
  for (const r of rows) statuses[r.status] = (statuses[r.status] || 0) + 1;
  const s = {
    name,
    total: rows.length,
    ok: ok.length,
    error_rate: rows.length ? Number((((rows.length - ok.length) / rows.length) * 100).toFixed(2)) : 0,
    p50: Number(percentile(lat, 50).toFixed(1)),
    p95: Number(percentile(lat, 95).toFixed(1)),
    p99: Number(percentile(lat, 99).toFixed(1)),
    max: Number((lat.length ? Math.max(...lat) : 0).toFixed(1)),
    unit,
    statuses,
  };
  console.log(`[perf] ${name}:`, JSON.stringify(s));
  return s;
}

let workersCreated = false;
const createdOrders = [];
const uploaded = [];

async function setup() {
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  const dept = await db.query(`SELECT id FROM dept WHERE tenant_id=$1 AND name='后勤设备科' LIMIT 1`, [TENANT]);
  assert(dept.rowCount === 1, '试点租户缺少 后勤设备科');
  // 多个同技能临时师傅：避免所有并发单锁同一行 worker.load（测试夹具造成的假瓶颈）。
  for (let i = 1; i <= WORKERS; i += 1) {
    await db.query(
      `INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id,department_id)
       VALUES ($1,$2,$3,$4::text[],0,true,NULL,$5)`,
      [`${WORKER_PREFIX}-${i}`, TENANT, `E2E性能${i}`, ['repair', SKILL], dept.rows[0].id],
    );
  }
  workersCreated = true;
  await db.query('COMMIT');
}

async function cleanup() {
  if (createdOrders.length) {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
    for (const table of [
      'ai_conversation', 'ai_shadow_suggestions', 'feedback', 'inventory_log', 'ticket_learn_log',
      'work_acceptance', 'webhook_delivery', 'settlement_item', 'ticket_event', 'notification',
    ]) {
      await db.query(
        `DELETE FROM ${table} WHERE tenant_id=$1 AND work_order_id::text = ANY($2::text[])`,
        [TENANT, createdOrders],
      );
    }
    await db.query(
      `DELETE FROM domain_event WHERE tenant_id=$1 AND entity_type='work_order' AND entity_id = ANY($2::text[])`,
      [TENANT, createdOrders],
    );
    await db.query(
      `DELETE FROM idempotency_key WHERE tenant_id=$1 AND work_order_id::text = ANY($2::text[])`,
      [TENANT, createdOrders],
    );
    await db.query(
      `DELETE FROM work_orders WHERE tenant_id=$1 AND id::text = ANY($2::text[])`,
      [TENANT, createdOrders],
    );
    await db.query('COMMIT');
  }
  for (const url of uploaded) {
    const p = path.join(UPLOAD_DIR, url.replace(/^\/uploads\//, ''));
    try { unlinkSync(p); } catch { /* ignore */ }
  }
  if (workersCreated) {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
    // 必须在同一事务内删 worker：事务外 app.tenant_id 已复位，RLS 会把 DELETE 静默过滤成 0 行。
    await db.query(`DELETE FROM worker WHERE tenant_id=$1 AND id LIKE $2`, [TENANT, `${WORKER_PREFIX}-%`]);
    await db.query('COMMIT');
    workersCreated = false;
  }
}

async function createOne(admin, i) {
  const id = crypto.randomUUID();
  createdOrders.push(id);
  const r = await request('POST', `${API}/open/work_order`, {
    id,
    business_type: 'repair',
    catalog: 'hosp_water',
    title: `性能测试-${i}`,
    description: '自动化性能测试，请忽略',
    location: '后勤设备科',
    reporter_name: 'PERF',
    priority: 'normal',
    skill_tags: [SKILL],
    ext: { perf_run: RUN, perf_index: i },
  }, admin);
  return { ...r, id };
}

async function main() {
  await db.connect();
  await setup();
  const admin = await login(process.env.admin_user || 'admin', process.env.admin_password, 'pc');

  // ===== 1. 并发建单 =====
  const t0 = Date.now();
  const createRows = [];
  let cursor = 0;
  async function workerLoop() {
    while (cursor < CREATE_TOTAL) {
      const i = cursor++;
      try {
        const r = await createOne(admin, i);
        createRows.push(r);
      } catch (e) {
        createRows.push({ status: 0, ms: e.ms || 0, error: e.message, id: null });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, workerLoop));
  const createSummary = summarize('create', createRows);
  const createOk = createRows.filter((r) => r.status >= 200 && r.status < 300);
  assert(createOk.length === CREATE_TOTAL, `建单成功数 ${createOk.length}/${CREATE_TOTAL}`);
  const orderNos = createOk.map((r) => r.body?.order_no).filter(Boolean);
  assert(new Set(orderNos).size === orderNos.length, '建单出现重复工单号');
  const assignees = {};
  for (const r of createOk) {
    const a = r.body?.assignee || '(none)';
    assignees[a] = (assignees[a] || 0) + 1;
  }
  console.log('[perf] assignees', JSON.stringify(assignees));
  if (!STRESS) assert(createSummary.p95 < LIMITS.create, `建单 p95 ${createSummary.p95}ms 超过 ${LIMITS.create}ms`);
  else if (createSummary.p95 >= LIMITS.create) console.warn(`[perf] STRESS: create p95 ${createSummary.p95}ms 超过验收线 ${LIMITS.create}ms（压测仅记录）`);
  console.log(`[perf] create wall=${Date.now() - t0}ms orders=${createOk.length}`);

  const firstId = createOk[0]?.id;

  // 预热读路径，避免首个请求的 JIT/缓存冷启动污染 p95
  await request('GET', `${API}/open/work_orders?limit=100`, undefined, admin);
  await request('GET', `${API}/open/work_order/${firstId}`, undefined, admin);
  await request('GET', `${API}/stats/workbench`, undefined, admin);

  // ===== 2. 列表 =====
  const listRows = [];
  for (let i = 0; i < LIST_ROUNDS; i += 1) {
    const r = await request('GET', `${API}/open/work_orders?limit=100`, undefined, admin);
    listRows.push(r);
  }
  const listSummary = summarize('list(limit=100)', listRows);
  if (!STRESS) assert(listSummary.p95 < LIMITS.list, `列表 p95 ${listSummary.p95}ms 超过 ${LIMITS.list}ms`);
  else if (listSummary.p95 >= LIMITS.list) console.warn(`[perf] STRESS: list p95 ${listSummary.p95}ms 超过验收线 ${LIMITS.list}ms`);

  // ===== 3. 详情 =====
  const detailRows = [];
  for (let i = 0; i < DETAIL_ROUNDS; i += 1) {
    detailRows.push(await request('GET', `${API}/open/work_order/${firstId}`, undefined, admin));
  }
  const detailSummary = summarize('detail', detailRows);
  if (!STRESS) assert(detailSummary.p95 < LIMITS.detail, `详情 p95 ${detailSummary.p95}ms 超过 ${LIMITS.detail}ms`);

  // ===== 4. 工作台 =====
  const statsRows = [];
  for (let i = 0; i < STATS_ROUNDS; i += 1) {
    statsRows.push(await request('GET', `${API}/stats/workbench`, undefined, admin));
  }
  const statsSummary = summarize('workbench', statsRows);
  if (!STRESS) assert(statsSummary.p95 < LIMITS.stats, `工作台 p95 ${statsSummary.p95}ms 超过 ${LIMITS.stats}ms`);

  // ===== 5. 并发上传 =====
  let uploadSummary = null;
  if (UPLOAD_TOTAL > 0) {
    const uploadRows = [];
    for (let i = 0; i < UPLOAD_TOTAL; i += 1) {
      const base64 = crypto.randomBytes(1024 * 1024).toString('base64');
      const r = await request('POST', `${API}/public/upload?org=${TENANT}`, {
        filename: `perf-${i}.jpg`, contentType: 'image/jpeg', base64,
      });
      if (r.status === 201 && r.body?.url) uploaded.push(r.body.url);
      uploadRows.push(r);
    }
    uploadSummary = summarize('upload(1MB)', uploadRows);
    assert(uploadSummary.ok === UPLOAD_TOTAL, `上传成功数 ${uploadSummary.ok}/${UPLOAD_TOTAL}`);
    if (!STRESS) assert(uploadSummary.p95 < LIMITS.upload, `上传 p95 ${uploadSummary.p95}ms 超过 ${LIMITS.upload}ms`);
  }

  // ===== 6. soak（可选）=====
  let soakSummary = null;
  if (SOAK_SECONDS > 0) {
    const end = Date.now() + SOAK_SECONDS * 1000;
    const soakRows = [];
    let loops = 0;
    while (Date.now() < end) {
      const r = await request('GET', `${API}/open/work_orders?limit=100`, undefined, admin);
      soakRows.push(r);
      loops += 1;
      if (loops % 60 === 0) {
        const errs = soakRows.filter((x) => x.status < 200 || x.status >= 300).length;
        console.log(`[perf] soak progress loops=${loops} errors=${errs} remaining=${Math.max(0, Math.round((end - Date.now()) / 1000))}s`);
      }
      if (SOAK_INTERVAL_MS > 0) await new Promise((resolve) => setTimeout(resolve, SOAK_INTERVAL_MS));
    }
    soakSummary = summarize(`soak(${SOAK_SECONDS}s @${SOAK_INTERVAL_MS}ms)`, soakRows);
  }

  console.log('[perf] SUMMARY', JSON.stringify({
    run: RUN,
    create: createSummary,
    list: listSummary,
    detail: detailSummary,
    stats: statsSummary,
    upload: uploadSummary,
    soak: soakSummary,
  }, null, 2));
  console.log(`[perf] PASS run=${RUN} orders=${createOk.length}`);
}

main()
  .then(async () => { await cleanup(); await db.end(); process.exit(0); })
  .catch(async (e) => {
    console.error('[perf] FAILED', e.message);
    await cleanup().catch(() => {});
    try { await db.end(); } catch { /* ignore */ }
    process.exit(1);
  });
