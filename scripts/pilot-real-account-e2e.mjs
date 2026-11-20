// 真实 pilot 租户 + 真实师傅账号全流程集成测试
//
// 使用：
//   - 租户 zixing-hospital
//   - 真实师傅账号 17773639019 / HQ016
//   - 真实管理员 admin
//
// 流程：建单 → 派给 HQ016 → 到场/开始 → 照片/录音/备注 → 提交复核
//      → admin 驳回 → 再提交 → admin 通过 → 完成 → 关闭 → 评价 5
//      → 核对通知/媒体/状态 → 清理测试单
//
// 说明：会向 HQ016 产生真实通知记录；是否真正到达微信取决于该账号的一次性订阅授权。
//       不修改真实联系人数据；测试证据不输出手机号。
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;
const TENANT = 'zixing-hospital';
const BASE = (process.env.PILOT_API_BASE || 'https://youfu.banerz.cn/pilot/api/v1').replace(/\/+$/, '');
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/opt/youfu/pilot/uploads';
const RUN = process.env.E2E_RUN_ID || `real${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const STARTED_AT = new Date().toISOString();
const WORKER_ID = 'HQ016';
const WORKER_USER = '17773639019';
const WORKER_PASS = process.env.REAL_WORKER_PASSWORD || 'lch1519033115';

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
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function login(username, password, channel) {
  const r = await request('POST', '/auth/login', { username, password, tenant: TENANT, channel });
  if (r.status !== 200 || !r.body?.token) throw new Error(`login ${username} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); };
const expectStatus = (r, code, msg) => assert(r.status === code, `${msg}（期望 ${code}，实际 ${r.status} ${JSON.stringify(r.body)}）`);

let orderId = null;
const uploaded = [];

async function upload(bytes, contentType, filename) {
  const base64 = crypto.randomBytes(bytes).toString('base64');
  const r = await request('POST', `/public/upload?org=${TENANT}`, { filename, contentType, base64 });
  if (r.status !== 201 || !r.body?.url) throw new Error(`upload failed ${r.status} ${JSON.stringify(r.body)}`);
  uploaded.push(r.body.url);
  return r.body.url;
}

async function transition(token, to, fields = {}) {
  return request('POST', `/open/work_order/${orderId}/transition`, { to, ...fields }, token);
}

