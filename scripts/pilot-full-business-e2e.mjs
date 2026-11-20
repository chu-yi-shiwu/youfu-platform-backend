// 全业务流程集成测试（隔离 UAT 租户，不碰真实 pilot 数据）
//
// 流程：
//   建 UAT 租户 → 公开报修（带照片）→ 自动派单 → 师傅到场/开始
//   → 上传照片/录音/保存备注 → 挂起/恢复 → 提交复核
//   → worker 越权复核/取消被拒 → admin 驳回 → 再提交 → admin 通过
//   → 完成 → 关闭 → 评价 5 分 → 公开查询/通知/事件核对 → 清理租户
//
// 运行（ECS）：
//   cd /opt/youfu/pilot/backend
//   PGDATABASE=youfu_pilot ENV_FILE=.env \
//     /opt/node16/bin/node scripts/pilot-full-business-e2e.mjs
//
// 安全：独立租户 + 临时账号 + 临时分类；全程不会命中真实 zixing-hospital 的师傅/工单。
import { readFileSync, existsSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;
const BASE = (process.env.PILOT_API_BASE || 'https://youfu.banerz.cn/pilot/api/v1').replace(/\/+$/, '');
const UPLOAD_ROOT = process.env.UPLOAD_DIR || '/opt/youfu/pilot/uploads';
const RUN = process.env.E2E_RUN_ID || `f${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const TENANT = `uat-full-${RUN}`;
const DEPT_CODE = `UAT-${RUN}`;
const CAT_CODE = `uat_full_${RUN}`;
const CAT_NAME = `UAT全流程-${RUN}`;
const SKILL = `uat_full_${RUN}`;
const WORKER_ID = `UAT-W-${RUN}`;
const WORKER_USER = `uat_worker_${RUN}`;
const ADMIN_USER = 'admin';
const PASSWORD = 'Uat' + crypto.randomBytes(8).toString('hex') + '!1';

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
  if (r.status !== 200 || !r.body?.token) throw new Error(`login ${username}@${TENANT} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); };
const expectStatus = (r, code, msg) => assert(r.status === code, `${msg}（期望 ${code}，实际 ${r.status} ${JSON.stringify(r.body)}）`);
const expectStatusIn = (r, codes, msg) => assert(codes.includes(r.status), `${msg}（期望 ${codes.join('/')}，实际 ${r.status} ${JSON.stringify(r.body)}）`);

let adminId = null;
let workerAccountId = null;
let deptId = null;
const orders = [];
let error = null;

