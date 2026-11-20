// Round 2 深度 E2E：权限矩阵 + 跨租户隔离 + 并发竞态 + 幂等
//
// 与 pilot-uat-all-modules-e2e.mjs 的分工：
//   - UAT 脚本证明“每个模块能闭环”；
//   - 本脚本证明“不该通的通不了、并发下不超卖/不重复/不双写”。
//
// 运行（ECS）：
//   cd /opt/youfu/pilot/backend
//   PGDATABASE=youfu_pilot ENV_FILE=.env \
//     /opt/node16/bin/node scripts/pilot-round2-deep-e2e.mjs
//
// 完全隔离：创建 uat-r2a-<run> / uat-r2b-<run> 两个租户，结束按 tenant_id 清理。
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;
const BASE = (process.env.PILOT_API_BASE || 'http://127.0.0.1:4101/api/v1').replace(/\/+$/, '');
const UPLOAD_ROOT = process.env.UPLOAD_DIR || '/opt/youfu/pilot/uploads';
const RUN = process.env.E2E_RUN_ID || `r2${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const TEN_A = `uat-r2a-${RUN}`;
const TEN_B = `uat-r2b-${RUN}`;
const ADMIN_USER = 'r2_admin';
const OP_USER = 'r2_op';
const WORKER_USER = 'r2_worker';
const CLAIM_USERS = [1, 2, 3].map((i) => `r2_claim${i}`);
const PASS = 'Round2!2026';
const BASE_SKILL = `r2_base_${RUN}`;
const CLAIM_SKILL = `r2_claim_${RUN}`;
const CAT_CODE = `r2_cat_${RUN}`;
const WORKER_ID_A = `R2-W-${RUN}-A`;
const WORKER_ID_B = `R2-W-${RUN}-B`;

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

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function request(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const u = new URL(p.startsWith('http') ? p : BASE + p);
    const mod = u.protocol === 'https:' ? https : http;
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
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { raw }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function login(tenant, username, password, channel = 'pc') {
  const r = await request('POST', '/auth/login', { username, password, tenant, channel });
  if (r.status !== 200 || !r.body?.token) throw new Error(`login ${username}@${tenant} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); };
const bodyOf = (r) => r.body?.item || r.body?.result || r.body?.ticket || r.body || {};

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`[deep] PASS ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.error(`[deep] FAIL ${name}: ${e.message}`);
  }
}

let sourceWf = null;
const tokens = {};
let deptA = null;
let deptB = null;

async function setupTenant(tenant, suffix, workerSkill, workerId) {
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [tenant]);
  await db.query(`INSERT INTO tenant_registry (tenant_id,name,status) VALUES ($1,$2,'active')`, [tenant, `R2 ${suffix}`]);
  const dept = await db.query(
    `INSERT INTO dept (tenant_id,name,code,remark,is_default) VALUES ($1,$2,$3,'R2',true) RETURNING id`,
    [tenant, `R2部门-${suffix}`, `R2-${suffix}`],
  );
  const deptId = dept.rows[0].id;
  const admin = await db.query(
    `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
     VALUES ($1,$2,$3,'R2管理员','admin',true) RETURNING id`,
    [tenant, ADMIN_USER, hashPassword(PASS)],
  );
  await db.query(
    `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
     VALUES ($1,$2,$3,'R2运营','operator',true)`,
    [tenant, OP_USER, hashPassword(PASS)],
  );
  const workerAcc = await db.query(
    `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
     VALUES ($1,$2,$3,'R2师傅','worker',true) RETURNING id`,
    [tenant, WORKER_USER, hashPassword(PASS)],
  );
  await db.query(
    `INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id,department_id)
     VALUES ($1,$2,'R2师傅',$3::text[],0,true,$4,$5)`,
    [workerId, tenant, ['repair', workerSkill], workerAcc.rows[0].id, deptId],
  );
  await db.query(
    `INSERT INTO fault_category (tenant_id,code,name,business_type,skill_tags,sort,enabled)
     VALUES ($1,$2,$3,'repair',$4::jsonb,1,true)`,
    [tenant, CAT_CODE, `R2分类-${suffix}`, JSON.stringify(['repair', workerSkill])],
  );
  await db.query(
    `INSERT INTO location_dict (tenant_id,code,name,category,enabled) VALUES ($1,'R2-LOC','R2-1F','位置',true)`,
    [tenant],
  );
  await db.query(
    `INSERT INTO workflow_def (tenant_id,entity_type,def,version,updated_by)
     VALUES ($1,'work_order',$2::jsonb,$3,'r2')`,
    [tenant, JSON.stringify(sourceWf.def), sourceWf.version],
  );
  await db.query('COMMIT');
  return { deptId, adminId: admin.rows[0].id };
}

async function createClaimWorker(tenant, deptId, index) {
  const username = CLAIM_USERS[index - 1];
  const acc = await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [tenant]);
  const a = await db.query(
    `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
     VALUES ($1,$2,$3,$4,'worker',true) RETURNING id`,
    [tenant, username, hashPassword(PASS), `R2抢单${index}`],
  );
  await db.query(
    `INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id,department_id)
     VALUES ($1,$2,$3,$4::text[],0,true,$5,$6)`,
    [`R2-C-${RUN}-${index}`, tenant, `R2抢单${index}`, ['repair', CLAIM_SKILL], a.rows[0].id, deptId],
  );
  await db.query('COMMIT');
}

async function cleanupTenant(tenant) {
  try {
    const sql = `
