// 隔离租户校验 /open/me/summary：四类任务全覆盖 + 今日完成只按业务完成时间算本地日。
//
// 每个类型造 4 条：
//   - 1 条在办（created_at=今天）
//   - 1 条今天成功完成（created_at=今天）
//   - 1 条 3 天前成功完成，但 updated_at 被改成今天（负控制：不能拿 updated_at 算完成日）
//   - 1 条 3 天前已取消/异常，但 updated_at 也被改成今天（负控制：终态不能计入 today_done）
// 预期：active=4，done=12，today_done=4，today_new=8。
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

for (const f of [process.env.ENV_FILE || '.env']) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { Client } = pg;
const RUN = (process.env.E2E_RUN_ID || `td${Date.now().toString(36)}`).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
const TENANT = `uat-stats-${RUN}`;
const PASS = 'Stats!2026';
const BASE = 'http://127.0.0.1:4101/api/v1';
const DBNAME = process.env.PGDATABASE || 'youfu_pilot';

function req(method, path, body, token) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const r = http.request(new URL(BASE + path), {
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
    r.on('error', (e) => resolve({ status: 0, body: { error: e.message } }));
    if (data) r.write(data);
    r.end();
  });
}

function hashPassword(p) {
  const s = crypto.randomBytes(16);
  return `scrypt$${s.toString('hex')}$${crypto.scryptSync(p, s, 64).toString('hex')}`;
}

const db = new Client({
  host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 5432),
  database: DBNAME, user: process.env.PGUSER || 'youfu_app', password: process.env.PGPASSWORD,
});

async function cleanup() {
  try {
    const sql = `
BEGIN;
SET LOCAL session_replication_role = replica;
DO $$ DECLARE r record; BEGIN
FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id'
LOOP EXECUTE format('DELETE FROM %I WHERE tenant_id=$1', r.table_name) USING '${TENANT}'; END LOOP; END $$;
COMMIT;`;
    execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', DBNAME, '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' });
    console.log('[stats-audit] cleaned', TENANT);
  } catch (e) { console.error('[stats-audit] cleanup failed', e.message); }
}

async function insertWorkOrderDef() {
  // 默认 4 态模板没有 cancelled；这里显式给验收租户一个含取消边的 def，
  // 才能验证 done_count 是“全部终态”、today_done 只认成功完成态。
  const def = {
    initial: 'draft',
    states: ['draft', 'assigned', 'processing', 'completed', 'cancelled'],
    transitions: [
      { from: 'draft', to: 'assigned', event: 'assign' },
      { from: 'assigned', to: 'processing', event: 'start' },
      { from: 'processing', to: 'completed', event: 'complete' },
      { from: 'processing', to: 'cancelled', event: 'cancel' },
    ],
    config: { doneStates: ['completed'] },
  };
  await db.query(
    `INSERT INTO workflow_def (tenant_id, entity_type, def, version) VALUES ($1,'work_order',$2::jsonb,1)`,
    [TENANT, JSON.stringify(def)],
  );
}

async function insertWorkOrders(workerId, deptId) {
  const cols = '(id, tenant_id, order_no, status, assignee_id, department_id, title, business_type, priority, source, created_at, updated_at, completed_at, def_version)';
  await db.query(
    `INSERT INTO work_orders ${cols} VALUES
       ($1,$2,$3,'processing',$4,$5,'维修在办','repair','normal','public_report',now() - interval '1 hour',now(),NULL,1),
       ($6,$2,$7,'completed',$4,$5,'维修今天完成','repair','normal','public_report',now() - interval '1 hour',now(),now(),1),
       ($8,$2,$9,'completed',$4,$5,'维修三天前完成','repair','normal','public_report',now() - interval '5 days',now(),now() - interval '3 days',1),
       ($10,$2,$11,'cancelled',$4,$5,'维修已取消','repair','normal','public_report',now() - interval '5 days',now(),NULL,1)`,
    [
      crypto.randomUUID(), TENANT, `WO-${RUN}-ACTIVE`, workerId, deptId,
      crypto.randomUUID(), `WO-${RUN}-TODAY`,
      crypto.randomUUID(), `WO-${RUN}-OLD`,
      crypto.randomUUID(), `WO-${RUN}-CANCEL`,
    ],
  );
}

async function insertInspectionTasks(workerId) {
  const cols = '(id, tenant_id, title, assignee, status, created_at, updated_at, done_at)';
  await db.query(
    `INSERT INTO inspection_task ${cols} VALUES
       ($1,$2,'巡检在办',$3,'pending',now() - interval '1 hour',now(),NULL),
       ($4,$2,'巡检今天完成',$3,'done',now() - interval '1 hour',now(),now()),
       ($5,$2,'巡检三天前完成',$3,'done',now() - interval '5 days',now(),now() - interval '3 days'),
       ($6,$2,'巡检异常',$3,'exception',now() - interval '5 days',now(),NULL)`,
    [
      crypto.randomUUID(), TENANT, workerId,
      crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(),
    ],
  );
}

