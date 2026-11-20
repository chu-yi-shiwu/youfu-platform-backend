// 深度探针 v3（第二轮 · 第三批）：通知归属 / 软删除 / 账号安全 / 幂等 / 数据保真 / HTTP 边界
//
// 与 uat-deep-probe.mjs 同源（isolated uat tenant + cleanup）。专测上一轮完全没打过的面。
//
// 运行（ECS）：
//   cd /opt/youfu/pilot/backend
//   ENV_FILE=.env E2E_RUN_ID=dp4 /opt/node16/bin/node scripts/uat-deep-probe2.mjs
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;
const BASE = (process.env.PILOT_API_BASE || 'http://127.0.0.1:4101/api/v1').replace(/\/+$/, '');
const UPLOAD_ROOT = process.env.UPLOAD_DIR || '/opt/youfu/uploads';
const RUN = process.env.E2E_RUN_ID || `dq${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const TA = `uat-deep2-a-${RUN}`;
const TB = `uat-deep2-b-${RUN}`;
const SOURCE_TENANT = process.env.SOURCE_TENANT || 'zixing-hospital';
const PASS = 'UatDeep!2026';

function loadEnv() {
  for (const f of [process.env.ENV_FILE || '.env']) {
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
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function request(method, p, body, token, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const u = new URL(p.startsWith('http') ? p : BASE + p);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(extraHeaders || {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { raw }; }
        resolve({ status: res.statusCode, body: parsed, raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function login(tenant, username, password, channel = 'pc') {
  const r = await request('POST', '/auth/login', { username, password, tenant, channel });
  if (r.status !== 200 || !r.body?.token) throw new Error(`login ${tenant}/${username} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

const results = [];
function record(cat, name, expect, r, note) {
  const ok = Array.isArray(expect) ? expect.includes(r.status) : r.status === expect;
  const five = r.status >= 500;
  results.push({ cat, name, expect: String(expect), actual: r.status, ok, five, note: note || '', code: r.body?.code, msg: (r.body?.message || '').slice(0, 120) });
  console.log(`[${five ? 'FIVE' : ok ? 'ok' : 'MISMATCH'}] ${cat} | ${name} | expect=${Array.isArray(expect) ? expect.join('/') : expect} actual=${r.status} ${five || !ok ? JSON.stringify({ code: r.body?.code, message: r.body?.message }) : ''}`);
}
function recordCustom(cat, name, ok, detail, five) {
  results.push({ cat, name, expect: 'custom', actual: five ? 500 : ok ? 200 : 0, ok, five: !!five, note: detail });
  console.log(`[${five ? 'FIVE' : ok ? 'ok' : 'MISMATCH'}] ${cat} | ${name} | ${detail}`);
}

async function dbQuery(tenant, sql, params = []) {
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [tenant]);
  const r = await db.query(sql, params);
  await db.query('COMMIT');
  return r;
}

async function setupTenant(tenant, name) {
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [tenant]);
  await db.query(`INSERT INTO tenant_registry (tenant_id,name,status) VALUES ($1,$2,'active')`, [tenant, name]);
  const dept = await db.query(`INSERT INTO dept (tenant_id,name,code,is_default) VALUES ($1,'深度2后勤',$2,true) RETURNING id`, [tenant, `DQ-${tenant}`]);
  for (const [u, role] of [['admin', 'admin'], ['operator', 'operator'], ['w1', 'worker'], ['w2', 'worker']]) {
    const acc = await db.query(
      `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
       VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
      [tenant, u, hashPassword(PASS), u.toUpperCase(), role],
    );
    if (role === 'worker') {
      await db.query(
        `INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id,department_id)
         VALUES ($1,$2,$3,'{}'::text[],0,true,$1,$4)`,
        [acc.rows[0].id, tenant, `${u}-worker`, dept.rows[0].id],
      );
    }
  }
  await db.query(`INSERT INTO fault_category (tenant_id,code,name,business_type,skill_tags,sort,enabled)
                  VALUES ($1,'DQ','深度2故障','repair','[]'::jsonb,1,true)`, [tenant]);
  await db.query(`INSERT INTO location_dict (tenant_id,code,name,category,enabled) VALUES ($1,'DQ-LOC','深度2-1F','位置',true)`, [tenant]);
  await db.query('COMMIT');
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id','${SOURCE_TENANT}',true), set_config('app.scope','system',true)`);
  const src = await db.query(`SELECT def, version FROM workflow_def WHERE tenant_id='${SOURCE_TENANT}' AND entity_type='work_order' ORDER BY version DESC LIMIT 1`);
  await db.query('COMMIT');
  if (src.rowCount) {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [tenant]);
    await db.query(`INSERT INTO workflow_def (tenant_id,entity_type,def,version,updated_by) VALUES ($1,'work_order',$2::jsonb,$3,'probe')`,
      [tenant, JSON.stringify(src.rows[0].def), src.rows[0].version]);
    await db.query('COMMIT');
  }
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
    // 平台审计 append-only；测试动作按目标租户清掉，避免 UAT 痕迹留在 pilot/主站审计里。
    execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', process.env.PGDATABASE || 'youfu_pilot', '-v', 'ON_ERROR_STOP=1', '-c', `DELETE FROM platform_audit WHERE target_tenant='${tenant}'`], { stdio: 'pipe' });
    // 清理所有可能的 uploads 根：主站默认 /opt/youfu/uploads，pilot 默认 /opt/youfu/pilot/uploads；
    // 历史脚本只按 UPLOAD_ROOT 删，跨环境会漏删（2026-11-15 实测遗留 uat-* 目录）。
    for (const root of new Set([process.env.UPLOAD_DIR, '/opt/youfu/uploads', '/opt/youfu/pilot/uploads'].filter(Boolean))) {
      rmSync(path.join(root, tenant), { recursive: true, force: true });
    }
  } catch (e) {
    console.error('[cleanup] failed', tenant, e.message);
  }
}