BEGIN;
SET LOCAL session_replication_role = replica;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name FROM information_schema.columns
           WHERE table_schema='public' AND column_name='tenant_id'
  LOOP
    EXECUTE format('DELETE FROM %I WHERE tenant_id=$1', r.table_name) USING '${tenant}';
  END LOOP;
END $$;
COMMIT;`;
    execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', process.env.PGDATABASE || 'youfu_pilot', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' });
    rmSync(path.join(UPLOAD_ROOT, tenant), { recursive: true, force: true });
    console.log(`[deep] cleaned ${tenant}`);
  } catch (e) {
    console.error('[deep] cleanup failed', tenant, e.message);
  }
}

function countStatuses(arr) {
  const m = {};
  for (const r of arr) m[r.status] = (m[r.status] || 0) + 1;
  return m;
}

async function main() {
  await db.connect();

  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id','zixing-hospital',true), set_config('app.scope','system',true)`);
  const src = await db.query(
    `SELECT entity_type, def, version FROM workflow_def WHERE tenant_id='zixing-hospital' AND entity_type='work_order' ORDER BY version DESC LIMIT 1`,
  );
  await db.query('COMMIT');
  assert(src.rowCount === 1, '缺少源 workflow_def');
  sourceWf = src.rows[0];

  const a = await setupTenant(TEN_A, 'A', BASE_SKILL, WORKER_ID_A);
  const b = await setupTenant(TEN_B, 'B', BASE_SKILL, WORKER_ID_B);
  deptA = a.deptId;
  deptB = b.deptId;

  tokens.adminA = await login(TEN_A, ADMIN_USER, PASS);
  tokens.opA = await login(TEN_A, OP_USER, PASS);
  tokens.workerA = await login(TEN_A, WORKER_USER, PASS, 'mp');
  tokens.adminB = await login(TEN_B, ADMIN_USER, PASS);
  tokens.workerB = await login(TEN_B, WORKER_USER, PASS, 'mp');

  // ---------- 权限矩阵 ----------
  await check('权限矩阵：worker 不得进入账号/角色/反馈/派单规则/结算确认', async () => {
    const cases = [
      ['GET', '/accounts/roles', undefined, 403],
      ['POST', '/accounts', { username: `r2_hack_${RUN}`, password: 'Hack!2026', role: 'operator' }, 403],
      ['GET', '/feedback', undefined, 403],
      ['POST', '/config/dispatch-rules', { name: 'x' }, 403],
      ['POST', `/settlements/${crypto.randomUUID()}/confirm`, {}, 403],
    ];
    for (const [m, p, body, code] of cases) {
      const r = await request(m, p, body, tokens.workerA);
      assert(r.status === code, `${m} ${p} 期望 ${code}，实际 ${r.status} ${JSON.stringify(r.body)}`);
    }
  });

  await check('权限矩阵：operator 不得越级创建 admin', async () => {
    const r = await request('POST', '/accounts', {
      username: `r2_escalate_${RUN}`, password: 'Escalate!2026', display_name: '越级', role: 'admin',
    }, tokens.opA);
    assert(r.status === 403, `operator 建 admin 期望 403，实际 ${r.status} ${JSON.stringify(r.body)}`);
  });

  await check('权限矩阵：admin 正常读取账号与系统配置', async () => {
    const a1 = await request('GET', '/accounts', undefined, tokens.adminA);
    const a2 = await request('GET', '/config/system', undefined, tokens.adminA);
    assert(a1.status === 200 && a2.status === 200, `admin 读取失败 ${a1.status}/${a2.status}`);
  });

  await check('认证负向：未登录 401，篡改 token 401', async () => {
    const anon = await request('GET', '/open/work_orders');
    const bad = await request('GET', '/open/work_orders', undefined, tokens.adminA.slice(0, -2) + 'xx');
    assert(anon.status === 401, `未登录期望 401，实际 ${anon.status}`);
    assert(bad.status === 401, `篡改 token 期望 401，实际 ${bad.status}`);
  });

  // ---------- 跨租户隔离 ----------
  await check('租户隔离：A 不能读/改 B 的资产与工单', async () => {
    const assetB = await request('POST', '/assets', { name: 'R2-B资产', location: 'B', status: 'in_use' }, tokens.adminB);
    assert(assetB.status === 201, `B 建资产失败 ${assetB.status}`);
    const assetId = assetB.body.item.id;
    const readA = await request('GET', `/assets/${assetId}`, undefined, tokens.adminA);
    const writeA = await request('PUT', `/assets/${assetId}`, { name: 'hacked' }, tokens.adminA);
    assert([403, 404].includes(readA.status), `A 读 B 资产期望 403/404，实际 ${readA.status}`);
    assert([403, 404].includes(writeA.status), `A 改 B 资产期望 403/404，实际 ${writeA.status}`);

    const woB = await request('POST', '/open/work_order', {
      id: crypto.randomUUID(), business_type: 'repair', catalog: CAT_CODE,
      title: 'R2-B工单', description: 'B', location: 'B', priority: 'normal',
    }, tokens.adminB);
    assert([201, 200].includes(woB.status), `B 建单失败 ${woB.status}`);
    const woId = woB.body.id;
    const readWoA = await request('GET', `/open/work_order/${woId}`, undefined, tokens.adminA);
    assert([403, 404].includes(readWoA.status), `A 读 B 工单期望 403/404，实际 ${readWoA.status}`);
  });

  // ---------- 并发：抢单只能一个赢家 ----------
  let claimedWorkerToken = null;
  await check('并发抢单：3 人同时抢 1 单，仅 1 人成功', async () => {
    const create = await request('POST', '/open/work_order', {
      id: crypto.randomUUID(), business_type: 'repair', catalog: CAT_CODE,
      title: 'R2-抢单竞态', description: 'claim race', location: 'R2-1F',
      priority: 'normal', skill_tags: [CLAIM_SKILL],
    }, tokens.adminA);
    assert([201, 200].includes(create.status), `建抢单池工单失败 ${create.status} ${JSON.stringify(create.body)}`);
    const orderId = create.body.id;

    for (let i = 1; i <= 3; i++) await createClaimWorker(TEN_A, deptA, i);
    const claimTokens = [];
    for (const u of CLAIM_USERS) claimTokens.push(await login(TEN_A, u, PASS, 'mp'));

    const hall = await request('GET', '/open/claim-hall', undefined, claimTokens[0]);
    assert(hall.status === 200, `抢单大厅读取失败 ${hall.status}`);
    const hallItems = hall.body?.items || hall.body?.groups || [];
    const flat = Array.isArray(hallItems) ? hallItems : [];
    assert(flat.some((x) => x.id === orderId), '抢单大厅未出现该工单');

    const racers = await Promise.all(
      claimTokens.map((t) => request('POST', `/open/work_order/${orderId}/claim`, {}, t)),
    );
    const st = countStatuses(racers);
    const winners = racers.filter((r) => r.status === 200);
    assert(winners.length === 1,
      `期望恰好 1 个赢家，实际 ${JSON.stringify(st)} bodies=${JSON.stringify(racers.map((r) => ({ status: r.status, body: r.body })))}`);
    assert(racers.filter((r) => r.status !== 200).every((r) => [409, 422, 403].includes(r.status)),
      `失败者应为 409/422/403，实际 ${JSON.stringify(st)} bodies=${JSON.stringify(racers.map((r) => ({ status: r.status, body: r.body })))}`);
    claimedWorkerToken = claimTokens[racers.indexOf(winners[0])];
  });

  // ---------- 并发：库存不超卖 ----------
  await check('并发出库：库存 5，10 次并发出 1，只有 5 次成功且库存不为负', async () => {
    const mat = await request('POST', '/materials', {
      code: `R2-MAT-${RUN}`, name: 'R2耗材', unit: '个', price: 1, enabled: true,
    }, tokens.adminA);
    assert(mat.status === 201, `建耗材失败 ${mat.status}`);
    const materialId = mat.body.item.id;
    const inRes = await request('POST', '/inventory/in', { material_id: materialId, qty: 5 }, tokens.adminA);
    assert(inRes.status === 200, `入库失败 ${inRes.status}`);

    const outs = await Promise.all(
      Array.from({ length: 10 }, () => request('POST', '/inventory/out', { material_id: materialId, qty: 1 }, tokens.adminA)),
    );
    const success = outs.filter((r) => r.status === 200);
    assert(success.length === 5, `期望 5 次成功，实际 ${success.length}：${JSON.stringify(countStatuses(outs))}`);
    assert(outs.filter((r) => r.status !== 200).every((r) => r.status >= 400 && r.status < 500),
      `失败应为 4xx，实际 ${JSON.stringify(countStatuses(outs))}`);

    const inv = await request('GET', '/inventory', undefined, tokens.adminA);
    const row = (inv.body.items || []).find((x) => x.material_id === materialId);
    assert(row && Number(row.qty) === 0, `库存应为 0，实际 ${row?.qty}`);
  });

  // ---------- 并发：同一工单只能流转一次 ----------
  await check('并发流转：同一工单 3 次并发提交复核，仅 1 次成功', async () => {
    const create = await request('POST', '/open/work_order', {
      id: crypto.randomUUID(), business_type: 'repair', catalog: CAT_CODE,
      title: 'R2-流转竞态', description: 'transition race', location: 'R2-1F',
      priority: 'normal', skill_tags: [BASE_SKILL],
    }, tokens.adminA);
    assert([201, 200].includes(create.status), `建单失败 ${create.status}`);
    const orderId = create.body.id;
    const arrived = await request('POST', `/open/work_order/${orderId}/transition`, { to: 'arrived' }, tokens.workerA);
    const processing = await request('POST', `/open/work_order/${orderId}/transition`, { to: 'processing' }, tokens.workerA);
    assert(arrived.status === 200 && processing.status === 200, `到场/开始失败 ${arrived.status}/${processing.status}`);

    const racers = await Promise.all(
      Array.from({ length: 3 }, () => request('POST', `/open/work_order/${orderId}/transition`, { to: 'pending_review' }, tokens.workerA)),
    );
    const st = countStatuses(racers);
    const success = racers.filter((r) => r.status === 200);
    assert(success.length === 1, `期望恰好 1 次流转成功，实际 ${JSON.stringify(st)}`);
    const detail = await request('GET', `/open/work_order/${orderId}`, undefined, tokens.adminA);
    const ticket = detail.body.ticket || detail.body.item;
    assert(ticket.status === 'pending_review', `最终状态应为 pending_review，实际 ${ticket.status}`);

    // 继续完成到 completed，供结算重复测试
    await request('POST', `/open/work_order/${orderId}/transition`, { to: 'review_passed' }, tokens.adminA);
    const completed = await request('POST', `/open/work_order/${orderId}/transition`, { to: 'completed' }, tokens.adminA);
    assert(completed.status === 200, `完成失败 ${completed.status} ${JSON.stringify(completed.body)}`);

    // ---------- 并发：同一工单不能重复入结算 ----------
    const s1 = request('POST', '/settlements', { work_order_ids: [orderId] }, tokens.adminA);
    const s2 = request('POST', '/settlements', { work_order_ids: [orderId] }, tokens.adminA);
    const [r1, r2] = await Promise.all([s1, s2]);
    const codes = [r1.status, r2.status].sort();
    assert(codes[0] === 201 && codes[1] === 409, `期望 201+409，实际 ${JSON.stringify(codes)} ${JSON.stringify(r1.body)} ${JSON.stringify(r2.body)}`);

    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TEN_A]);
    const cnt = await db.query(`SELECT count(*)::int c FROM settlement_item WHERE tenant_id=$1 AND work_order_id=$2`, [TEN_A, orderId]);
    await db.query('COMMIT');
    assert(cnt.rows[0].c === 1, `结算明细应恰好 1 行，实际 ${cnt.rows[0].c}`);
  });

  // ---------- 清理 ----------
  await cleanupTenant(TEN_A);
  await cleanupTenant(TEN_B);

  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id','zixing-hospital',true), set_config('app.scope','system',true)`);
  const left = await db.query(
    `SELECT (SELECT count(*)::int FROM tenant_registry WHERE tenant_id IN ($1,$2)) AS tenants,
            (SELECT count(*)::int FROM work_orders WHERE tenant_id IN ($1,$2)) AS orders,
            (SELECT count(*)::int FROM account_user WHERE tenant_id IN ($1,$2)) AS accounts`,
    [TEN_A, TEN_B],
  );
  await db.query('COMMIT');
  assert(left.rows[0].tenants === 0 && left.rows[0].orders === 0 && left.rows[0].accounts === 0,
    `清理不彻底 ${JSON.stringify(left.rows[0])}`);

  console.log('[deep] SUMMARY', JSON.stringify({ run: RUN, tenants: [TEN_A, TEN_B], results }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`[deep] ${failed.length === 0 ? 'PASS' : 'PARTIAL'} checks=${results.length} failed=${failed.length}`);
}

main()
  .then(async () => { await db.end(); process.exit(0); })
  .catch(async (e) => {
    console.error('[deep] FATAL', e.message);
    await cleanupTenant(TEN_A);
    await cleanupTenant(TEN_B);
    try { await db.end(); } catch { /* ignore */ }
    process.exit(1);
  });
