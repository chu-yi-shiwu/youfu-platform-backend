// 试点角色 × 动作矩阵 E2E（真实 API + 真实租户 workflow_def）
//
// 目的：把 2026-11-10 真机暴露的 403/422 变成可重复的回归：
//   - worker 不能取消 / 复核通过 / 复核退回；
//   - worker 挂起必须带 suspend_reason；
//   - worker 可以到场、开始、挂起、恢复、提交复核；
//   - admin 可以驳回、通过、取消。
//
// 运行（ECS）：
//   cd /opt/youfu/pilot/backend
//   PGDATABASE=youfu_pilot ENV_FILE=.env \
//     /opt/node16/bin/node pilot-role-action-e2e.mjs
//
// 可选：
//   PILOT_BASE_URL=http://127.0.0.1:4101
//   PILOT_TENANT=zixing-hospital
//
// 安全：自动创建两个临时师傅账号（无微信 openid），不会给真实师傅发通知；
//       结束时删除临时工单、账号、人员档案。
import { readFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import pg from 'pg';

const { Client } = pg;
const TENANT = process.env.PILOT_TENANT || 'zixing-hospital';
const BASE = (process.env.PILOT_BASE_URL || 'http://127.0.0.1:4101').replace(/\/+$/, '');
const RUN = process.env.E2E_RUN_ID || `r${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const ID_A = `E2E-ROLE-A-${RUN}`;
const ID_B = `E2E-ROLE-B-${RUN}`;
const SKILL_A = `e2e_role_a_${RUN}`;
const SKILL_B = `e2e_role_b_${RUN}`;
const USER_A = `e2e_role_a_${RUN}`;
const USER_B = `e2e_role_b_${RUN}`;

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

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const u = new URL(path, BASE);
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

async function login(username, password, channel) {
  const r = await request('POST', '/api/v1/auth/login', { username, password, tenant: TENANT, channel });
  if (r.status !== 200 || !r.body?.token) throw new Error(`login ${username} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); };
const expectStatus = (r, code, msg) => assert(r.status === code, `${msg}（期望 ${code}，实际 ${r.status} ${JSON.stringify(r.body)}）`);
const expectStatusIn = (r, codes, msg) => assert(codes.includes(r.status), `${msg}（期望 ${codes.join('/')}，实际 ${r.status} ${JSON.stringify(r.body)}）`);

const orders = [];
let accA = null;
let accB = null;
const PASS = 'E2e' + crypto.randomBytes(8).toString('hex') + '!1';

async function setup() {
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  const dept = await db.query(`SELECT id FROM dept WHERE tenant_id=$1 AND name='后勤设备科' LIMIT 1`, [TENANT]);
  assert(dept.rowCount === 1, '试点租户缺少 后勤设备科');
  const a = await db.query(
    `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
     VALUES ($1,$2,$3,$4,'worker',true) RETURNING id`,
    [TENANT, USER_A, hashPassword(PASS), 'E2E角色A'],
  );
  const b = await db.query(
    `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
     VALUES ($1,$2,$3,$4,'worker',true) RETURNING id`,
    [TENANT, USER_B, hashPassword(PASS), 'E2E角色B'],
  );
  accA = a.rows[0].id;
  accB = b.rows[0].id;
  await db.query(
    `INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id,department_id)
     VALUES ($1,$2,'E2E角色A',$3::text[],0,true,$4,$5)`,
    [ID_A, TENANT, ['repair', SKILL_A], accA, dept.rows[0].id],
  );
  await db.query(
    `INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id,department_id)
     VALUES ($1,$2,'E2E角色B',$3::text[],0,true,$4,$5)`,
    [ID_B, TENANT, ['repair', SKILL_B], accB, dept.rows[0].id],
  );
  await db.query('COMMIT');
}

async function cleanupOrder(id) {
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  for (const table of [
    'ai_conversation', 'ai_shadow_suggestions', 'feedback', 'inventory_log', 'ticket_learn_log',
    'work_acceptance', 'webhook_delivery', 'settlement_item', 'ticket_event', 'notification',
  ]) {
    await db.query(`DELETE FROM ${table} WHERE tenant_id=$1 AND work_order_id::text=$2`, [TENANT, id]);
  }
  await db.query(`DELETE FROM domain_event WHERE tenant_id=$1 AND entity_type='work_order' AND entity_id=$2`, [TENANT, id]);
  await db.query(`DELETE FROM idempotency_key WHERE tenant_id=$1 AND work_order_id=$2`, [TENANT, id]);
  await db.query(`DELETE FROM work_orders WHERE tenant_id=$1 AND id=$2`, [TENANT, id]);
  await db.query('COMMIT');
}

async function cleanup() {
  for (const id of orders) await cleanupOrder(id).catch(() => {});
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  if (accA) {
    await db.query(`UPDATE worker SET account_id=NULL WHERE tenant_id=$1 AND account_id=$2`, [TENANT, accA]);
    await db.query(`DELETE FROM account_user WHERE tenant_id=$1 AND id=$2`, [TENANT, accA]);
  }
  if (accB) {
    await db.query(`UPDATE worker SET account_id=NULL WHERE tenant_id=$1 AND account_id=$2`, [TENANT, accB]);
    await db.query(`DELETE FROM account_user WHERE tenant_id=$1 AND id=$2`, [TENANT, accB]);
  }
  await db.query(`DELETE FROM worker WHERE tenant_id=$1 AND id IN ($2,$3)`, [TENANT, ID_A, ID_B]);
  await db.query('COMMIT');
}

