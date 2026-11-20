// 试点媒体回环 E2E（真实公网 URL + nginx + 后端 + 上传鉴权）
//
// 覆盖 2026-11-10 现场故障：
//   1. 照片上传 413（nginx/Express 请求体上限）
//   2. 录音/照片读取 401（uploads view_token 只认 attachments，不认 photos/voice）
//   3. 现场备注 403（PATCH /ext 只允许 ticket.manage）
//   4. 非承接人越权改备注
//   5. 图片 5MB 后端上限边界
//
// 运行（ECS）：
//   cd /opt/youfu/pilot/backend
//   PGDATABASE=youfu_pilot ENV_FILE=.env \
//     /opt/node16/bin/node pilot-media-e2e.mjs
//
// 默认走公网 https://youfu.banerz.cn/pilot，确保 nginx 也被覆盖。
// 本机调试可设 PILOT_PUBLIC_BASE=http://127.0.0.1:4101。
//
// 安全：临时师傅账号无微信 openid；不上传真实照片；测试结束删除工单、文件、账号。
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;
const TENANT = process.env.PILOT_TENANT || 'zixing-hospital';
const PUBLIC_BASE = (process.env.PILOT_PUBLIC_BASE || 'https://youfu.banerz.cn/pilot').replace(/\/+$/, '');
const API = `${PUBLIC_BASE}/api/v1`;
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/opt/youfu/pilot/uploads';
const RUN = process.env.E2E_RUN_ID || `m${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const ID_A = `E2E-MEDIA-A-${RUN}`;
const ID_B = `E2E-MEDIA-B-${RUN}`;
const SKILL_A = `e2e_media_a_${RUN}`;
const SKILL_B = `e2e_media_b_${RUN}`;
const USER_A = `e2e_media_a_${RUN}`;
const USER_B = `e2e_media_b_${RUN}`;

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

function request(method, url, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const u = new URL(url);
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
        const buf = Buffer.concat(chunks);
        const ct = res.headers['content-type'] || '';
        let parsed = null;
        if (ct.includes('application/json')) {
          try { parsed = JSON.parse(buf.toString('utf8')); } catch { parsed = { raw: buf.toString('utf8') }; }
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, bytes: buf.length });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function login(username, password, channel) {
  const r = await request('POST', `${API}/auth/login`, { username, password, tenant: TENANT, channel });
  if (r.status !== 200 || !r.body?.token) throw new Error(`login ${username} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); };
const expectStatus = (r, code, msg) => assert(r.status === code, `${msg}（期望 ${code}，实际 ${r.status} ${JSON.stringify(r.body)}）`);
const expectStatusIn = (r, codes, msg) => assert(codes.includes(r.status), `${msg}（期望 ${codes.join('/')}，实际 ${r.status} ${JSON.stringify(r.body)}）`);

