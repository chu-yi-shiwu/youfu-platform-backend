// Round 3 · 故障注入与边界（X1/X2/X5/X10/X11/X12 等）
// 独立 UAT 租户，结束后清理。
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { signJwt } from '../dist/middleware/auth.js';

const { Client } = pg;
const BASE = (process.env.PILOT_API_BASE || 'http://127.0.0.1:4101/api/v1').replace(/\/+$/, '');
const UPLOAD_ROOT = process.env.UPLOAD_DIR || '/opt/youfu/pilot/uploads';
const RUN = process.env.E2E_RUN_ID || `r3e${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const TENANT = `uat-r3edge-${RUN}`;
const PASS = 'Round3!2026';
const SKILL = `r3_edge_${RUN}`;
const CAT = `R3Edge-${RUN}`;

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

function hashPassword(p) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(p, salt, 64).toString('hex')}`;
}

function request(method, p, body, token, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const u = new URL(p.startsWith('http') ? p : BASE + p);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { raw }; }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); };
const ok = (r, m) => assert(r.status >= 200 && r.status < 300, `${m}（${r.status} ${JSON.stringify(r.body)}）`);
const eq = (a, b, m) => assert(a === b, `${m}（期望 ${b}，实际 ${a}）`);

function token(sub, role, username) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ sub, tid: TENANT, role, username, tv: 0, iat: now, exp: now + 3600 }, process.env.JWT_SECRET);
}

let adminToken, workerToken, workerId;
const findings = [];

async function setup() {
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id','zixing-hospital',true), set_config('app.scope','system',true)`);
  const src = await db.query(
    `SELECT def,version FROM workflow_def WHERE tenant_id='zixing-hospital' AND entity_type='work_order' ORDER BY version DESC LIMIT 1`,
  );
  await db.query('COMMIT');
  assert(src.rowCount === 1, '缺少源 workflow_def');

  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  await db.query(`INSERT INTO tenant_registry (tenant_id,name,status) VALUES ($1,$2,'active')`, [TENANT, `R3 Edge ${RUN}`]);
  const dept = await db.query(
    `INSERT INTO dept (tenant_id,name,code,is_default) VALUES ($1,'R3Edge部',$2,true) RETURNING id`,
    [TENANT, `R3E-${RUN}`],
  );
  const admin = await db.query(
    `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
     VALUES ($1,'r3e_admin',$2,'R3E管理员','admin',true) RETURNING id`,
    [TENANT, hashPassword(PASS)],
  );
  const wa = await db.query(
    `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
     VALUES ($1,'r3e_worker',$2,'R3E师傅','worker',true) RETURNING id`,
    [TENANT, hashPassword(PASS)],
  );
  workerId = `R3E-${RUN}`;
  await db.query(
    `INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id,department_id)
     VALUES ($1,$2,'R3E师傅',$3::text[],0,true,$4,$5)`,
    [workerId, TENANT, ['repair', SKILL], wa.rows[0].id, dept.rows[0].id],
  );
  await db.query(
    `INSERT INTO fault_category (tenant_id,code,name,business_type,skill_tags,sort,enabled)
     VALUES ($1,$2,$3,'repair',$4::jsonb,1,true)`,
    [TENANT, `r3e_cat_${RUN}`, CAT, JSON.stringify(['repair', SKILL])],
  );
  await db.query(`INSERT INTO location_dict (tenant_id,code,name,category,enabled) VALUES ($1,'R3E','R3E-1F','位置',true)`, [TENANT]);
  await db.query(
    `INSERT INTO workflow_def (tenant_id,entity_type,def,version,updated_by) VALUES ($1,'work_order',$2::jsonb,$3,'r3e')`,
    [TENANT, JSON.stringify(src.rows[0].def), src.rows[0].version],
  );
  await db.query('COMMIT');
  adminToken = token(admin.rows[0].id, 'admin', 'r3e_admin');
  workerToken = token(wa.rows[0].id, 'worker', 'r3e_worker');
}

async function cleanup() {
  const sql = `
BEGIN;
SET LOCAL session_replication_role = replica;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns
           WHERE table_schema='public' AND column_name='tenant_id'
  LOOP
    EXECUTE format('DELETE FROM %I WHERE tenant_id=$1', r.table_name) USING '${TENANT}';
  END LOOP;
END $$;
COMMIT;`;
  execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', process.env.PGDATABASE || 'youfu_pilot', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' });
  rmSync(path.join(UPLOAD_ROOT, TENANT), { recursive: true, force: true });
}

