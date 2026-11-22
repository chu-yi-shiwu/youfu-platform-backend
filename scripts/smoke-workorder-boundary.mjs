// Live contract smoke: worker execution vs management boundary.
// Read-only. Run on the DB host from the backend directory:
//   ENV_FILE=.env AUDIT_TENANT=zixing-hospital API_BASE=http://127.0.0.1:4001/api/v1 \
//     node scripts/smoke-workorder-boundary.mjs
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

const tenant = process.env.AUDIT_TENANT || '';
const base = process.env.API_BASE || 'http://127.0.0.1:4001/api/v1';
if (!tenant) {
  console.error('[workorder-boundary] missing AUDIT_TENANT');
  process.exit(2);
}
if (!process.env.JWT_SECRET) {
  console.error('[workorder-boundary] missing JWT_SECRET');
  process.exit(2);
}

function b64url(value) {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function sign(sub, role) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ tid: tenant, sub, role, iat: now, exp: now + 600 }));
  const body = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(body).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${body}.${sig}`;
}
function request(path, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(base + path), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch { /* keep raw */ }
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const db = new pg.Client({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});

try {
  await db.connect();
  await db.query('BEGIN');
  await db.query("SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)", [tenant]);
  const admin = await db.query("SELECT id FROM account_user WHERE tenant_id=$1 AND role='admin' AND active=true LIMIT 1", [tenant]);
  const worker = await db.query("SELECT id FROM account_user WHERE tenant_id=$1 AND role='worker' AND active=true LIMIT 1", [tenant]);
  await db.query('ROLLBACK');
  await db.end();
  if (admin.rowCount === 0 || worker.rowCount === 0) {
    console.error('[workorder-boundary] missing active admin/worker account');
    process.exit(1);
  }

  const adminToken = sign(admin.rows[0].id, 'admin');
  const workerToken = sign(worker.rows[0].id, 'worker');
  const adminList = await request('/admin/work-orders?limit=1', adminToken);
  const firstId = adminList.json?.items?.[0]?.id;
  const detailId = process.env.SMOKE_DETAIL_ID || firstId;
  const checks = {
    adminList: adminList.status,
    adminOnOpen: (await request('/open/work_orders', adminToken)).status,
    workerList: (await request('/open/work_orders', workerToken)).status,
    workerAdminList: (await request('/admin/work-orders', workerToken)).status,
    workerAdminEvents: firstId ? (await request(`/admin/work-orders/${encodeURIComponent(firstId)}/events`, workerToken)).status : null,
    workerDispatchRecommend: (await request('/admin/work-orders/dispatch/recommend', workerToken)).status,
    detail: detailId ? (await request(`/admin/work-orders/${encodeURIComponent(detailId)}`, adminToken)).status : null,
  };

  const ok = checks.adminList === 200
    && checks.adminOnOpen === 403
    && checks.workerList === 200
    && checks.workerAdminList === 403
    && (checks.workerAdminEvents === 403 || checks.workerAdminEvents === null)
    && checks.workerDispatchRecommend === 403
    && (checks.detail === 200 || checks.detail === null);
  console.log(JSON.stringify({ tenant, status: ok ? 'PASS' : 'FAIL', checks }));
  if (!ok) process.exit(1);
} catch (e) {
  console.error('[workorder-boundary] ERROR', e.message);
  process.exit(1);
}