const orders = [];
const uploaded = [];
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
    [TENANT, USER_A, hashPassword(PASS), 'E2E媒体A'],
  );
  const b = await db.query(
    `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
     VALUES ($1,$2,$3,$4,'worker',true) RETURNING id`,
    [TENANT, USER_B, hashPassword(PASS), 'E2E媒体B'],
  );
  accA = a.rows[0].id;
  accB = b.rows[0].id;
  await db.query(
    `INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id,department_id)
     VALUES ($1,$2,'E2E媒体A',$3::text[],0,true,$4,$5)`,
    [ID_A, TENANT, ['repair', SKILL_A], accA, dept.rows[0].id],
  );
  await db.query(
    `INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id,department_id)
     VALUES ($1,$2,'E2E媒体B',$3::text[],0,true,$4,$5)`,
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
  for (const url of uploaded) {
    const rel = url.replace(/^\/uploads\//, '');
    const p = path.join(UPLOAD_DIR, rel);
    try { unlinkSync(p); } catch { /* ignore */ }
  }
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

async function upload(bytes, contentType, filename) {
  const base64 = crypto.randomBytes(bytes).toString('base64');
  const r = await request('POST', `${API}/public/upload?org=${TENANT}`, { filename, contentType, base64 });
  if (r.status === 201 && r.body?.url) uploaded.push(r.body.url);
  return r;
}

async function main() {
  await db.connect();
  await setup();
  const admin = await login(process.env.admin_user || 'admin', process.env.admin_password, 'pc');
  const workerA = await login(USER_A, PASS, 'mp');
  const workerB = await login(USER_B, PASS, 'mp');

  // 建单并派给 E2E A（唯一技能标签，避免命中真实师傅）
  const id = crypto.randomUUID();
  orders.push(id);
  const create = await request('POST', `${API}/open/work_order`, {
    id,
    business_type: 'repair',
    catalog: 'hosp_water',
    title: '媒体回环自动化测试',
    description: '自动化媒体回环测试，请忽略',
    location: '后勤设备科',
    reporter_name: 'E2E',
    priority: 'normal',
    skill_tags: [SKILL_A],
    ext: { e2e_media: RUN },
  }, admin);
  assert([200, 201].includes(create.status), `建单 HTTP ${create.status} ${JSON.stringify(create.body)}`);
  if (create.body.assignee !== ID_A) {
    const fwd = await request('POST', `${API}/open/work_order/${id}/transition`, { to: 'assigned', assignee: ID_A }, admin);
    assert(fwd.status === 200, `改派给 E2E A HTTP ${fwd.status} ${JSON.stringify(fwd.body)}`);
  }

  // 1MB 图片：走公网 nginx → 后端 → 落盘 → 关联工单
  const img1 = await upload(1024 * 1024, 'image/jpeg', 'e2e-1mb.jpg');
  expectStatus(img1, 201, '1MB 图片上传');
  const photo = await request('POST', `${API}/open/work_order/${id}/photos`, { photo: img1.body.url, caption: 'E2E 1MB' }, workerA);
  expectStatus(photo, 200, '关联 1MB 照片');

  // 4.5MB 图片：旧 nginx 1MB 限制下必 413，现在应 201
  const img45 = await upload(Math.floor(4.5 * 1024 * 1024), 'image/jpeg', 'e2e-4.5mb.jpg');
  expectStatus(img45, 201, '4.5MB 图片上传（nginx body limit）');

  // 5MB+1：后端业务上限应 413 TOO_LARGE，而不是 nginx 413
  const imgOver = await upload(5 * 1024 * 1024 + 1, 'image/jpeg', 'e2e-over.jpg');
  expectStatus(imgOver, 413, '5MB+1 图片应被后端上限拒绝');
  assert(imgOver.body?.code === 'TOO_LARGE', `5MB+1 错误码应为 TOO_LARGE（实际 ${imgOver.body?.code}）`);

  // 1MB 录音 → 关联
  const audio = await upload(1024 * 1024, 'audio/mpeg', 'e2e-1mb.mp3');
  expectStatus(audio, 201, '1MB 录音上传');
  const voice = await request('POST', `${API}/open/work_order/${id}/voice`, { url: audio.body.url }, workerA);
  expectStatus(voice, 200, '关联 1MB 录音');

  // 读取 token
  const detail = await request('GET', `${API}/open/work_order/${id}`, undefined, admin);
  expectStatus(detail, 200, '管理员读取工单');
  const ticket = detail.body.ticket || detail.body.item || detail.body;
  const token = ticket.ext?.public_view_token;
  assert(typeof token === 'string' && token.length > 0, '工单缺少 public_view_token');

  const photoUrl = `${PUBLIC_BASE}${img1.body.url}?token=${encodeURIComponent(token)}`;
  const photoGet = await request('GET', photoUrl);
  expectStatus(photoGet, 200, '照片 + token 读取');
  assert(String(photoGet.headers['content-type']).includes('image/jpeg'), `照片 Content-Type 应为 image/jpeg（实际 ${photoGet.headers['content-type']}）`);

  const voiceUrl = `${PUBLIC_BASE}${audio.body.url}?token=${encodeURIComponent(token)}`;
  const voiceGet = await request('GET', voiceUrl);
  expectStatus(voiceGet, 200, '录音 + token 读取');
  assert(String(voiceGet.headers['content-type']).includes('audio/mpeg'), `录音 Content-Type 应为 audio/mpeg（实际 ${voiceGet.headers['content-type']}）`);

  expectStatus(await request('GET', `${PUBLIC_BASE}${audio.body.url}`), 401, '录音无 token 应 401');
  expectStatus(await request('GET', `${PUBLIC_BASE}${audio.body.url}?token=wrong-token`), 401, '录音错误 token 应 401');

  // 现场备注：承接人 200，非承接人拒绝，非白名单字段 403
  const note = await request('PATCH', `${API}/open/work_order/${id}/ext`, { patch: { feedback_note: 'E2E 媒体回环备注' } }, workerA);
  expectStatus(note, 200, '承接人保存备注');
  const illegal = await request('PATCH', `${API}/open/work_order/${id}/ext`, { patch: { evil_key: 'x' } }, workerA);
  expectStatus(illegal, 403, '承接人改非白名单字段');
  const other = await request('PATCH', `${API}/open/work_order/${id}/ext`, { patch: { feedback_note: 'B 越权' } }, workerB);
  expectStatusIn(other, [403, 404], '非承接人保存备注');

  console.log(`[media-e2e] PASS run=${RUN} uploads=${uploaded.length} photos=1 voice=1`);
}

main()
  .then(async () => { await cleanup(); await db.end(); process.exit(0); })
  .catch(async (e) => {
    console.error('[media-e2e] FAILED', e.message);
    await cleanup().catch(() => {});
    try { await db.end(); } catch { /* ignore */ }
    process.exit(1);
  });
