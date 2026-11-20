// 试点安全 E2E（真实 API + 真实库）
//
// 覆盖：
//   1. 跨租户读取（主站 token ↔ pilot 数据）
//   2. X-Tenant-Id 伪造（token 的 tid 优先，不能越租户）
//   3. IDOR：worker 读/改他人承接的工单
//   4. PII/角色：worker 读联系人、人员档案、统计、权限管理、通用业务流
//   5. 公开面：内部工单 token/单号不得出现在「我的报修」/公开状态查询
//   5. Token 篡改 → 401
//   6. SQL 注入字符串 → 不 500、不绕过
//   7. 上传路径穿越 / 非法类型 / 文件名穿越
//   8. 未认证访问工单详情
//
// 运行（ECS）：
//   cd /opt/youfu/pilot/backend
//   PGDATABASE=youfu_pilot ENV_FILE=.env \
//   MAIN_WORKER_PASSWORD=... \
//     /opt/node16/bin/node pilot-security-e2e.mjs
//
// 可选：
//   PILOT_API_BASE=https://youfu.banerz.cn/pilot/api/v1
//   MAIN_API_BASE=https://youfu.banerz.cn/api/v1
//   MAIN_TENANT=t-verification
//   MAIN_DB=youfu
//
// 安全：临时师傅账号无微信 openid；测试结束删除临时工单、账号、上传文件。
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;
const TENANT = process.env.PILOT_TENANT || 'zixing-hospital';
const PILOT_API = (process.env.PILOT_API_BASE || 'https://youfu.banerz.cn/pilot/api/v1').replace(/\/+$/, '');
const MAIN_API = (process.env.MAIN_API_BASE || 'https://youfu.banerz.cn/api/v1').replace(/\/+$/, '');
const MAIN_TENANT = process.env.MAIN_TENANT || 't-verification';
const MAIN_WORKER_USER = process.env.MAIN_WORKER_USER || '17773639019';
const MAIN_WORKER_PASSWORD = process.env.MAIN_WORKER_PASSWORD || '';
const MAIN_DB = process.env.MAIN_DB || 'youfu';
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/opt/youfu/pilot/uploads';
const RUN = process.env.E2E_RUN_ID || `s${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const ID_A = `E2E-SEC-A-${RUN}`;
const ID_B = `E2E-SEC-B-${RUN}`;
const SKILL_B = `e2e_sec_b_${RUN}`;
const USER_A = `e2e_sec_a_${RUN}`;
const USER_B = `e2e_sec_b_${RUN}`;

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
const mainDb = new Client({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  database: MAIN_DB,
  user: process.env.PGUSER || 'youfu_app',
  password: process.env.PGPASSWORD,
});

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function request(method, url, body, token, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...extraHeaders,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { raw }; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function login(apiBase, username, password, tenant, channel) {
  const r = await request('POST', `${apiBase}/auth/login`, { username, password, tenant, channel });
  if (r.status !== 200 || !r.body?.token) return { token: null, status: r.status, body: r.body };
  return { token: r.body.token, status: r.status, body: r.body };
}

const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); };
const expectStatus = (r, code, msg) => assert(r.status === code, `${msg}（期望 ${code}，实际 ${r.status} ${JSON.stringify(r.body)}）`);
const expectStatusIn = (r, codes, msg) => assert(codes.includes(r.status), `${msg}（期望 ${codes.join('/')}，实际 ${r.status} ${JSON.stringify(r.body)}）`);
const expectNotServerError = (r, msg) => assert(r.status < 500, `${msg} 不得 500（实际 ${r.status} ${JSON.stringify(r.body)}）`);

const orders = [];
const files = [];
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
    [TENANT, USER_A, hashPassword(PASS), 'E2E安全A'],
  );
  const b = await db.query(
    `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
     VALUES ($1,$2,$3,$4,'worker',true) RETURNING id`,
    [TENANT, USER_B, hashPassword(PASS), 'E2E安全B'],
  );
  accA = a.rows[0].id;
  accB = b.rows[0].id;
  await db.query(
    `INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id,department_id)
     VALUES ($1,$2,'E2E安全A',$3::text[],0,true,$4,$5)`,
    [ID_A, TENANT, ['repair'], accA, dept.rows[0].id],
  );
  await db.query(
    `INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id,department_id)
     VALUES ($1,$2,'E2E安全B',$3::text[],0,true,$4,$5)`,
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
  for (const url of files) {
    const p = path.join(UPLOAD_DIR, url.replace(/^\/uploads\//, ''));
    try { unlinkSync(p); } catch { /* ignore */ }
  }
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  for (const acc of [accA, accB].filter(Boolean)) {
    await db.query(`UPDATE worker SET account_id=NULL WHERE tenant_id=$1 AND account_id=$2`, [TENANT, acc]);
    await db.query(`DELETE FROM account_user WHERE tenant_id=$1 AND id=$2`, [TENANT, acc]);
  }
  await db.query(`DELETE FROM worker WHERE tenant_id=$1 AND id IN ($2,$3)`, [TENANT, ID_A, ID_B]);
  await db.query('COMMIT');
}

async function createOrder(adminToken, label, title) {
  const id = crypto.randomUUID();
  orders.push(id);
  const r = await request('POST', `${PILOT_API}/open/work_order`, {
    id,
    business_type: 'repair',
    catalog: 'hosp_water',
    title: title || `安全测试-${label}`,
    description: '自动化安全测试，请忽略',
    location: '后勤设备科',
    reporter_name: 'E2E',
    priority: 'normal',
    skill_tags: [SKILL_B],
    ext: { e2e_security: RUN },
  }, adminToken);
  assert([200, 201].includes(r.status), `建单 ${label} HTTP ${r.status} ${JSON.stringify(r.body)}`);
  if (r.body.assignee !== ID_B) {
    const fwd = await request('POST', `${PILOT_API}/open/work_order/${id}/transition`, { to: 'assigned', assignee: ID_B }, adminToken);
    assert(fwd.status === 200, `改派给 B HTTP ${fwd.status} ${JSON.stringify(fwd.body)}`);
  }
  return id;
}

async function main() {
  await db.connect();
  await mainDb.connect();
  await setup();

  const admin = await login(PILOT_API, process.env.admin_user || 'admin', process.env.admin_password, TENANT, 'pc');
  assert(admin.token, `pilot admin 登录失败 ${JSON.stringify(admin.body)}`);
  const workerA = await login(PILOT_API, USER_A, PASS, TENANT, 'mp');
  assert(workerA.token, `pilot worker A 登录失败 ${JSON.stringify(workerA.body)}`);

  const orderB = await createOrder(admin.token, 'IDOR-B');
  const xssOrder = await createOrder(admin.token, 'XSS', '<img src=x onerror="window.__xss=1">');

  // ===== 1. 跨租户 =====
  await mainDb.query('BEGIN');
  await mainDb.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [MAIN_TENANT]);
  const mainOrder = await mainDb.query('SELECT id FROM work_orders WHERE tenant_id=$1 LIMIT 1', [MAIN_TENANT]);
  await mainDb.query('ROLLBACK');

  if (MAIN_WORKER_PASSWORD) {
    const mainWorker = await login(MAIN_API, MAIN_WORKER_USER, MAIN_WORKER_PASSWORD, MAIN_TENANT, 'mp');
    if (mainWorker.token) {
      const cross = await request('GET', `${PILOT_API}/open/work_order/${orderB}`, undefined, mainWorker.token);
      expectStatusIn(cross, [401, 403, 404], '主站 token 读 pilot 工单');
      const crossList = await request('GET', `${PILOT_API}/open/work_orders?limit=10`, undefined, mainWorker.token);
      expectStatusIn(crossList, [200, 401, 403], '主站 token 列 pilot 工单');
      if (crossList.status === 200) {
        const items = crossList.body.items || [];
        assert(!items.some((x) => x.id === orderB), '主站 token 不得在 pilot 列表中看到 pilot 工单');
      }
    }
  }
  if (mainOrder.rows[0]?.id) {
    const cross2 = await request('GET', `${MAIN_API}/open/work_order/${mainOrder.rows[0].id}`, undefined, admin.token);
    expectStatusIn(cross2, [401, 403, 404], 'pilot token 读主站工单');
  }

  // X-Tenant-Id 伪造：token tid 必须优先
  const spoof = await request('GET', `${PILOT_API}/open/work_orders?limit=200`, undefined, admin.token, {
    'X-Tenant-Id': MAIN_TENANT,
  });
  expectStatus(spoof, 200, 'X-Tenant-Id 伪造后列表');
  const spoofItems = spoof.body.items || [];
  assert(!spoofItems.some((x) => x.tenant_id === MAIN_TENANT), 'X-Tenant-Id 不得把响应切到主站租户');
  assert(spoofItems.every((x) => x.tenant_id === TENANT), '列表所有行必须属于 pilot 租户');

  // ===== 2. IDOR =====
  const idor = await request('GET', `${PILOT_API}/open/work_order/${orderB}`, undefined, workerA.token);
  expectStatusIn(idor, [403, 404], 'worker A 读 B 的工单');
  const idorWrite = await request('POST', `${PILOT_API}/open/work_order/${orderB}/transition`, { to: 'arrived' }, workerA.token);
  expectStatusIn(idorWrite, [403, 404], 'worker A 改 B 的工单');

  // ===== 3. PII / 角色 =====
  expectStatus(await request('GET', `${PILOT_API}/basic-data/contact?limit=1`, undefined, workerA.token), 403, 'worker 读联系人 PII');
  expectStatus(await request('GET', `${PILOT_API}/stats`, undefined, workerA.token), 403, 'worker 读统计看板');
  expectStatusIn(await request('PUT', `${PILOT_API}/accounts/roles/worker/permissions`, { perms: ['role.manage'] }, workerA.token), [403], 'worker 改角色权限');
  expectStatus(await request('GET', `${PILOT_API}/open/notifications?recipient=admin`, undefined, workerA.token), 403, 'worker 读他人通知');
  expectStatus(await request('GET', `${PILOT_API}/open/work_order/${orderB}`), 401, '未认证读工单详情');

  // 2026-11-11 安全审计新增：人员档案含手机号/账号关联，worker 不得枚举
  expectStatus(await request('GET', `${PILOT_API}/workers?active=1`, undefined, workerA.token), 403, 'worker 枚举人员档案');
  expectStatus(await request('GET', `${PILOT_API}/workers/HQ016`, undefined, workerA.token), 403, 'worker 读他人人员档案');
  // flow.create 已从 worker 角色移除：worker 不得创建通用业务流任务
  expectStatus(await request('POST', `${PILOT_API}/flow/cycle_check`, { title: 'E2E越权探针' }, workerA.token), 403, 'worker 创建通用业务流任务');

  // 内部工单的 public_view_token 只能用于媒体读取，不能出现在公开「我的报修」列表
  const bDetail = await request('GET', `${PILOT_API}/open/work_order/${orderB}`, undefined, admin.token);
  expectStatus(bDetail, 200, '读取内部工单详情');
  const bTicket = bDetail.body.ticket || bDetail.body.item || {};
  const internalToken = bTicket.ext?.public_view_token;
  assert(typeof internalToken === 'string' && internalToken.length > 0, '内部工单应有 media/public token');
  const my = await request('GET', `${PILOT_API}/public/my-reports?org=${TENANT}&tokens=${encodeURIComponent(internalToken)}`);
  expectStatus(my, 200, '内部工单 token 查公开我的报修');
  assert(!(my.body.items || []).some((x) => x.order_no === bTicket.order_no), '内部工单不得出现在公开我的报修');
  const internalStatus = await request('GET', `${PILOT_API}/public/repair-status?org=${TENANT}&order_no=${encodeURIComponent(bTicket.order_no)}`);
  expectStatus(internalStatus, 404, '内部工单单号查公开状态');

  // ===== 4. Token 篡改 =====
  const tampered = `${admin.token.slice(0, -2)}xx`;
  expectStatus(await request('GET', `${PILOT_API}/open/work_order/${orderB}`, undefined, tampered), 401, '篡改 JWT 签名');

  // ===== 5. SQL 注入字符串 =====
  const badLogin = await request('POST', `${PILOT_API}/auth/login`, {
    username: "' OR 1=1--", password: process.env.admin_password, tenant: TENANT, channel: 'pc',
  });
  expectStatusIn(badLogin, [401, 403, 429], 'SQL 注入登录');
  const inj1 = await request('GET', `${PILOT_API}/open/work_orders?status=assigned%27%20OR%20%271%27%3D%271`, undefined, admin.token);
  expectNotServerError(inj1, 'status 注入');
  const inj2 = await request('GET', `${PILOT_API}/open/work_orders?assignee=HQ016%27%20OR%20%271%27%3D%271`, undefined, admin.token);
  expectNotServerError(inj2, 'assignee 注入');
  const badTenant = await request('POST', `${PILOT_API}/auth/login`, {
    username: 'admin', password: process.env.admin_password, tenant: "' OR 1=1--", channel: 'pc',
  });
  expectStatusIn(badTenant, [400, 429], 'tenant 注入');

  // ===== 6. 上传路径穿越/类型/文件名 =====
  const tiny = crypto.randomBytes(1024).toString('base64');
  expectStatusIn(await request('POST', `${PILOT_API}/public/upload?org=../${MAIN_TENANT}`, {
    filename: 'x.png', contentType: 'image/png', base64: tiny,
  }), [400, 404], 'org 路径穿越');
  expectStatusIn(await request('POST', `${PILOT_API}/public/upload?org=${TENANT}/../../${MAIN_TENANT}`, {
    filename: 'x.png', contentType: 'image/png', base64: tiny,
  }), [400, 404], 'org 多级穿越');
  expectStatus(await request('POST', `${PILOT_API}/public/upload?org=${TENANT}`, {
    filename: 'x.html', contentType: 'text/html', base64: tiny,
  }), 415, '禁止 HTML 上传');

  const traversalName = await request('POST', `${PILOT_API}/public/upload?org=${TENANT}`, {
    filename: '../../evil.png', contentType: 'image/png', base64: tiny,
  });
  expectStatus(traversalName, 201, '文件名穿越应被 UUID 重命名');
  assert(typeof traversalName.body?.url === 'string', '上传应返回 URL');
  assert(!traversalName.body.url.includes('..'), '上传 URL 不得含 ..');
  assert(traversalName.body.url.startsWith(`/uploads/${TENANT}/`), '上传 URL 必须在租户目录内');
  files.push(traversalName.body.url);

  // ===== 7. XSS 字符串可入库（页面转义由 PC E2E 验证）=====
  const xssDetail = await request('GET', `${PILOT_API}/open/work_order/${xssOrder}`, undefined, admin.token);
  expectStatus(xssDetail, 200, 'XSS 标题工单详情');
  const xssTitle = (xssDetail.body.ticket || xssDetail.body.item || {}).title || '';
  assert(xssTitle.includes('<img'), 'XSS 标题应按原文存储，由前端转义');

  console.log(`[security-e2e] PASS run=${RUN} orders=${orders.length} files=${files.length}`);
}

main()
  .then(async () => { await cleanup(); await db.end(); await mainDb.end(); process.exit(0); })
  .catch(async (e) => {
    console.error('[security-e2e] FAILED', e.message);
    await cleanup().catch(() => {});
    try { await db.end(); } catch { /* ignore */ }
    try { await mainDb.end(); } catch { /* ignore */ }
    process.exit(1);
  });