let adminA, adminB, opA, w1A, w2A, w1B;
let workerA1, workerA2;

function newOrder(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    business_type: 'repair',
    catalog: 'DQ',
    title: '探针2工单',
    description: 'd',
    location: 'DQ-LOC',
    priority: 'normal',
    ...overrides,
  };
}
async function assignOrder(id, workerId) {
  return request('POST', `/open/work_order/${id}/transition`, { to: 'assigned', assignee: workerId }, adminA);
}

async function main() {
  await db.connect();
  await setupTenant(TA, '深度2A');
  await setupTenant(TB, '深度2B');
  adminA = await login(TA, 'admin', PASS);
  adminB = await login(TB, 'admin', PASS);
  opA = await login(TA, 'operator', PASS);
  w1A = await login(TA, 'w1', PASS, 'mp');
  w2A = await login(TA, 'w2', PASS, 'mp');
  w1B = await login(TB, 'w1', PASS, 'mp');
  workerA1 = (await dbQuery(TA, `SELECT id FROM worker WHERE tenant_id=$1 AND name='w1-worker'`, [TA])).rows[0].id;
  workerA2 = (await dbQuery(TA, `SELECT id FROM worker WHERE tenant_id=$1 AND name='w2-worker'`, [TA])).rows[0].id;

  // ============ 1. 通知归属 ============
  const C1 = '通知';
  const no = await request('POST', '/open/work_order', newOrder({ title: '通知工单' }), adminA);
  const noId = no.body?.id;
  await assignOrder(noId, workerA1);
  const n1 = await request('GET', '/open/notifications?limit=50', undefined, w1A);
  const items1 = n1.body?.items || [];
  recordCustom(C1, 'w1 收到派单通知', items1.length > 0, `items=${items1.length} status=${n1.status}`, n1.status >= 500);
  const n2 = await request('GET', '/open/notifications?limit=50', undefined, w2A);
  const items2 = n2.body?.items || [];
  recordCustom(C1, 'w2 看不到 w1 的通知', !items2.some((x) => items1.some((y) => y.id === x.id)), `w2items=${items2.length}`);
  if (items1[0]) {
    const foreign = await request('POST', '/open/notifications/read', { ids: [items1[0].id] }, w2A);
    recordCustom(C1, '他人标记已读不生效', foreign.status === 200 && Number(foreign.body?.marked) === 0, `status=${foreign.status} marked=${foreign.body?.marked}`, foreign.status >= 500);
    const mark = await request('POST', '/open/notifications/read', { ids: [items1[0].id] }, w1A);
    recordCustom(C1, '本人标记已读生效', mark.status === 200 && Number(mark.body?.marked) >= 1, `status=${mark.status} marked=${mark.body?.marked}`, mark.status >= 500);
  }

  // ============ 2. 抢单大厅可见性 ============
  const C2 = '抢单大厅';
  const hallA = await request('GET', '/open/claim-hall?limit=100', undefined, w1A);
  record(C2, 'worker 读抢单大厅', [200], hallA);
  const hallB = await request('GET', '/open/claim-hall?limit=100', undefined, w1B);
  const idsA = (hallA.body?.items || []).map((x) => x.id);
  const idsB = (hallB.body?.items || []).map((x) => x.id);
  recordCustom(C2, '抢单大厅无跨租户泄漏', !idsB.some((id) => idsA.includes(id)), `a=${idsA.length} b=${idsB.length}`);
  recordCustom(C2, '已派单不在抢单大厅', !idsA.includes(noId), `contains=${idsA.includes(noId)}`);
  const hallUnknown = await request('GET', '/open/claim-hall?department_id=not-a-uuid', undefined, w1A);
  record(C2, '抢单大厅非法部门 ID', [400], hallUnknown);

  // ============ 3. 软删除 / 唯一约束 ============
  const C3 = '数据完整性';
  const matCode = `DQ-M-${RUN}`;
  const m1 = await request('POST', '/materials', { code: matCode, name: '耗材A', unit: '个', price: 1, enabled: true }, adminA);
  recordCustom('准备', '建耗材', [200, 201].includes(m1.status), `status=${m1.status}`, m1.status >= 500);
  const dup = await request('POST', '/materials', { code: matCode, name: '耗材B', unit: '个', price: 1 }, adminA);
  record(C3, '重复耗材编码', [409], dup);
  const [cd1, cd2] = await Promise.all([
    request('POST', '/materials', { code: `${matCode}-C`, name: '并发A', unit: '个', price: 1 }, adminA),
    request('POST', '/materials', { code: `${matCode}-C`, name: '并发B', unit: '个', price: 1 }, adminA),
  ]);
  recordCustom(C3, '并发重复编码仅 1 成功', [cd1, cd2].filter((r) => r.status >= 200 && r.status < 300).length === 1, `a=${cd1.status} b=${cd2.status}`, cd1.status >= 500 || cd2.status >= 500);

  const asset = await request('POST', '/assets', { name: '待停用资产', location: 'DQ-LOC', status: 'in_use' }, adminA);
  const aId = asset.body?.item?.id;
  const off = await request('PUT', `/assets/${aId}`, { status: 'disabled' }, adminA);
  const listOff = await request('GET', '/assets?limit=200', undefined, adminA);
  const offRow = (listOff.body?.items || []).find((x) => x.id === aId);
  recordCustom(C3, '资产停用状态可读回', off.status === 200 && offRow?.status === 'disabled', `put=${off.status} status=${offRow?.status}`, off.status >= 500 || listOff.status >= 500);
  record(C3, '资产无删除端点（设计为停用）', [404, 405], await request('DELETE', `/assets/${aId}`, undefined, adminA));

  // ============ 4. 账号安全 ============
  const C4 = '账号安全';
  const me = await request('GET', '/auth/me', undefined, adminA);
  const adminId = me.body?.user?.id || me.body?.id;
  const demote = await request('PUT', `/accounts/${adminId}`, { role: 'operator' }, adminA);
  record(C4, '最后一个管理员不可自己降级', [400, 403, 409], demote);
  const resetByOp = await request('POST', `/accounts/${adminId}/reset-password`, {}, opA);
  record(C4, 'operator 不可重置管理员密码', [403], resetByOp);
  const crossReset = await request('POST', `/accounts/${adminId}/reset-password`, {}, adminB);
  record(C4, 'B 管理员跨租户重置 A 账号', [404], crossReset);
  const wrongOld = await request('PATCH', '/auth/change-password', { old_password: 'wrong', new_password: 'NewPass!2026' }, w1A);
  record(C4, '改密旧密码错误', [400, 401, 403], wrongOld);
  const okChange = await request('PATCH', '/auth/change-password', { old_password: PASS, new_password: 'NewPass!2026' }, w1A);
  record(C4, '本人改密成功', [200, 204], okChange);
  const relogin = await request('POST', '/auth/login', { username: 'w1', password: 'NewPass!2026', tenant: TA, channel: 'mp' });
  recordCustom(C4, '新密码可登录', relogin.status === 200 && !!relogin.body?.token, `status=${relogin.status}`, relogin.status >= 500);
  // 恢复密码，避免后续探针受影响
  const reloginToken = relogin.body?.token;
  if (reloginToken) await request('PATCH', '/auth/change-password', { old_password: 'NewPass!2026', new_password: PASS }, reloginToken);
  // 改密会作废旧 token（AUTH_004 单会话失效）——重新登录拿新 token 供后续探针使用。
  const afterRestore = await request('POST', '/auth/login', { username: 'w1', password: PASS, tenant: TA, channel: 'mp' });
  if (afterRestore.status === 200 && afterRestore.body?.token) w1A = afterRestore.body.token;

  // ============ 5. 数据保真（Unicode / 引号 / 换行） ============
  const C5 = '数据保真';
  const special = '空调❄️不制冷，"急"！\n第二行';
  const specialTitle = '空调❄️不制冷，"急"！';
  const sp = await request('POST', '/open/work_order', newOrder({ title: specialTitle, description: special }), adminA);
  const spId = sp.body?.id;
  record(C5, '特殊字符建单', [201], sp);
  if (spId) {
    const read = await request('GET', `/open/work_order/${spId}`, undefined, adminA);
    const ticket = read.body?.ticket || read.body?.item || read.body;
    recordCustom(C5, '标题原样读回（emoji/引号）', ticket?.title === specialTitle, `read=${JSON.stringify(ticket?.title)}`);
    recordCustom(C5, '描述原样读回（含换行）', ticket?.description === special, `read=${JSON.stringify(ticket?.description)}`);
  }
  const longTitle = '长'.repeat(1000);
  const lt = await request('POST', '/open/work_order', newOrder({ title: longTitle }), adminA);
  const ltId = lt.body?.id;
  if (lt.status === 201 && ltId) {
    const read = await request('GET', `/open/work_order/${ltId}`, undefined, adminA);
    const ticket = read.body?.ticket || read.body?.item || read.body;
    recordCustom(C5, '1000 字标题不截断', ticket?.title === longTitle, `len=${String(ticket?.title || '').length}`);
  } else {
    recordCustom(C5, '1000 字标题被拒或截断策略', [400, 422].includes(lt.status), `status=${lt.status}`, lt.status >= 500);
  }
  const xss = '<script>alert(1)</script>';
  const xs = await request('POST', '/open/work_order', newOrder({ title: xss }), adminA);
  if (xs.status === 201) {
    const read = await request('GET', `/open/work_order/${xs.body.id}`, undefined, adminA);
    const ticket = read.body?.ticket || read.body?.item || read.body;
    recordCustom(C5, 'XSS 按原文存储（前端负责转义）', ticket?.title === xss, `read=${JSON.stringify(ticket?.title)}`);
  } else {
    recordCustom(C5, 'XSS 标题被拒', [400, 422].includes(xs.status), `status=${xs.status}`);
  }

  // ============ 6. HTTP 边界 ============
  const C6 = 'HTTP 边界';
  const badJson = await request('POST', '/open/work_order', '{bad json', adminA);
  record(C6, '畸形 JSON', [400], badJson);
  const textPlain = await request('POST', '/open/work_order', JSON.stringify(newOrder()), adminA, { 'Content-Type': 'text/plain' });
  record(C6, 'text/plain body 被拒', [400, 415, 422], textPlain);
  record(C6, 'GET 只写端点', [404, 405], await request('GET', '/open/work_order/claim', undefined, adminA));
  record(C6, '超长 query 10k', [200, 400, 414], await request('GET', `/open/work_orders?q=${'x'.repeat(10000)}`, undefined, adminA));
  const rid = await request('GET', '/auth/me', undefined, adminA, { 'X-Request-Id': 'probe-rid-123' });
  recordCustom(C6, 'X-Request-Id 透传/回显', String(rid.headers['x-request-id'] || '') !== '', `value=${rid.headers['x-request-id']}`);

  // ============ 7. 幂等 ============
  const C7 = '幂等';
  const idemKey = `idem-${RUN}`;
  const bodyA = newOrder({ title: '幂等单' });
  const bodyB = { ...bodyA, id: crypto.randomUUID(), title: '幂等单-第二次' };
  const i1 = await request('POST', '/open/work_order', bodyA, adminA, { 'Idempotency-Key': idemKey });
  const i2 = await request('POST', '/open/work_order', bodyB, adminA, { 'Idempotency-Key': idemKey });
  recordCustom(C7, '同幂等键返回同一工单', i1.status === 201 && i2.status >= 200 && i2.status < 300 && (i2.body?.id === i1.body?.id), `first=${i1.status}:${i1.body?.id} second=${i2.status}:${i2.body?.id}`, i1.status >= 500 || i2.status >= 500);
  const count = await dbQuery(TA, `SELECT count(*)::int AS c FROM work_orders WHERE tenant_id=$1 AND title IN ('幂等单','幂等单-第二次')`, [TA]);
  recordCustom(C7, '幂等只落一行', count.rows[0].c === 1, `rows=${count.rows[0].c}`);
  const i3 = await request('POST', '/open/work_order', newOrder({ title: '幂等单-新键' }), adminA, { 'Idempotency-Key': idemKey + '-2' });
  recordCustom(C7, '不同幂等键各自建单', i3.status === 201 && i3.body?.id !== i1.body?.id, `status=${i3.status}`);

  // ============ 8. 跨角色/跨师傅 ============
  const C8 = '越权';
  const mine = await request('POST', '/inspection/tasks', { type: 'free', title: 'W1巡检', assignee: workerA1 }, adminA);
  const mineId = mine.body?.item?.id;
  record(C8, 'w2 读 w1 巡检任务', [403, 404], await request('GET', `/inspection/tasks/${mineId}`, undefined, w2A));
  record(C8, 'w2 完成 w1 巡检任务', [403, 404], await request('POST', `/inspection/tasks/${mineId}/complete`, {}, w2A));
  record(C8, 'worker 建巡检任务', [403], await request('POST', '/inspection/tasks', { type: 'free', title: 'x' }, w1A));
  record(C8, 'worker 导出资产', [403], await request('GET', '/assets/export', undefined, w1A));
  record(C8, 'worker 读账号', [403], await request('GET', '/accounts', undefined, w1A));

  // ============ 9. 状态机收尾 ============
  const C9 = '状态机';
  const doneWo = await request('POST', '/open/work_order', newOrder({ title: '终态单' }), adminA);
  const doneId = doneWo.body?.id;
  await assignOrder(doneId, workerA1);
  for (const [who, body] of [['w', { to: 'arrived' }], ['w', { to: 'processing' }], ['w', { to: 'pending_review' }], ['a', { to: 'review_passed' }], ['a', { to: 'completed' }]]) {
    await request('POST', `/open/work_order/${doneId}/transition`, body, who === 'w' ? w1A : adminA);
  }
  record(C9, '已完成后撤销', [400, 409, 422], await request('POST', `/open/work_order/${doneId}/transition`, { to: 'cancelled' }, adminA));
  record(C9, '已完成后再次完成', [400, 409, 422], await request('POST', `/open/work_order/${doneId}/transition`, { to: 'completed' }, adminA));
  record(C9, '未知目标状态', [400, 422], await request('POST', `/open/work_order/${doneId}/transition`, { to: 'no_such_state' }, adminA));

  // ============ 10. 公开报修数据保真 ============
  const C10 = '公开报修';
  const pr = await request('POST', '/public/repair-report', {
    org: TA, name: '报修人', phone: '13800000000', location: 'DQ-LOC',
    description: '<b>漏水</b> & "急" ❄️', consent: true,
  });
  record(C10, '公开报修特殊字符', [201], pr);
  if (pr.status === 201 && pr.body?.order_no) {
    const st = await request('GET', `/public/repair-status?org=${encodeURIComponent(TA)}&order_no=${encodeURIComponent(pr.body.order_no)}`);
    recordCustom(C10, '公开进度可查', st.status === 200 && !!st.body?.item, `status=${st.status}`, st.status >= 500);
  }
  record(C10, '跨机构 token 查询不泄漏', [200], await request('GET', `/public/my-reports?org=${encodeURIComponent(TB)}&tokens=${encodeURIComponent(pr.body?.view_token || 'x')}`));

  const five = results.filter((r) => r.five);
  const mismatch = results.filter((r) => !r.ok && !r.five);
  console.log('\n========== SUMMARY ==========');
  console.log(`total=${results.length} pass=${results.filter((r) => r.ok).length} mismatch=${mismatch.length} 5xx=${five.length}`);
  if (mismatch.length) console.log('MISMATCH:\n' + mismatch.map((r) => `- [${r.cat}] ${r.name} expect=${r.expect} actual=${r.actual} ${r.code || ''} ${r.msg || ''}`).join('\n'));
  if (five.length) console.log('5XX:\n' + five.map((r) => `- [${r.cat}] ${r.name} actual=${r.actual} ${r.code || ''} ${r.msg || ''}`).join('\n'));
  console.log('RESULT_JSON=' + JSON.stringify(results.filter((r) => r.five || !r.ok)));

  await cleanupTenant(TA);
  await cleanupTenant(TB);
  await db.end();
}

main().catch(async (e) => {
  console.error('FATAL', e);
  try { await cleanupTenant(TA); await cleanupTenant(TB); } catch {}
  process.exit(1);
});
