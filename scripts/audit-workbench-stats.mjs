// 只读对账：/open/me/summary 的统计口径 vs 数据库按用户可见规则独立计算。
//
// 为什么需要：
//   单元测试能证明 SQL 里写了哪些字段，但不能证明真实租户数据下“工作台数字”
//   与“我的任务列表”看到的状态分类一致。这个脚本用真实 worker 的 JWT 调 summary，
//   再按小程序同一套终态/完成时间规则从数据库独立计数，发现差异直接非 0 退出。
//
// 这是只读脚本：不写业务表，不改状态，不创建租户。
//
// 运行示例：
//   ENV_FILE=.env AUDIT_TENANT=zixing-hospital API_BASE=http://127.0.0.1:4001/api/v1 \
//     node scripts/audit-workbench-stats.mjs
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';

for (const f of [process.env.ENV_FILE || '.env']) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const TENANT = process.env.AUDIT_TENANT || 'zixing-hospital';
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:4001/api/v1';
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('[workbench-audit] SKIP JWT_SECRET missing');
  process.exit(0);
}

const TERMINAL = new Set(['completed', 'cancelled', 'done', 'closed', 'evaluated', 'exception']);
const SUCCESS = new Set(['completed', 'closed', 'evaluated', 'done', 'submitted', 'reviewed', 'archived']);
const INSPECTION_SUCCESS = new Set(['done']);
const TRANSPORT_SUCCESS = new Set(['done']);
const ENERGY_SUCCESS = new Set(['submitted', 'reviewed', 'archived']);

