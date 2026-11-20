// 公共报修本人评价 live 验收（隔离租户 uat-eval-*，结束清理）。
// 链路：公共报修建单拿 view_token → 工单置 closed → token 评价 → 数据落库 → 重复评价拒绝。
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import pg from 'pg';
import { RICH_WORK_ORDER_DEF } from '../dist/engine/stateMachine.js';

const { Client } = pg;
const BASE = (process.env.PILOT_API_BASE || 'http://127.0.0.1:4101/api/v1').replace(/\/+$/, '');
const RUN = (process.env.E2E_RUN_ID || `ev${Date.now().toString(36)}`).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
const TENANT = `uat-eval-${RUN}`;
const DBNAME = process.env.PGDATABASE || 'youfu_pilot';

for (const f of [process.env.ENV_FILE || '.env']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const db = new Client({
  host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 5432),
  database: DBNAME, user: process.env.PGUSER || 'youfu_app', password: process.env.PGPASSWORD,
});

function request(method, p, body) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(new URL(p.startsWith('http') ? p : BASE + p), {
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } : {},
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
    req.on('error', (e) => resolve({ status: 0, body: { error: e.message } }));
    if (data) req.write(data);
    req.end();
  });
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok });
  console.log(`[${ok ? 'PASS' : 'GAP'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

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
    execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', DBNAME, '-v', 'ON_ERROR_STOP=1', '-c', `DELETE FROM platform_audit WHERE target_tenant='${TENANT}'`], { stdio: 'pipe' });
    for (const root of new Set([process.env.UPLOAD_DIR, '/opt/youfu/pilot/uploads', '/opt/youfu/uploads'].filter(Boolean))) {
      rmSync(`${root}/${TENANT}`, { recursive: true, force: true });
    }
    console.log('[eval-audit] cleaned', TENANT);
  } catch (e) {
    console.error('[eval-audit] cleanup failed', e.message);
  }
}

async function main() {
  await db.connect();
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  await db.query(`INSERT INTO tenant_registry (tenant_id,name,status,category) VALUES ($1,'公共评价验收租户','active','other')`, [TENANT]);
  await db.query(`INSERT INTO dept (tenant_id,name,code,is_default,enabled) VALUES ($1,'评价验收科','EVAL',true,true)`, [TENANT]);
  // 隔离租户需要与生产一致的工作流定义（closed -> evaluated satisfy）。
  await db.query(
    `INSERT INTO workflow_def (tenant_id,entity_type,def,version,updated_by)
     VALUES ($1,'work_order',$2::jsonb,1,'eval-audit')`,
    [TENANT, JSON.stringify(RICH_WORK_ORDER_DEF)],
  );
  await db.query('COMMIT');

  const created = await request('POST', '/public/repair-report', {
    org: TENANT,
    consent: true,
    description: '公共报修评价验收：空调不制冷',
    location: '验收楼 1F',
    name: '验收用户',
    phone: '13800000000',
  });
  check('公共报修建单成功', created.status === 201 && Boolean(created.body?.view_token), `status=${created.status} code=${created.body?.code ?? ''}`);
  const orderNo = created.body?.order_no;
  const token = created.body?.view_token;
  if (!orderNo || !token) throw new Error('missing order_no/view_token');

  // 直接把验收单置为 closed，模拟维修完成待评价。
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  const upd = await db.query(
    `UPDATE work_orders SET status='closed', updated_at=now()
      WHERE tenant_id=$1 AND order_no=$2 AND ext->>'public_view_token'=$3`,
    [TENANT, orderNo, token],
  );
  await db.query('COMMIT');
  check('工单进入可评价状态', upd.rowCount === 1);

  const evalRes = await request('POST', '/public/evaluate-report', {
    org: TENANT, token, score: 5, comment: '服务很好，处理及时',
  });
  check('token 评价成功', evalRes.status === 200 && evalRes.body?.ok === true, `status=${evalRes.status} code=${evalRes.body?.code ?? ''}`);

  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  const row = await db.query(
    `SELECT status, satisfaction_score, ext->>'satisfaction_comment' AS comment
       FROM work_orders WHERE tenant_id=$1 AND order_no=$2`,
    [TENANT, orderNo],
  );
  await db.query('COMMIT');
  const r = row.rows[0] || {};
  check('评价落库：status=evaluated / score=5 / comment 保留', r.status === 'evaluated' && Number(r.satisfaction_score) === 5 && r.comment === '服务很好，处理及时',
    `status=${r.status} score=${r.satisfaction_score}`);

  const again = await request('POST', '/public/evaluate-report', { org: TENANT, token, score: 5 });
  check('重复评价被拒', again.status === 422 && again.body?.code === 'NOT_EVALUABLE', `status=${again.status} code=${again.body?.code ?? ''}`);

  const summary = { total: checks.length, pass: checks.filter((c) => c.ok).length, gaps: checks.filter((c) => !c.ok).map((c) => c.name) };
  console.log('SUMMARY=' + JSON.stringify(summary, null, 2));
  await cleanup();
  await db.end();
  process.exit(summary.gaps.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error('FATAL', e);
  try { await cleanup(); } catch {}
  process.exit(1);
});
