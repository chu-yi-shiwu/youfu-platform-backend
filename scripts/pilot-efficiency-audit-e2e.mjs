// 方向 C 效率与提醒 · 线上审计（隔离 UAT 租户）
// 覆盖：催办（含 30 分钟限频、终态拒绝、通知）、通知单条已读、低库存阈值与汇总、统计后端聚合。
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
const RUN = `ef${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const TENANT = `uat-eff-${RUN}`;
const PASS = 'Eff!2026';

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
function record(name, status, note) { results.push({ name, status, note }); console.log(`[eff] ${status} ${name}${note ? ' — ' + note : ''}`); }

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
  await db.query(`INSERT INTO tenant_registry (tenant_id,name,status) VALUES ($1,'Eff UAT','active')`, [TENANT]);
  await db.query(`INSERT INTO dept (tenant_id,name,code,is_default) VALUES ($1,'后勤部','EF-DEPT',true)`, [TENANT]);
  const admin = await db.query(`INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active) VALUES ($1,'eff_admin',$2,'效率管理员','admin',true) RETURNING id`, [TENANT, hash(PASS)]);
  const wacc = await db.query(`INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active) VALUES ($1,'eff_worker',$2,'维修工','worker',true) RETURNING id`, [TENANT, hash(PASS)]);
  const worker = await db.query(`INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id) VALUES ($1,$2,'维修工','{"repair"}'::text[],0,true,$3) RETURNING id`, [`EW-${RUN}`, TENANT, wacc.rows[0].id]);
  await db.query('COMMIT');

  const now = Math.floor(Date.now() / 1000);
  const adminToken = signJwt({ sub: admin.rows[0].id, tid: TENANT, role: 'admin', username: 'eff_admin', tv: 0, iat: now, exp: now + 3600 }, process.env.JWT_SECRET);
  const workerToken = signJwt({ sub: wacc.rows[0].id, tid: TENANT, role: 'worker', username: 'eff_worker', tv: 0, iat: now, exp: now + 3600 }, process.env.JWT_SECRET);
  const workerId = worker.rows[0].id;

  // ===== 催办 =====
  const wo = await request('POST', '/open/work_order', {
    id: crypto.randomUUID(),
    title: '催办审计工单', description: '空调不制冷', business_type: 'repair', catalog: 'repair',
  }, adminToken);
  assert(wo.status === 201 || wo.status === 200, `建单 ${wo.status} ${JSON.stringify(wo.body)}`);
  const woId = wo.body.id;
  // 夹具：固定处理人，确保催办通知可验证
  await sql(`UPDATE work_orders SET assignee_id=$3 WHERE tenant_id=$1 AND id=$2`, [TENANT, woId, workerId]);

  const urge1 = await request('POST', `/open/work_order/${woId}/urge`, {}, adminToken);
  record('催办：管理员催办 200', urge1.status === 200 ? 'PASS' : `HTTP ${urge1.status} ${JSON.stringify(urge1.body)}`);
  const urge2 = await request('POST', `/open/work_order/${woId}/urge`, {}, adminToken);
  record('催办：30 分钟内重复 → 429', urge2.status === 429 && urge2.body.code === 'URGE_TOO_FREQUENT' ? 'PASS' : `HTTP ${urge2.status}`);
  const notify = await request('GET', '/open/notifications', undefined, workerToken);
  const urgeNotif = (notify.body.items || []).find((n) => n.type === 'urge');
  record('催办：处理人收到站内信', notify.status === 200 && !!urgeNotif ? 'PASS' : `HTTP ${notify.status} items=${(notify.body.items || []).length}`);
  if (urgeNotif) {
    const read = await request('POST', '/open/notifications/read', { ids: [urgeNotif.id] }, workerToken);
    record('通知：单条已读（ids 路径）', read.status === 200 && Number(read.body.marked) === 1 ? 'PASS' : `HTTP ${read.status} marked=${read.body.marked}`);
  }
  await sql(`UPDATE work_orders SET status='completed' WHERE tenant_id=$1 AND id=$2`, [TENANT, woId]);
  const urgeDone = await request('POST', `/open/work_order/${woId}/urge`, {}, adminToken);
  record('催办：终态工单 → 409', urgeDone.status === 409 ? 'PASS' : `HTTP ${urgeDone.status}`);

  // ===== 低库存 =====
  const mat = await request('POST', '/materials', { code: `E-${RUN}`, name: '审计耗材', unit: '个', price: 1 }, adminToken);
  assert(mat.status === 201, `建耗材 ${mat.status}`);
  const mid = mat.body.item.id;
  await request('POST', '/inventory/in', { material_id: mid, warehouse: '中心库', qty: 5 }, adminToken);
  const threshold = await request('PUT', '/inventory/threshold', { material_id: mid, warehouse: '中心库', min_qty: 4 }, adminToken);
  record('低库存：设置阈值 200', threshold.status === 200 && Number(threshold.body.item?.min_qty) === 4 ? 'PASS' : `HTTP ${threshold.status}`);
  await request('POST', '/inventory/out', { material_id: mid, warehouse: '中心库', qty: 2 }, adminToken);
  const lowList = await request('GET', '/inventory?low=1', undefined, adminToken);
  const lowSummary = await request('GET', '/inventory/summary', undefined, adminToken);
  record('低库存：低于阈值进入 low=1 列表', lowList.status === 200 && (lowList.body.items || []).some((x) => x.material_id === mid) ? 'PASS' : `HTTP ${lowList.status}`);
  record('低库存：汇总 low_count ≥ 1', lowSummary.status === 200 && Number(lowSummary.body.summary?.low_count) >= 1 ? 'PASS' : `low_count=${lowSummary.body.summary?.low_count}`);

  // ===== 统计聚合 =====
  const stats = await request('GET', '/stats', undefined, adminToken);
  const catalogDist = stats.body.catalog_distribution || [];
  record('统计：catalog_distribution 后端返回', stats.status === 200 && Array.isArray(catalogDist) && catalogDist.some((x) => x.key === 'repair') ? 'PASS' : `HTTP ${stats.status} dist=${JSON.stringify(catalogDist)}`);
  record('统计：分布总数不超过 total', stats.status === 200 && catalogDist.reduce((s, x) => s + Number(x.count), 0) <= Number(stats.body.total) ? 'PASS' : `sum/total mismatch`);

  const fails = results.filter((r) => r.status !== 'PASS');
  console.log('[eff] SUMMARY', JSON.stringify(results, null, 2));
  console.log(fails.length ? `[eff] GAPS=${fails.length}` : '[eff] NO_GAPS');
  await db.end();
}

try {
  await main();
} finally {
  await cleanup();
  console.log('[eff] cleaned', TENANT);
}