function b64url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function signWorkerJwt(accountId) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    tid: TENANT, sub: accountId, role: 'worker', iat: now, exp: now + 600,
  }));
  const body = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(body).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${body}.${sig}`;
}

function request(path, token) {
  return new Promise((resolve, reject) => {
    const r = http.request(new URL(API_BASE + path), {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = raw ? JSON.parse(raw) : null; } catch { body = { raw }; }
        resolve({ status: res.statusCode, body });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

function localDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d);
}

function completionTime(type, row) {
  if (type === 'energy_task') return (row.data && row.data.submitted_at) || row.updated_at || row.created_at;
  if (type === 'transport_task') return row.sign_at || row.arrive_at || row.updated_at || row.created_at;
  if (type === 'inspection_task') return row.done_at || row.updated_at || row.created_at;
  return row.completed_at || row.rated_at || row.updated_at || row.created_at;
}

function successSet(type) {
  if (type === 'inspection_task') return INSPECTION_SUCCESS;
  if (type === 'transport_task') return TRANSPORT_SUCCESS;
  if (type === 'energy_task') return ENERGY_SUCCESS;
  return SUCCESS;
}

function counts(type, rows, today) {
  let active = 0;
  let done = 0;
  let todayDone = 0;
  let todayNew = 0;
  const unknown = new Set();
  for (const row of rows) {
    const terminal = TERMINAL.has(row.status);
    if (!terminal) active += 1;
    if (terminal) done += 1;
    if (terminal && successSet(type).has(row.status) && localDate(completionTime(type, row)) === today) todayDone += 1;
    if (localDate(row.created_at) === today) todayNew += 1;
    if (!terminal && type === 'work_order' && !['draft', 'pending', 'pending_dispatch', 'claim_hall', 'assigned', 'arrived', 'processing', 'paused', 'suspended', 'pending_review', 'review_passed'].includes(row.status)) {
      unknown.add(row.status);
    }
  }
  return { active_count: active, done_count: done, today_done: todayDone, today_new: todayNew, unknown: [...unknown] };
}

function add(a, b) {
  return {
    active_count: a.active_count + b.active_count,
    done_count: a.done_count + b.done_count,
    today_done: a.today_done + b.today_done,
    today_new: a.today_new + b.today_new,
  };
}

const db = new pg.Client({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'youfu',
  user: process.env.PGUSER || 'youfu_app',
  password: process.env.PGPASSWORD,
});

await db.connect();
await db.query('BEGIN');
await db.query("SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)", [TENANT]);

const candidate = await db.query(
  `SELECT w.id, w.account_id
     FROM worker w
    WHERE w.tenant_id = $1
      AND w.active = true
      AND w.account_id IS NOT NULL
    ORDER BY (
      (SELECT COUNT(*) FROM work_orders wo WHERE wo.tenant_id = w.tenant_id AND wo.assignee_id = w.id)
      + (SELECT COUNT(*) FROM inspection_task it WHERE it.tenant_id = w.tenant_id AND it.assignee = w.id)
      + (SELECT COUNT(*) FROM transport_order tr WHERE tr.tenant_id = w.tenant_id AND tr.carrier = w.id)
      + (SELECT COUNT(*) FROM business_flow_tasks bf
          WHERE bf.tenant_id = w.tenant_id AND bf.entity_type = 'energy_collection'
            AND (bf.data->>'worker_ref' = 'youfu:' || w.id OR bf.assignee = w.id))
    ) DESC, w.id
    LIMIT 1`,
  [TENANT],
);
if (candidate.rowCount === 0) {
  console.log(`[workbench-audit] SKIP tenant ${TENANT} has no active worker with account_id`);
  await db.end();
  process.exit(0);
}
const worker = candidate.rows[0];

// 同一个 pg client 顺序执行，避免并发查询在单连接上排队造成调试噪声。
const wo = await db.query('SELECT status, created_at, completed_at, rated_at, updated_at FROM work_orders WHERE tenant_id=$1 AND assignee_id=$2', [TENANT, worker.id]);
const insp = await db.query('SELECT status, created_at, done_at, updated_at FROM inspection_task WHERE tenant_id=$1 AND assignee=$2', [TENANT, worker.id]);
const tr = await db.query('SELECT status, created_at, sign_at, arrive_at, updated_at FROM transport_order WHERE tenant_id=$1 AND carrier=$2', [TENANT, worker.id]);
const energy = await db.query(
  `SELECT status, created_at, updated_at, data
     FROM business_flow_tasks
    WHERE tenant_id=$1 AND entity_type='energy_collection'
      AND (data->>'worker_ref' = $2 OR assignee = $3)`,
  [TENANT, `youfu:${worker.id}`, worker.id],
);

const today = localDate(new Date().toISOString());
const expectedByType = {
  work_order: counts('work_order', wo.rows, today),
  inspection_task: counts('inspection_task', insp.rows, today),
  transport_task: counts('transport_task', tr.rows, today),
  energy_task: counts('energy_task', energy.rows, today),
};
const expectedTotal = Object.values(expectedByType).reduce(
  (acc, c) => add(acc, c),
  { active_count: 0, done_count: 0, today_done: 0, today_new: 0 },
);
const unknown = Object.entries(expectedByType).flatMap(([type, c]) => c.unknown.map((s) => `${type}:${s}`));

const token = signWorkerJwt(worker.account_id);
const summary = await request('/open/me/summary', token);
if (summary.status !== 200 || !summary.body?.stats) {
  console.error(`[workbench-audit] FAIL summary HTTP ${summary.status}: ${JSON.stringify(summary.body).slice(0, 200)}`);
  await db.end();
  process.exit(1);
}

const actualTotal = summary.body.stats;
const actualByType = summary.body.stats_by_type || {};
const same = (a, b) => ['active_count', 'done_count', 'today_done', 'today_new'].every((k) => Number(a?.[k] ?? 0) === Number(b[k] ?? 0));
const problems = [];
if (!same(actualTotal, expectedTotal)) problems.push({ scope: 'total', actual: actualTotal, expected: expectedTotal });
for (const type of Object.keys(expectedByType)) {
  if (!same(actualByType[type], expectedByType[type])) {
    problems.push({ scope: type, actual: actualByType[type], expected: expectedByType[type] });
  }
}
if (unknown.length > 0) problems.push({ scope: 'unknown_status', actual: unknown, expected: [] });

console.log(`[workbench-audit] tenant=${TENANT} worker=${worker.id} account=${worker.account_id}`);
console.log('[workbench-audit] API', JSON.stringify(actualTotal));
console.log('[workbench-audit] DB ', JSON.stringify(expectedTotal));
if (problems.length > 0) {
  console.error('[workbench-audit] FAIL');
  for (const p of problems) console.error(JSON.stringify(p));
  await db.end();
  process.exit(1);
}
console.log('[workbench-audit] PASS summary 与数据库独立计数一致');
await db.query('ROLLBACK');
await db.end();