async function createOrder(admin, label) {
  const id = crypto.randomUUID();
  orders.push(id);
  const r = await request('POST', '/api/v1/open/work_order', {
    id,
    business_type: 'repair',
    catalog: 'hosp_water',
    title: `角色矩阵测试-${label}`,
    description: '自动化角色矩阵测试，请忽略',
    location: '后勤设备科',
    reporter_name: 'E2E',
    priority: 'normal',
    skill_tags: [SKILL_A],
    ext: { e2e_role_matrix: RUN },
  }, admin);
  assert([200, 201].includes(r.status), `建单 ${label} HTTP ${r.status} ${JSON.stringify(r.body)}`);
  if (r.body.assignee !== ID_A) {
    const fwd = await request('POST', `/api/v1/open/work_order/${id}/transition`, { to: 'assigned', assignee: ID_A }, admin);
    assert(fwd.status === 200, `改派给 E2E A HTTP ${fwd.status} ${JSON.stringify(fwd.body)}`);
  }
  return id;
}

async function transition(id, token, to, fields, msg) {
  const r = await request('POST', `/api/v1/open/work_order/${id}/transition`, { to, ...fields }, token);
  return { r, msg };
}

async function main() {
  await db.connect();
  await setup();
  const admin = await login(process.env.admin_user || 'admin', process.env.admin_password, 'pc');
  const workerA = await login(USER_A, PASS, 'mp');
  const workerB = await login(USER_B, PASS, 'mp');

  // ===== 主链：A 处理 → 提交复核 → 越权复核被拒 → admin 复核 =====
  const id = await createOrder(admin, '主链');
  let r = await transition(id, workerA, 'arrived', {}, 'A 到场');
  expectStatus(r.r, 200, r.msg);
  r = await transition(id, workerA, 'processing', {}, 'A 开始处理');
  expectStatus(r.r, 200, r.msg);

  r = await transition(id, workerA, 'suspended', {}, 'A 挂起但未填原因');
  expectStatus(r.r, 422, r.msg + ' 应被 requiredFields 拒绝');
  r = await transition(id, workerA, 'suspended', { suspend_reason: '等待配件' }, 'A 挂起（带原因）');
  expectStatus(r.r, 200, r.msg);
  r = await transition(id, workerA, 'processing', {}, 'A 恢复');
  expectStatus(r.r, 200, r.msg);

  r = await transition(id, workerA, 'cancelled', { cancel_reason: 'A 尝试取消' }, 'A 取消');
  expectStatus(r.r, 403, r.msg + ' 应被角色门禁拒绝');
  r = await transition(id, workerB, 'cancelled', { cancel_reason: 'B 尝试取消' }, 'B 取消');
  expectStatusIn(r.r, [403, 404], r.msg + ' 应被拒绝');

  r = await transition(id, workerA, 'pending_review', {}, 'A 提交复核');
  expectStatus(r.r, 200, r.msg);

  r = await transition(id, workerA, 'review_passed', {}, 'A 复核通过');
  expectStatus(r.r, 403, r.msg + ' 应被角色门禁拒绝');
  r = await transition(id, workerA, 'processing', {}, 'A 复核退回');
  expectStatus(r.r, 403, r.msg + ' 应被角色门禁拒绝');
  r = await transition(id, workerB, 'review_passed', {}, 'B 复核通过');
  expectStatusIn(r.r, [403, 404], r.msg + ' 应被拒绝');

  r = await transition(id, admin, 'processing', {}, 'admin 驳回');
  expectStatus(r.r, 200, r.msg);
  r = await transition(id, workerA, 'pending_review', {}, 'A 再次提交复核');
  expectStatus(r.r, 200, r.msg);
  r = await transition(id, admin, 'review_passed', {}, 'admin 复核通过');
  expectStatus(r.r, 200, r.msg);
  r = await transition(id, admin, 'completed', {}, 'admin 完成');
  expectStatus(r.r, 200, r.msg);

  // ===== 取消链：A 处理中取消被拒，admin 取消成功 =====
  const id2 = await createOrder(admin, '取消链');
  r = await transition(id2, workerA, 'arrived', {}, 'A 到场（取消链）');
  expectStatus(r.r, 200, r.msg);
  r = await transition(id2, workerA, 'processing', {}, 'A 开始（取消链）');
  expectStatus(r.r, 200, r.msg);
  r = await transition(id2, workerA, 'cancelled', { cancel_reason: 'A 尝试取消' }, 'A 取消处理中工单');
  expectStatus(r.r, 403, r.msg + ' 应被角色门禁拒绝');
  r = await transition(id2, admin, 'cancelled', { cancel_reason: '管理员取消测试单' }, 'admin 取消');
  expectStatus(r.r, 200, r.msg);

  console.log(`[role-e2e] PASS run=${RUN} orders=${orders.length}`);
}

main()
  .then(async () => { await cleanup(); await db.end(); process.exit(0); })
  .catch(async (e) => {
    console.error('[role-e2e] FAILED', e.message);
    await cleanup().catch(() => {});
    try { await db.end(); } catch { /* ignore */ }
    process.exit(1);
  });