async function cleanup() {
  if (!orderId) return;
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  for (const table of [
    'ai_conversation', 'ai_shadow_suggestions', 'feedback', 'inventory_log', 'ticket_learn_log',
    'work_acceptance', 'webhook_delivery', 'settlement_item', 'ticket_event', 'notification',
  ]) {
    await db.query(`DELETE FROM ${table} WHERE tenant_id=$1 AND work_order_id::text=$2`, [TENANT, orderId]);
  }
  await db.query(`DELETE FROM settlement WHERE tenant_id=$1 AND created_by='auto:evaluated' AND created_at >= $2`, [TENANT, STARTED_AT]);
  await db.query(`DELETE FROM domain_event WHERE tenant_id=$1 AND entity_type='work_order' AND entity_id=$2`, [TENANT, orderId]);
  await db.query(`DELETE FROM idempotency_key WHERE tenant_id=$1 AND work_order_id=$2`, [TENANT, orderId]);
  await db.query(`DELETE FROM work_orders WHERE tenant_id=$1 AND id=$2`, [TENANT, orderId]);
  await db.query('COMMIT');
  for (const url of uploaded) {
    const p = path.join(UPLOAD_DIR, url.replace(/^\/uploads\//, ''));
    try { unlinkSync(p); } catch { /* ignore */ }
  }
}

async function main() {
  await db.connect();
  const admin = await login(process.env.admin_user || 'admin', process.env.admin_password, 'pc');
  const worker = await login(WORKER_USER, WORKER_PASS, 'mp');

  orderId = crypto.randomUUID();
  const create = await request('POST', '/open/work_order', {
    id: orderId,
    business_type: 'repair',
    catalog: 'hosp_water',
    title: `UAT真实账号全流程-${RUN}`,
    description: '真实租户全流程集成测试，请忽略',
    location: '心血管内科',
    reporter_name: 'E2E',
    priority: 'normal',
    source: 'backend',
    ext: { real_account_e2e: RUN },
  }, admin);
  assert([200, 201].includes(create.status), `建单 HTTP ${create.status} ${JSON.stringify(create.body)}`);
  const orderNo = create.body.order_no;
  console.log(`[real] created ${orderNo} assignee=${create.body.assignee}`);

  let detail = await request('GET', `/open/work_order/${orderId}`, undefined, admin);
  expectStatus(detail, 200, '管理员读单');
  let ticket = detail.body.ticket || detail.body.item;
  if (ticket.assignee_id !== WORKER_ID) {
    const fwd = await transition(admin, 'assigned', { assignee: WORKER_ID });
    expectStatus(fwd, 200, '改派给 HQ016');
    detail = await request('GET', `/open/work_order/${orderId}`, undefined, admin);
    ticket = detail.body.ticket || detail.body.item;
  }
  assert(ticket.assignee_id === WORKER_ID, `应派给 ${WORKER_ID}（实际 ${ticket.assignee_id}）`);
  console.log(`[real] assigned to ${WORKER_ID}`);

  // 真实师傅处理
  expectStatus(await transition(worker, 'arrived'), 200, '到场');
  expectStatus(await transition(worker, 'processing'), 200, '开始处理');
  const photo = await upload(32 * 1024, 'image/jpeg', 'real.jpg');
  expectStatus(await request('POST', `/open/work_order/${orderId}/photos`, { photo, caption: 'UAT真实现场' }, worker), 200, '现场照片');
  const voice = await upload(16 * 1024, 'audio/mpeg', 'real.mp3');
  expectStatus(await request('POST', `/open/work_order/${orderId}/voice`, { url: voice }, worker), 200, '现场录音');
  expectStatus(await request('PATCH', `/open/work_order/${orderId}/ext`, { patch: { feedback_note: 'UAT 真实账号处理完成' } }, worker), 200, '现场备注');
  expectStatus(await transition(worker, 'pending_review'), 200, '提交复核');

  // 越权检查
  expectStatus(await transition(worker, 'review_passed'), 403, 'worker 复核通过应 403');
  expectStatus(await transition(worker, 'cancelled', { cancel_reason: 'UAT' }), 403, 'worker 取消应 403');

  // 管理员驳回 → 再提交 → 通过 → 完成 → 关闭 → 评价
  expectStatus(await transition(admin, 'processing'), 200, '管理员驳回');
  expectStatus(await transition(worker, 'pending_review'), 200, '再次提交复核');
  expectStatus(await transition(admin, 'review_passed'), 200, '管理员复核通过');
  expectStatus(await transition(admin, 'completed'), 200, '完成');
  expectStatus(await transition(admin, 'closed', { close_reason: 'UAT真实账号关闭' }), 200, '关闭');
  expectStatus(await transition(admin, 'evaluated', { score: 5 }), 200, '评价');

  detail = await request('GET', `/open/work_order/${orderId}`, undefined, admin);
  const final = detail.body.ticket || detail.body.item;
  assert(final.status === 'evaluated', `最终 evaluated（实际 ${final.status}）`);
  assert(Number(final.satisfaction_score) === 5, `满意度 5（实际 ${final.satisfaction_score}）`);
  assert(final.assignee_id === WORKER_ID, '承接人仍为 HQ016');
  assert((final.ext?.photos || []).length >= 1, '现场照片应落库');
  assert((final.ext?.voice || []).length >= 1, '现场录音应落库');
  assert(final.ext?.feedback_note === 'UAT 真实账号处理完成', '现场备注应落库');

  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  // R31-Q1：wechat 是响应 finish 后异步补投递，落库凭证晚于 HTTP 响应；
  // 留 6s 等补投递完成后再查，避免把「尚未落库」误判成「没有发」。
  await new Promise((r) => setTimeout(r, 6000));
  const notif = await db.query(
    `SELECT channel, recipient_kind, delivered,
            payload->>'errcode' AS errcode,
            left(coalesce(payload->>'_note', payload->>'errmsg', ''), 100) AS note
       FROM notification WHERE tenant_id=$1 AND work_order_id=$2
      ORDER BY created_at`,
    [TENANT, orderId],
  );
  await db.query('COMMIT');
  assert(notif.rows.length > 0, '应有通知记录');
  console.log('[real] notifications=' + JSON.stringify(notif.rows));
  console.log(`[real] PASS order=${orderNo} status=evaluated score=5`);
}

main()
  .then(async () => { await cleanup(); await db.end(); process.exit(0); })
  .catch(async (e) => {
    console.error('[real] FAILED', e.message);
    await cleanup().catch((ce) => console.error('[real] cleanup failed', ce.message));
    try { await db.end(); } catch { /* ignore */ }
    process.exit(1);
  });