async function setupTenant() {
  // 先以真实租户上下文读取富流程定义（RLS 只允许读本租户），再切到 UAT 租户写入。
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id','zixing-hospital',true), set_config('app.scope','system',true)`);
  const srcWf = await db.query(
    `SELECT def, version FROM workflow_def WHERE tenant_id='zixing-hospital' AND entity_type='work_order' ORDER BY version DESC LIMIT 1`,
  );
  await db.query('COMMIT');
  assert(srcWf.rowCount === 1, '真实租户缺少 workflow_def(work_order)');
  const srcDef = srcWf.rows[0].def;
  const srcVersion = srcWf.rows[0].version;

  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  await db.query(
    `INSERT INTO tenant_registry (tenant_id,name,status) VALUES ($1,$2,'active')`,
    [TENANT, `UAT全流程 ${RUN}`],
  );
  const dept = await db.query(
    `INSERT INTO dept (tenant_id,name,code,remark,is_default) VALUES ($1,'UAT后勤',$2,'E2E',$3) RETURNING id`,
    [TENANT, DEPT_CODE, true],
  );
  deptId = dept.rows[0].id;
  const admin = await db.query(
    `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
     VALUES ($1,$2,$3,'UAT管理员','admin',true) RETURNING id`,
    [TENANT, ADMIN_USER, hashPassword(PASSWORD)],
  );
  adminId = admin.rows[0].id;
  const wk = await db.query(
    `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
     VALUES ($1,$2,$3,'UAT师傅','worker',true) RETURNING id`,
    [TENANT, WORKER_USER, hashPassword(PASSWORD)],
  );
  workerAccountId = wk.rows[0].id;
  await db.query(
    `INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id,department_id)
     VALUES ($1,$2,'UAT师傅',$3::text[],0,true,$4,$5)`,
    [WORKER_ID, TENANT, ['repair', SKILL], workerAccountId, deptId],
  );
  await db.query(
    `INSERT INTO fault_category (tenant_id,code,name,business_type,skill_tags,sort,enabled)
     VALUES ($1,$2,$3,'repair',$4::jsonb,1,true)`,
    [TENANT, CAT_CODE, CAT_NAME, JSON.stringify(['repair', SKILL])],
  );
  // 复制真实租户的富流程定义，保证复核/挂起/取消等状态齐全
  const wf = await db.query(
    `INSERT INTO workflow_def (tenant_id,entity_type,def,version,updated_by)
     VALUES ($1,'work_order',$2::jsonb,$3,'e2e')
     RETURNING id`,
    [TENANT, JSON.stringify(srcDef), srcVersion],
  );
  assert(wf.rowCount === 1, '复制 workflow_def 失败');
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

async function cleanupTenant() {
  for (const id of orders) await cleanupOrder(id).catch(() => {});
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  // 该租户只由本脚本创建，按依赖顺序清理
  await db.query(`DELETE FROM notification WHERE tenant_id=$1`, [TENANT]);
  await db.query(`DELETE FROM ticket_event WHERE tenant_id=$1`, [TENANT]);
  await db.query(`DELETE FROM settlement_item WHERE tenant_id=$1`, [TENANT]);
  await db.query(`DELETE FROM settlement WHERE tenant_id=$1`, [TENANT]);
  await db.query(`DELETE FROM domain_event WHERE tenant_id=$1`, [TENANT]);
  await db.query(`DELETE FROM idempotency_key WHERE tenant_id=$1`, [TENANT]);
  await db.query(`DELETE FROM work_orders WHERE tenant_id=$1`, [TENANT]);
  await db.query(`UPDATE worker SET account_id=NULL WHERE tenant_id=$1`, [TENANT]);
  await db.query(`DELETE FROM worker WHERE tenant_id=$1`, [TENANT]);
  await db.query(`DELETE FROM account_user WHERE tenant_id=$1`, [TENANT]);
  await db.query(`DELETE FROM fault_category WHERE tenant_id=$1`, [TENANT]);
  await db.query(`DELETE FROM dept WHERE tenant_id=$1`, [TENANT]);
  await db.query(`DELETE FROM workflow_def WHERE tenant_id=$1`, [TENANT]);
  await db.query(`DELETE FROM tenant_registry WHERE tenant_id=$1`, [TENANT]);
  await db.query('COMMIT');
  try { rmSync(path.join(UPLOAD_ROOT, TENANT), { recursive: true, force: true }); } catch { /* ignore */ }
}

async function publicUpload(bytes, contentType, filename) {
  const base64 = crypto.randomBytes(bytes).toString('base64');
  const r = await request('POST', `/public/upload?org=${encodeURIComponent(TENANT)}`, { filename, contentType, base64 });
  if (r.status !== 201 || !r.body?.url) throw new Error(`upload failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.url;
}

async function transition(id, token, to, fields, label) {
  const r = await request('POST', `/open/work_order/${id}/transition`, { to, ...fields }, token);
  return { r, label };
}

async function main() {
  await db.connect();
  await setupTenant();
  const admin = await login(ADMIN_USER, PASSWORD, 'pc');
  const worker = await login(WORKER_USER, PASSWORD, 'mp');

  // ===== 1. 公开报修（带照片）=====
  const photoUrl = await publicUpload(64 * 1024, 'image/png', 'uat.png');
  const report = await request('POST', '/public/repair-report', {
    org: TENANT,
    name: 'UAT报修人',
    phone: '13800000000',
    location: 'UAT-住院部3楼',
    description: 'UAT 全流程：卫生间水管漏水，请处理',
    category_name: CAT_NAME,
    consent: true,
    attachments: [{ kind: 'image', url: photoUrl, name: 'uat.png', size: 64 * 1024 }],
  });
  expectStatus(report, 201, '公开报修');
  const orderId = report.body.id;
  const orderNo = report.body.order_no;
  const viewToken = report.body.view_token;
  orders.push(orderId);
  assert(report.body.assignee === WORKER_ID, `公开报修应自动派给 UAT 师傅（实际 ${report.body.assignee}）`);
  assert(report.body.status === 'assigned', `公开报修应 assigned（实际 ${report.body.status}）`);
  console.log(`[full] public report ${orderNo} → ${report.body.assignee}`);

  // ===== 2. 公开查询 =====
  const my = await request('GET', `/public/my-reports?org=${encodeURIComponent(TENANT)}&tokens=${encodeURIComponent(viewToken)}`);
  expectStatus(my, 200, '我的报修 token 查询');
  assert((my.body.items || []).some((x) => x.order_no === orderNo), '我的报修应包含该单');
  const pubStatus = await request('GET', `/public/repair-status?org=${encodeURIComponent(TENANT)}&order_no=${encodeURIComponent(orderNo)}`);
  expectStatus(pubStatus, 200, '公开状态查询');
  assert(pubStatus.body.item?.status === 'assigned', '公开状态应为 assigned');

  // ===== 3. 师傅处理 =====
  let r = await request('GET', `/open/work_order/${orderId}`, undefined, worker);
  expectStatus(r, 200, '师傅读工单详情');
  const detailTicket = r.body.ticket || r.body.item;
  assert(detailTicket.assignee_id === WORKER_ID || detailTicket.assignee === WORKER_ID, '师傅详情应显示本人承接');

  for (const [to, label] of [['arrived', '到场'], ['processing', '开始处理']]) {
    const t = await transition(orderId, worker, to, {}, label);
    expectStatus(t.r, 200, `师傅${label}`);
  }

  // 照片/录音/备注
  const workerPhoto = await publicUpload(32 * 1024, 'image/jpeg', 'worker.jpg');
  expectStatus(await request('POST', `/open/work_order/${orderId}/photos`, { photo: workerPhoto, caption: 'UAT现场' }, worker), 200, '关联现场照片');
  const workerVoice = await publicUpload(16 * 1024, 'audio/mpeg', 'worker.mp3');
  expectStatus(await request('POST', `/open/work_order/${orderId}/voice`, { url: workerVoice }, worker), 200, '关联现场录音');
  expectStatus(await request('PATCH', `/open/work_order/${orderId}/ext`, { patch: { feedback_note: 'UAT 已更换水管接头' } }, worker), 200, '保存现场备注');

  // 媒体 token 读取
  const mediaBase = BASE.replace(/\/api\/v1$/, '');
  const photoGet = await request('GET', `${mediaBase}${photoUrl}?token=${encodeURIComponent(viewToken)}`);
  expectStatus(photoGet, 200, '公开照片 token 读取');
  const voiceGet = await request('GET', `${mediaBase}${workerVoice}?token=${encodeURIComponent(viewToken)}`);
  expectStatus(voiceGet, 200, '录音 token 读取');

  // 挂起/恢复
  let t = await transition(orderId, worker, 'suspended', {}, '挂起未填原因');
  expectStatus(t.r, 422, '挂起未填原因应 422');
  t = await transition(orderId, worker, 'suspended', { suspend_reason: 'UAT等待配件' }, '挂起');
  expectStatus(t.r, 200, '挂起');
  t = await transition(orderId, worker, 'processing', {}, '恢复');
  expectStatus(t.r, 200, '恢复');

  // 提交复核 + 越权
  t = await transition(orderId, worker, 'pending_review', {}, '提交复核');
  expectStatus(t.r, 200, '提交复核');
  expectStatus((await transition(orderId, worker, 'review_passed', {}, 'worker 复核通过')).r, 403, 'worker 复核通过应 403');
  expectStatus((await transition(orderId, worker, 'cancelled', { cancel_reason: 'UAT' }, 'worker 取消')).r, 403, 'worker 取消应 403');

  // admin 驳回 → 再提交 → 通过
  expectStatus((await transition(orderId, admin, 'processing', {}, 'admin 驳回')).r, 200, 'admin 驳回');
  expectStatus((await transition(orderId, worker, 'pending_review', {}, '再次提交复核')).r, 200, '再次提交复核');
  expectStatus((await transition(orderId, admin, 'review_passed', {}, 'admin 复核通过')).r, 200, 'admin 复核通过');
  expectStatus((await transition(orderId, admin, 'completed', {}, '完成')).r, 200, '完成');
  expectStatus((await transition(orderId, admin, 'closed', { close_reason: 'UAT关闭' }, '关闭')).r, 200, '关闭');
  expectStatus((await transition(orderId, admin, 'evaluated', { score: 5 }, '评价')).r, 200, '评价');

  // ===== 4. 最终数据核对 =====
  r = await request('GET', `/open/work_order/${orderId}`, undefined, admin);
  expectStatus(r, 200, '最终详情');
  const final = r.body.ticket || r.body.item;
  assert(final.status === 'evaluated', `最终状态 evaluated（实际 ${final.status}）`);
  assert(Number(final.satisfaction_score) === 5, `满意度 5（实际 ${final.satisfaction_score}）`);
  assert(final.department_name === 'UAT后勤', `责任部门 UAT后勤（实际 ${final.department_name}）`);
  assert((final.ext?.attachments || []).length >= 1, 'ext.attachments 应包含公开报修照片');
  assert((final.ext?.photos || []).length >= 1, 'ext.photos 应包含师傅现场照片');
  assert((final.ext?.voice || []).length >= 1, 'ext.voice 应至少 1 条');
  assert(final.ext?.feedback_note === 'UAT 已更换水管接头', '现场备注应落库');

  const events = (r.body.events || []).map((e) => e.type);
  for (const expected of ['create', 'assign', 'transition']) assert(events.includes(expected), `事件应包含 ${expected}`);

  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  const dbNotify = await db.query(
    `SELECT recipient_kind, channel, count(*)::int c FROM notification WHERE tenant_id=$1 AND work_order_id=$2 GROUP BY 1,2`,
    [TENANT, orderId],
  );
  await db.query('COMMIT');
  assert(dbNotify.rows.length > 0, '应有通知记录');

  const pubFinal = await request('GET', `/public/my-reports?org=${encodeURIComponent(TENANT)}&tokens=${encodeURIComponent(viewToken)}`);
  const pubItem = (pubFinal.body.items || []).find((x) => x.order_no === orderNo);
  assert(pubItem && pubItem.status === 'evaluated', '公开我的报修应显示 evaluated');

  console.log(`[full] final ${orderNo} status=evaluated score=5 events=${events.length} notifications=${dbNotify.rows.reduce((s, x) => s + x.c, 0)}`);
  console.log(`[full] PASS tenant=${TENANT} order=${orderNo}`);
}

main()
  .then(async () => { await cleanupTenant(); await db.end(); process.exit(0); })
  .catch(async (e) => {
    error = e;
    console.error('[full] FAILED', e.message);
    await cleanupTenant().catch((ce) => console.error('[full] cleanup failed', ce.message));
    try { await db.end(); } catch { /* ignore */ }
    process.exit(1);
  });