async function main() {
  await db.connect();
  await setup();

  // X11 分页边界
  for (const q of ['limit=0', 'limit=-1', 'offset=-1', 'limit=10000', 'offset=999999']) {
    const r = await request('GET', `/open/work_orders?${q}`, undefined, adminToken);
    assert(r.status !== 500, `分页 ${q} 不应 500（实际 ${r.status}）`);
    if (r.status !== 200) findings.push({ id: 'X11', note: `${q} -> ${r.status}`, severity: 'P3' });
  }

  // D-11 负控制：非法 UUID 必须 422，不能 500
  const badIds = await request('POST', '/open/notifications/read', { ids: ['not-a-uuid'] }, workerToken);
  eq(badIds.status, 422, '非法通知 ID 应 422');
  assert(badIds.status !== 500, '非法通知 ID 不得 500');

  // X1 公开报修幂等：同一 Idempotency-Key 两次只建一单
  const idemKey = `r3e-${RUN}-public`;
  const first = await request('POST', '/public/repair-report', {
    org: TENANT, name: 'R3E', phone: '13800000004', location: 'R3E-1F',
    description: 'R3E 幂等报修', category_name: CAT, consent: true,
  }, undefined, { 'Idempotency-Key': idemKey });
  const second = await request('POST', '/public/repair-report', {
    org: TENANT, name: 'R3E', phone: '13800000004', location: 'R3E-1F',
    description: 'R3E 幂等报修', category_name: CAT, consent: true,
  }, undefined, { 'Idempotency-Key': idemKey });
  ok(first, '首次公开报修');
  ok(second, '重复公开报修');
  eq(first.body.order_no, second.body.order_no, '重复提交应返回同一工单');
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  const cnt = await db.query(`SELECT count(*)::int c FROM work_orders WHERE tenant_id=$1 AND order_no=$2`, [TENANT, first.body.order_no]);
  await db.query('COMMIT');
  eq(cnt.rows[0].c, 1, '幂等提交只应落 1 单');

  // X1 建单幂等：同一 id 重复 POST
  const orderId = crypto.randomUUID();
  const c1 = await request('POST', '/open/work_order', {
    id: orderId, business_type: 'repair', catalog: `r3e_cat_${RUN}`,
    title: 'R3E 幂等建单', description: 'R3E', location: 'R3E-1F', priority: 'normal', skill_tags: [SKILL],
  }, adminToken);
  const c2 = await request('POST', '/open/work_order', {
    id: orderId, business_type: 'repair', catalog: `r3e_cat_${RUN}`,
    title: 'R3E 幂等建单', description: 'R3E', location: 'R3E-1F', priority: 'normal', skill_tags: [SKILL],
  }, adminToken);
  assert([200, 201].includes(c1.status), `首次建单 ${c1.status}`);
  assert(c2.status !== 500, '重复建单不得 500');
  findings.push({ id: 'X1', note: `重复建单 -> ${c2.status}`, severity: c2.status === 409 || c2.status === 200 ? 'P3' : 'P2' });

  // X12 超长/emoji/HTML：不得 500
  const longTitle = 'R3E ' + '😀'.repeat(20) + ' <script>alert(1)</script> ' + '长'.repeat(2000);
  const long = await request('POST', '/open/work_order', {
    id: crypto.randomUUID(), business_type: 'repair', catalog: `r3e_cat_${RUN}`,
    title: longTitle, description: longTitle, location: 'R3E-1F', priority: 'normal', skill_tags: [SKILL],
  }, adminToken);
  assert(long.status !== 500, '超长/HTML 建单不得 500');
  findings.push({ id: 'X12', note: `超长/HTML 建单 -> ${long.status}`, severity: 'P3' });

  // X10 唯一约束：重复耗材 code
  const mat1 = await request('POST', '/materials', { code: `R3E-M-${RUN}`, name: 'R3E耗材', unit: '个', price: 1, enabled: true }, adminToken);
  const mat2 = await request('POST', '/materials', { code: `R3E-M-${RUN}`, name: 'R3E耗材2', unit: '个', price: 1, enabled: true }, adminToken);
  ok(mat1, '首次建耗材');
  assert([409, 422, 400].includes(mat2.status), `重复耗材 code 应 4xx，实际 ${mat2.status} ${JSON.stringify(mat2.body)}`);

  // X2 并发编辑资产：观察是否有乐观锁
  const asset = await request('POST', '/assets', { name: 'R3E资产', location: 'R3E-1F', status: 'in_use' }, adminToken);
  ok(asset, '建资产');
  const aid = asset.body.item.id;
  const [u1, u2] = await Promise.all([
    request('PUT', `/assets/${aid}`, { name: 'R3E资产-A' }, adminToken),
    request('PUT', `/assets/${aid}`, { name: 'R3E资产-B' }, adminToken),
  ]);
  findings.push({ id: 'X2', note: `并发编辑资产 -> ${u1.status}/${u2.status}`, severity: u1.status === 200 && u2.status === 200 ? 'P3' : 'P3' });

  // X5 非法状态跳跃：completed 不能回 processing
  ok(await request('POST', `/open/work_order/${orderId}/transition`, { to: 'assigned', assignee: workerId }, adminToken), '派单');
  ok(await request('POST', `/open/work_order/${orderId}/transition`, { to: 'arrived' }, workerToken), '到场');
  ok(await request('POST', `/open/work_order/${orderId}/transition`, { to: 'processing' }, workerToken), '开始');
  ok(await request('POST', `/open/work_order/${orderId}/transition`, { to: 'pending_review' }, workerToken), '提交');
  ok(await request('POST', `/open/work_order/${orderId}/transition`, { to: 'review_passed' }, adminToken), '复核');
  ok(await request('POST', `/open/work_order/${orderId}/transition`, { to: 'completed' }, adminToken), '完成');
  const back = await request('POST', `/open/work_order/${orderId}/transition`, { to: 'processing' }, workerToken);
  assert([409, 422].includes(back.status), `完成后回退应拒绝，实际 ${back.status}`);

  // X9 上传攻击：路径穿越 / 非法类型
  const badUpload = await request('POST', `/public/upload?org=${encodeURIComponent(TENANT)}`, {
    filename: '../evil.html', contentType: 'text/html',
    base64: Buffer.from('<script>alert(1)</script>').toString('base64'),
  });
  assert([400, 403, 413, 415, 422].includes(badUpload.status), `非法上传应拒绝，实际 ${badUpload.status} ${JSON.stringify(badUpload.body)}`);

  console.log('[edge] FINDINGS', JSON.stringify(findings, null, 2));
  console.log(`[edge] PASS run=${RUN}`);
}

main()
  .then(async () => { await cleanup(); await db.end(); console.log(`[edge] cleaned ${TENANT}`); process.exit(0); })
  .catch(async (e) => {
    console.error('[edge] FAIL', e.message);
    try { await cleanup(); } catch { /* ignore */ }
    try { await db.end(); } catch { /* ignore */ }
    process.exit(1);
  });