async function insertTransportOrders(workerId) {
  const cols = '(id, tenant_id, code, item_name, carrier, status, created_at, updated_at, arrive_at, sign_at)';
  await db.query(
    `INSERT INTO transport_order ${cols} VALUES
       ($1,$2,$3,'运送在办',$4,'assigned',now() - interval '1 hour',now(),NULL,NULL),
       ($5,$2,$6,'运送今天完成',$4,'done',now() - interval '1 hour',now(),now(),now()),
       ($7,$2,$8,'运送三天前完成',$4,'done',now() - interval '5 days',now(),now() - interval '3 days',now() - interval '3 days'),
       ($9,$2,$10,'运送已取消',$4,'cancelled',now() - interval '5 days',now(),NULL,NULL)`,
    [
      crypto.randomUUID(), TENANT, `TR-${RUN}-ACTIVE`, workerId,
      crypto.randomUUID(), `TR-${RUN}-TODAY`,
      crypto.randomUUID(), `TR-${RUN}-OLD`,
      crypto.randomUUID(), `TR-${RUN}-CANCEL`,
    ],
  );
}

async function insertEnergyTasks(workerId) {
  const workerRef = `youfu:${workerId}`;
  const insert = `INSERT INTO business_flow_tasks
      (id, tenant_id, entity_type, title, status, data, assignee, created_at, updated_at)
    VALUES ($1,$2,'energy_collection',$3,$4,$5::jsonb,$6,$7,$8)`;
  const rows = [
    ['能耗在办', 'dispatched', { worker_ref: workerRef, task_ref: `${RUN}-EN-ACTIVE` }, hourAgo(), now(0)],
    ['能耗今天提交', 'submitted', { worker_ref: workerRef, task_ref: `${RUN}-EN-TODAY`, submitted_at: iso(0) }, hourAgo(), now(0)],
    ['能耗三天前归档', 'archived', { worker_ref: workerRef, task_ref: `${RUN}-EN-OLD`, submitted_at: iso(-3) }, now(-5), now(0)],
    ['能耗已取消', 'cancelled', { worker_ref: workerRef, task_ref: `${RUN}-EN-CANCEL` }, now(-5), now(0)],
  ];
  for (const [title, status, data, created, updated] of rows) {
    await db.query(insert, [crypto.randomUUID(), TENANT, title, status, JSON.stringify(data), workerId, created, updated]);
  }
}

function iso(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

function now(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

function hourAgo() {
  return new Date(Date.now() - 3600000).toISOString();
}

async function main() {
  await db.connect();
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  await db.query(`INSERT INTO tenant_registry (tenant_id,name,status,category) VALUES ($1,'四类任务统计验收租户','active','other')`, [TENANT]);
  const dept = await db.query(`INSERT INTO dept (tenant_id,name,code,is_default,enabled) VALUES ($1,'统计验收科','STAT',true,true) RETURNING id`, [TENANT]);
  const acc = await db.query(
    `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
     VALUES ($1,'stats_worker',$2,'统计师傅','worker',true) RETURNING id`,
    [TENANT, hashPassword(PASS)],
  );
  const workerId = acc.rows[0].id;
  await db.query(
    `INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id,department_id)
     VALUES ($1,$2,'统计师傅','{}'::text[],0,true,$1,$3)`,
    [workerId, TENANT, dept.rows[0].id],
  );
  await insertWorkOrderDef();
  await insertWorkOrders(workerId, dept.rows[0].id);
  await insertInspectionTasks(workerId);
  await insertTransportOrders(workerId);
  await insertEnergyTasks(workerId);
  await db.query('COMMIT');

  const login = await req('POST', '/auth/login', { username: 'stats_worker', password: PASS, tenant: TENANT, channel: 'mp' });
  if (login.status !== 200 || !login.body?.token) throw new Error(`login ${login.status} ${JSON.stringify(login.body).slice(0, 200)}`);
  const summary = await req('GET', '/open/me/summary', undefined, login.body.token);
  if (summary.status !== 200) throw new Error(`summary ${summary.status} ${JSON.stringify(summary.body).slice(0, 300)}`);
  const s = summary.body.stats;
  const by = summary.body.stats_by_type || {};
  console.log('API total', JSON.stringify(s));
  for (const key of ['work_order', 'inspection_task', 'transport_task', 'energy_task']) {
    console.log('API', key, JSON.stringify(by[key]));
  }

  const expectedType = { active_count: 1, done_count: 3, today_done: 1, today_new: 2 };
  const expectedTotal = { active_count: 4, done_count: 12, today_done: 4, today_new: 8 };
  const check = (actual, expected) =>
    Object.keys(expected).every((k) => Number(actual?.[k]) === expected[k]);
  let ok = check(s, expectedTotal);
  for (const key of ['work_order', 'inspection_task', 'transport_task', 'energy_task']) {
    if (!check(by[key], expectedType)) ok = false;
  }
  console.log(ok ? 'PASS 四类任务 active=4 done=12 today_done=4 today_new=8' : 'FAIL unexpected stats');
  await cleanup();
  await db.end();
  process.exit(ok ? 0 : 1);
}

main().catch(async (e) => {
  console.error('FATAL', e.message);
  try { await cleanup(); } catch {}
  process.exit(1);
});
