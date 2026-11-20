// 隔离租户校验 /open/me/summary 的 today_done：今天完成 1、3 天前完成 1。
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

async function main() {
  await db.connect();
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  await db.query(`INSERT INTO tenant_registry (tenant_id,name,status,category) VALUES ($1,'今日完成验收租户','active','other')`, [TENANT]);
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
  const orderCols = `(id, tenant_id, order_no, status, assignee_id, department_id, title, business_type, priority, source, created_at, updated_at, completed_at)`;
  await db.query(
    `INSERT INTO work_orders ${orderCols}
     VALUES ($1,$2,'STAT-TODAY','completed',$3,$4,'今天完成','repair','normal','public_report',now() - interval '2 days',now(),now())`,
    [crypto.randomUUID(), TENANT, workerId, dept.rows[0].id],
  );
  await db.query(
    `INSERT INTO work_orders ${orderCols}
     VALUES ($1,$2,'STAT-OLD','completed',$3,$4,'三天前完成','repair','normal','public_report',now() - interval '5 days',now() - interval '3 days',now() - interval '3 days')`,
    [crypto.randomUUID(), TENANT, workerId, dept.rows[0].id],
  );
  await db.query('COMMIT');

  const login = await req('POST', '/auth/login', { username: 'stats_worker', password: PASS, tenant: TENANT, channel: 'mp' });
  if (login.status !== 200 || !login.body?.token) throw new Error(`login ${login.status} ${JSON.stringify(login.body).slice(0, 200)}`);
  const summary = await req('GET', '/open/me/summary', undefined, login.body.token);
  if (summary.status !== 200) throw new Error(`summary ${summary.status}`);
  const s = summary.body.stats;
  console.log('API', JSON.stringify({ done: s.done_count, today_done: s.today_done, today_new: s.today_new }));
  const ok = Number(s.done_count) === 2 && Number(s.today_done) === 1;
  console.log(ok ? 'PASS today_done=1, done_count=2' : 'FAIL unexpected stats');
  await cleanup();
  await db.end();
  process.exit(ok ? 0 : 1);
}

main().catch(async (e) => {
  console.error('FATAL', e.message);
  try { await cleanup(); } catch {}
  process.exit(1);
});
