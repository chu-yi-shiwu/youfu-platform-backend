// 深度探针 v2（第二轮 · 查漏补缺）：异常输入 / 越权 / 租户隔离 / 并发 / 上传 / CSV / 状态机
//
// 目标：不复跑 happy path，专挑上一轮没打的边界；任何用户输入导致 5xx 即缺陷。
//
// 运行（ECS）：
//   cd /opt/youfu/pilot/backend
//   ENV_FILE=.env E2E_RUN_ID=dp2 /opt/node16/bin/node scripts/uat-deep-probe.mjs
//
// 完全隔离：创建 uat-deep-a-<run> / uat-deep-b-<run>，结束按 tenant_id 清理。
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import pg from 'pg';

const { Client } = pg;
const BASE = (process.env.PILOT_API_BASE || 'http://127.0.0.1:4101/api/v1').replace(/\/+$/, '');
const ROOT_BASE = BASE.replace(/\/api\/v1$/, '');
const UPLOAD_ROOT = process.env.UPLOAD_DIR || '/opt/youfu/uploads';
const RUN = process.env.E2E_RUN_ID || `dp${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const TA = `uat-deep-a-${RUN}`;
const TB = `uat-deep-b-${RUN}`;
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
  const cookie = (r.headers['set-cookie'] || []).map((c) => String(c).split(';')[0]).join('; ');
  return { token: r.body.token, cookie };
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
  const dept = await db.query(`INSERT INTO dept (tenant_id,name,code,is_default) VALUES ($1,'深度后勤',$2,true) RETURNING id`, [tenant, `DP-${tenant}`]);
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
                  VALUES ($1,'DPCAT','深度故障','repair','[]'::jsonb,1,true)`, [tenant]);
  await db.query(`INSERT INTO location_dict (tenant_id,code,name,category,enabled) VALUES ($1,'DP-LOC','深度1F','位置',true)`, [tenant]);
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
let cookieA = '';
let workerA1 = '';

/** 每次建单用新 UUID（复用同一 id 会撞主键 → 误报 409）。 */
function newOrder(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    business_type: 'repair',
    catalog: 'DPCAT',
    title: '探针工单',
    description: 'd',
    location: 'DP-LOC',
    priority: 'normal',
    ...overrides,
  };
}

/** 把工单推进到 completed（用于结算类探针）。 */
async function completeOrder(id) {
  const steps = [
    ['admin', { to: 'assigned', assignee: workerA1 }],
    ['worker', { to: 'arrived' }],
    ['worker', { to: 'processing' }],
    ['worker', { to: 'pending_review' }],
    ['admin', { to: 'review_passed' }],
    ['admin', { to: 'completed' }],
  ];
  for (const [who, body] of steps) {
    const r = await request('POST', `/open/work_order/${id}/transition`, body, who === 'worker' ? w1A : adminA);
    if (r.status < 200 || r.status >= 300) return { ok: false, status: r.status, body: r.body };
  }
  return { ok: true };
}

async function main() {
  await db.connect();
  await setupTenant(TA, '深度探针A');
  await setupTenant(TB, '深度探针B');
  const la = await login(TA, 'admin', PASS); adminA = la.token; cookieA = la.cookie;
  adminB = (await login(TB, 'admin', PASS)).token;
  opA = (await login(TA, 'operator', PASS)).token;
  w1A = (await login(TA, 'w1', PASS, 'mp')).token;
  w2A = (await login(TA, 'w2', PASS, 'mp')).token;
  w1B = (await login(TB, 'w1', PASS, 'mp')).token;
  workerA1 = (await dbQuery(TA, `SELECT id FROM worker WHERE tenant_id=$1 AND name='w1-worker'`, [TA])).rows[0].id;

  // ============ 1. 认证 ============
  const C1 = '认证';
  record(C1, '登录空 body', [400, 401, 422], await request('POST', '/auth/login', {}));
  record(C1, '登录密码错误', [401], await request('POST', '/auth/login', { username: 'admin', password: 'bad', tenant: TA }));
  record(C1, '登录 SQL 注入 user', [400, 401, 422], await request('POST', '/auth/login', { username: "' OR '1'='1", password: 'x', tenant: TA }));
  record(C1, '登录不存在租户', [401, 403, 404], await request('POST', '/auth/login', { username: 'admin', password: PASS, tenant: 'no-such-tenant' }));
  record(C1, 'me 无 token', [401], await request('GET', '/auth/me'));
  record(C1, 'me token 篡改', [401], await request('GET', '/auth/me', undefined, adminA.slice(0, -3) + 'abc'));
  record(C1, 'worker 读账号列表', [403], await request('GET', '/accounts', undefined, w1A));
  record(C1, 'operator 建账号', [403], await request('POST', '/accounts', { username: 'x1', password: '123456', role: 'admin' }, opA));
  record(C1, 'worker 建账号', [403], await request('POST', '/accounts', { username: 'x2', password: '123456', role: 'admin' }, w1A));

  // ============ 2. 输入健壮性（本轮新修复的重点） ============
  const C2 = '输入健壮性';
  record(C2, '建单空 body', [400, 422], await request('POST', '/open/work_order', {}, adminA));
  record(C2, '建单仅 title', [400, 422], await request('POST', '/open/work_order', { title: 'x' }, adminA));
  record(C2, '建单 title 含 NUL', [400, 422], await request('POST', '/open/work_order', newOrder({ title: 'a\u0000b' }), adminA));
  record(C2, '建单 title 100k 字符', [400, 413, 422, 201], await request('POST', '/open/work_order', newOrder({ title: 'x'.repeat(100000) }), adminA));
  record(C2, '建单 title 为对象', [400, 422], await request('POST', '/open/work_order', newOrder({ title: { a: 1 } }), adminA));
  record(C2, '建单 business_type 非法枚举', [400, 422, 201], await request('POST', '/open/work_order', newOrder({ business_type: 'not_a_type' }), adminA));
  record(C2, '建单 ext 超深嵌套', [400, 422, 201], await request('POST', '/open/work_order', newOrder({ ext: JSON.parse('{"a":'.repeat(200) + '1' + '}'.repeat(200)) }), adminA));
  const matBase = { code: `DP-M-${RUN}`, name: '深度耗材', unit: '个', price: 1, enabled: true };
  record(C2, '建耗材空 body', [400, 422], await request('POST', '/materials', {}, adminA));
  record(C2, '建耗材 code 500 字符', [400, 422, 201], await request('POST', '/materials', { ...matBase, code: 'M'.repeat(500) }, adminA));
  record(C2, '建耗材 price 为字符串', [400, 422, 201], await request('POST', '/materials', { ...matBase, code: `DP-M2-${RUN}`, price: 'abc' }, adminA));
  record(C2, '建耗材 price 负数', [400, 422, 201], await request('POST', '/materials', { ...matBase, code: `DP-M3-${RUN}`, price: -5 }, adminA));
  record(C2, '建账号 username 300 字符', [400, 422, 201], await request('POST', '/accounts', { username: 'u'.repeat(300), password: '123456', role: 'operator' }, adminA));
  record(C2, '建账号 password 1 字符', [400, 422], await request('POST', '/accounts', { username: `dp_${RUN}`, password: '1', role: 'operator' }, adminA));
  record(C2, '建账号 NUL username', [400, 422], await request('POST', '/accounts', { username: 'a\u0000b', password: '123456', role: 'operator' }, adminA));
  record(C2, '基础数据 dept name 含 NUL', [400, 422], await request('POST', '/basic-data/dept', { name: 'a\u0000b', code: `DPN-${RUN}` }, adminA));
  record(C2, '基础数据未支持 type', [400, 404], await request('GET', '/basic-data/evil_table', undefined, adminA));
  record(C2, 'transport plan_depart_at 非法日期', [400, 422], await request('POST', '/transport/orders', { item_name: 'x', from_loc: 'A', to_loc: 'B', order_type: 'free', plan_depart_at: 'not-a-date' }, adminA));
  record(C2, 'inspection scheduled_at 非法日期', [400, 422], await request('POST', '/inspection/tasks', { title: 'x', type: 'free', scheduled_at: '2026-13-45' }, adminA));
  record(C2, 'volunteer start_at 非法日期', [400, 422], await request('POST', '/volunteer/activities', { title: 'x', start_at: 'garbage', end_at: 'garbage' }, adminA));
  record(C2, 'settlements 空 body', [400, 422], await request('POST', '/settlements', {}, adminA));
  record(C2, 'settlements ids 为字符串', [400, 422], await request('POST', '/settlements', { work_order_ids: 'abc' }, adminA));
  for (const p of ['/assets/not-a-uuid', '/inspection/tasks/not-a-uuid', '/inspection/points/not-a-uuid',
    '/transport/orders/not-a-uuid', '/patrol/points/not-a-uuid', '/patrol/tasks/not-a-uuid',
    '/volunteer/activities/not-a-uuid', '/equipment/equipment/not-a-uuid', '/open/work_order/not-a-uuid',
    '/materials/not-a-uuid', '/workers/not-a-uuid', '/monitor/devices/not-a-uuid']) {
    record(C2, `非法 UUID GET ${p}`, [400, 404], await request('GET', p, undefined, adminA));
  }
  record(C2, '删除非法 UUID 资产', [400, 404], await request('DELETE', '/assets/not-a-uuid', undefined, adminA));
  record(C2, '巡检签到非法 UUID', [400, 404], await request('POST', '/inspection/tasks/not-a-uuid/checkin', {}, w1A));
  // 重复/嵌套查询参数：修复后应为 400（此前 500 / TypeError）
  record(C2, '工单列表重复 status', [400], await request('GET', '/open/work_orders?status=done&status=pending', undefined, adminA));
  record(C2, '基础数据重复 q', [400], await request('GET', '/basic-data/dept?q=a&q=b', undefined, adminA));
  record(C2, '设备重复 q', [400], await request('GET', '/equipment/equipment?q=a&q=b', undefined, adminA));
  record(C2, '公开我的报修重复 org', [400], await request('GET', '/public/my-reports?org=a&org=b', undefined, adminA));
  record(C2, '嵌套查询参数 a[b]=c', [400], await request('GET', '/open/work_orders?a[b]=c', undefined, adminA));
  for (const q of ['?page=-1', '?page=0&page_size=0', '?page=abc&page_size=abc', '?limit=NaN', '?days=abc', '?sort=;DROP TABLE x']) {
    record(C2, `工单列表参数 ${q}`, [200, 400], await request('GET', '/open/work_orders' + q, undefined, adminA));
  }
  for (const q of ['?page=-1', '?page_size=100000', '?page=abc']) {
    record(C2, `资产列表参数 ${q}`, [200, 400], await request('GET', '/assets' + q, undefined, adminA));
  }
  // 分页上限必须真的生效（不是原样返回）
  const bigPage = await request('GET', '/assets?page_size=100000', undefined, adminA);
  recordCustom(C2, '资产 page_size 上限收敛', bigPage.status === 200 && (bigPage.body?.items || []).length <= 200, `status=${bigPage.status} items=${(bigPage.body?.items || []).length}`, bigPage.status >= 500);
  record(C2, '统计 days=abc', [200, 400], await request('GET', '/stats?days=abc', undefined, adminA));
  record(C2, '过程挖掘 days=abc', [200, 400], await request('GET', '/process-mining?entityType=work_order&days=abc', undefined, adminA));

  // ============ 3. 业务前置：建资源 ============
  const mkWo = await request('POST', '/open/work_order', newOrder({ title: '隔离工单', description: '隔离' }), adminA);
  recordCustom('准备', '创建工单', mkWo.status === 201, `status=${mkWo.status}`, mkWo.status >= 500);
  const woId = mkWo.body?.id;
  const asset = await request('POST', '/assets', { name: '隔离资产', location: 'DP-LOC', status: 'in_use' }, adminA);
  recordCustom('准备', '创建资产', [200, 201].includes(asset.status), `status=${asset.status}`, asset.status >= 500);
  const assetId = asset.body?.item?.id;
  const mat = await request('POST', '/materials', matBase, adminA);
  recordCustom('准备', '创建耗材', [200, 201].includes(mat.status), `status=${mat.status}`, mat.status >= 500);
  const matId = mat.body?.item?.id;
  const pt = await request('POST', '/inspection/points', { name: '隔离巡检点', code: `DP-P-${RUN}` }, adminA);
  const pointId = pt.body?.item?.id;
  const it = await request('POST', '/inspection/items', { name: '温度', type: 'number', standard_value: '20', unit: 'C' }, adminA);
  const itemId = it.body?.item?.id;
  recordCustom('准备', '创建巡检点/检查项', [200, 201].includes(pt.status) && [200, 201].includes(it.status), `point=${pt.status} item=${it.status}`, pt.status >= 500 || it.status >= 500);
  const task = await request('POST', '/inspection/tasks', { point_id: pointId, type: 'free', title: '隔离巡检', assignee: workerA1, item_ids: itemId ? [itemId] : [] }, adminA);
  const taskId = task.body?.item?.id;
  recordCustom('准备', '创建巡检任务', [200, 201].includes(task.status), `status=${task.status}`, task.status >= 500);
  const vol = await request('POST', '/volunteer/activities', { title: '隔离志愿', location: 'DP-LOC', start_at: new Date(Date.now() - 3600e3).toISOString(), end_at: new Date(Date.now() + 7200e3).toISOString(), slots: 2 }, adminA);
  const volId = vol.body?.item?.id;
  recordCustom('准备', '创建志愿活动', [200, 201].includes(vol.status), `status=${vol.status}`, vol.status >= 500);
  const pat = await request('POST', '/patrol/points', { name: '隔离巡更点', location: '1F', seq: 1 }, adminA);
  const patId = pat.body?.item?.id;
  const patTask = await request('POST', '/patrol/tasks', { title: '隔离巡更', assignee: workerA1, point_ids: patId ? [patId] : [] }, adminA);
  const patTaskId = patTask.body?.item?.id;
  recordCustom('准备', '创建巡更任务', [200, 201].includes(patTask.status), `status=${patTask.status}`, patTask.status >= 500);

  // ============ 4. 租户隔离 ============
  const C4 = '租户隔离';
  record(C4, 'B 读 A 资产', [404], await request('GET', `/assets/${assetId}`, undefined, adminB));
  record(C4, 'B 改 A 资产', [404], await request('PATCH', `/assets/${assetId}`, { name: 'hacked' }, adminB));
  record(C4, 'B 删 A 资产', [404], await request('DELETE', `/assets/${assetId}`, undefined, adminB));
  record(C4, 'B 读 A 耗材', [404], await request('GET', `/materials/${matId}`, undefined, adminB));
  record(C4, 'B 读 A 巡检任务', [404], await request('GET', `/inspection/tasks/${taskId}`, undefined, adminB));
  record(C4, 'B 读 A 志愿活动', [404], await request('GET', `/volunteer/activities/${volId}`, undefined, adminB));
  record(C4, 'B 读 A 工单', [404], await request('GET', `/open/work_order/${woId}`, undefined, adminB));
  record(C4, 'B 读 A 巡更任务', [404], await request('GET', `/patrol/tasks/${patTaskId}`, undefined, adminB));
  record(C4, 'B worker 读 A 工单', [404], await request('GET', `/open/work_order/${woId}`, undefined, w1B));
  const listB = await request('GET', '/open/work_orders?limit=200', undefined, adminB);
  recordCustom(C4, 'B 列表不含 A 工单', !(listB.body?.items || []).some((x) => x.id === woId), `items=${(listB.body?.items || []).length}`);

  // 4.3 同租户跨师傅越权（数据范围）
  const w2Order = await request('POST', '/open/work_order', newOrder({ title: 'W2专属' }), adminA);
  const w2OrderId = w2Order.body?.id;
  await request('POST', `/open/work_order/${w2OrderId}/transition`, { to: 'assigned', assignee: (await dbQuery(TA, `SELECT id FROM worker WHERE tenant_id=$1 AND name='w2-worker'`, [TA])).rows[0].id }, adminA);
  record(C4, 'w1 读 w2 的工单', [403, 404], await request('GET', `/open/work_order/${w2OrderId}`, undefined, w1A));
  record(C4, 'w1 改 w2 工单 ext', [403, 404], await request('PATCH', `/open/work_order/${w2OrderId}/ext`, { patch: { hacked: 1 } }, w1A));
  const w1list = await request('GET', '/open/work_orders?limit=200', undefined, w1A);
  recordCustom(C4, 'w1 列表不含 w2 工单', !(w1list.body?.items || []).some((x) => x.id === w2OrderId), `items=${(w1list.body?.items || []).length}`);

  // ============ 5. 并发 ============
  const C5 = '并发';
  const claimWo = await request('POST', '/open/work_order', newOrder({ title: '抢单并发' }), adminA);
  const claimId = claimWo.body?.id;
  recordCustom('准备', '创建抢单工单', !!claimId, `id=${claimId}`, claimWo.status >= 500);
  if (claimId) {
    const [c1, c2] = await Promise.all([
      request('POST', `/open/work_order/${claimId}/claim`, { workerId: workerA1 }, w1A),
      request('POST', `/open/work_order/${claimId}/claim`, {}, w2A),
    ]);
    const okCount = [c1, c2].filter((r) => r.status >= 200 && r.status < 300).length;
    recordCustom(C5, '双人并发抢单不双成功', okCount <= 1, `w1=${c1.status} w2=${c2.status} ok=${okCount} ${JSON.stringify(c1.body?.code || c2.body?.code || '')}`, c1.status >= 500 || c2.status >= 500);
    const detail = await request('GET', `/open/work_order/${claimId}`, undefined, adminA);
    const assignee = (detail.body?.ticket || detail.body?.item || detail.body).assignee_id;
    recordCustom(C5, '抢单后负责人为唯一值', assignee === workerA1, `assignee=${assignee}`);
  }
  // 5.2 工单流转并发（work order 已有行锁，验证不回退）
  const dbl = await request('POST', '/open/work_order', newOrder({ title: '双到场' }), adminA);
  const dblId = dbl.body?.id;
  await request('POST', `/open/work_order/${dblId}/transition`, { to: 'assigned', assignee: workerA1 }, adminA);
  const [t1, t2] = await Promise.all([
    request('POST', `/open/work_order/${dblId}/transition`, { to: 'arrived' }, w1A),
    request('POST', `/open/work_order/${dblId}/transition`, { to: 'arrived' }, w1A),
  ]);
  recordCustom(C5, '工单并发到场仅 1 成功', [t1, t2].filter((r) => r.status >= 200 && r.status < 300).length === 1, `a=${t1.status} b=${t2.status}`, t1.status >= 500 || t2.status >= 500);
  // 5.3 巡检并发完成
  if (taskId) {
    const cin = await request('POST', `/inspection/tasks/${taskId}/checkin`, { geo_lat: 25.9, geo_lng: 113.2 }, w1A);
    recordCustom('准备', '巡检签到', [200, 201].includes(cin.status), `status=${cin.status}`, cin.status >= 500);
    const [d1, d2] = await Promise.all([
      request('POST', `/inspection/tasks/${taskId}/complete`, { note: 'c1', records: itemId ? [{ item_id: itemId, actual_value: '21', passed: true }] : [] }, w1A),
      request('POST', `/inspection/tasks/${taskId}/complete`, { note: 'c2', records: itemId ? [{ item_id: itemId, actual_value: '22', passed: true }] : [] }, w1A),
    ]);
    recordCustom(C5, '重复完成巡检仅 1 成功', [d1, d2].filter((r) => r.status >= 200 && r.status < 300).length === 1, `first=${d1.status} second=${d2.status}`, d1.status >= 500 || d2.status >= 500);
    const det = await request('GET', `/inspection/tasks/${taskId}`, undefined, adminA);
    recordCustom(C5, '完成后详情含 available 数组', Array.isArray((det.body?.item || {}).available), `available=${typeof (det.body?.item || {}).available}`);
  }
  // 5.4 巡更并发扫码
  if (patTaskId && pat.body?.item?.checkin_code) {
    const code = pat.body.item.checkin_code;
    const [p1, p2] = await Promise.all([
      request('POST', `/patrol/tasks/${patTaskId}/checkin`, { code }, w1A),
      request('POST', `/patrol/tasks/${patTaskId}/checkin`, { code }, w1A),
    ]);
    recordCustom(C5, '重复扫码签到仅 1 成功', [p1, p2].filter((r) => r.status >= 200 && r.status < 300).length === 1, `a=${p1.status} b=${p2.status}`, p1.status >= 500 || p2.status >= 500);
  }
  // 5.5 志愿并发签到
  if (volId) {
    const su = await request('POST', `/volunteer/activities/${volId}/signup`, { user_name: '并发志愿者' }, adminA);
    const recs = await request('GET', `/volunteer/activities/${volId}/records`, undefined, adminA);
    const rid = (recs.body?.items || [])[0]?.id;
    recordCustom('准备', '志愿报名+记录', [200, 201].includes(su.status) && !!rid, `signup=${su.status} rid=${rid}`, su.status >= 500);
    if (rid) {
      const [v1, v2] = await Promise.all([
        request('POST', `/volunteer/records/${rid}/checkin`, {}, adminA),
        request('POST', `/volunteer/records/${rid}/checkin`, {}, adminA),
      ]);
      recordCustom(C5, '重复志愿签到仅 1 成功', [v1, v2].filter((r) => r.status >= 200 && r.status < 300).length === 1, `a=${v1.status} b=${v2.status}`, v1.status >= 500 || v2.status >= 500);
    }
  }
  // 5.6 库存超卖（并发扣减）
  if (matId) {
    await request('POST', '/inventory/in', { material_id: matId, qty: 10 }, adminA);
    const [s1, s2] = await Promise.all([
      request('POST', '/inventory/out', { material_id: matId, qty: 6 }, adminA),
      request('POST', '/inventory/out', { material_id: matId, qty: 6 }, adminA),
    ]);
    const okOut = [s1, s2].filter((r) => r.status >= 200 && r.status < 300).length;
    const inv = await request('GET', '/inventory', undefined, adminA);
    const row = (inv.body?.items || []).find((x) => x.material_id === matId);
    recordCustom(C5, '并发出库不得超卖', okOut === 1 && Number(row?.qty) === 4, `a=${s1.status} b=${s2.status} ok=${okOut} qty=${row?.qty}`, s1.status >= 500 || s2.status >= 500);
  }
  // 5.7 巡检抢单并发
  const freeTask = await request('POST', '/inspection/tasks', { point_id: pointId, type: 'free', title: '并发抢巡检' }, adminA);
  if (freeTask.body?.item?.id) {
    const [i1, i2] = await Promise.all([
      request('POST', `/inspection/tasks/${freeTask.body.item.id}/claim`, {}, w1A),
      request('POST', `/inspection/tasks/${freeTask.body.item.id}/claim`, {}, w2A),
    ]);
    recordCustom(C5, '巡检并发抢单仅 1 成功', [i1, i2].filter((r) => r.status >= 200 && r.status < 300).length === 1, `a=${i1.status} b=${i2.status}`, i1.status >= 500 || i2.status >= 500);
  }
  // 5.8 运送并发认领 / 并发发车
  const to = await request('POST', '/transport/orders', { item_name: '并发运送', from_loc: 'A', to_loc: 'B', order_type: 'free' }, adminA);
  const toId = to.body?.item?.id;
  if (toId) {
    // 建单可能已自动派单（carrier 非空）；只有未派单时才能真实打并发认领。
    const toDetail = await request('GET', `/transport/orders/${toId}`, undefined, adminA);
    const hasCarrier = !!String(toDetail.body?.item?.carrier ?? '').trim();
    if (hasCarrier) {
      recordCustom(C5, '运送并发认领（建单已自动派单，跳过）', true, `carrier=${toDetail.body?.item?.carrier}`);
    } else {
      const [c1t, c2t] = await Promise.all([
        request('POST', `/transport/orders/${toId}/claim`, {}, w1A),
        request('POST', `/transport/orders/${toId}/claim`, {}, w2A),
      ]);
      recordCustom(C5, '运送并发认领仅 1 成功', [c1t, c2t].filter((r) => r.status >= 200 && r.status < 300).length === 1, `a=${c1t.status} b=${c2t.status}`, c1t.status >= 500 || c2t.status >= 500);
    }
  }

  // ============ 6. 状态机 / 结算 ============
  const C6 = '状态机';
  const smWo = await request('POST', '/open/work_order', newOrder({ title: '状态机工单' }), adminA);
  const smId = smWo.body?.id;
  record(C6, 'pending 直达 completed', [400, 409, 422], await request('POST', `/open/work_order/${smId}/transition`, { to: 'completed' }, adminA));
  record(C6, '非法事件名', [400, 422], await request('POST', `/open/work_order/${smId}/transition`, { event: 'not_an_event' }, adminA));
  record(C6, '不存在的工单流转', [404], await request('POST', `/open/work_order/${crypto.randomUUID()}/transition`, { to: 'assigned' }, adminA));
  record(C6, 'flow 非法 entityType', [400, 404, 410], await request('POST', '/flow/evil_entity/x/transition', { event: 'x' }, adminA));
  record(C6, 'flow 不存在任务', [404], await request('POST', `/flow/work_order/${crypto.randomUUID()}/transition`, { event: 'x' }, adminA));
  const settleWo = await request('POST', '/open/work_order', newOrder({ title: '结算工单' }), adminA);
  const settleWoId = settleWo.body?.id;
  const done = await completeOrder(settleWoId);
  recordCustom('准备', '工单推进到完成', done.ok, done.ok ? 'completed' : `status=${done.status} ${JSON.stringify(done.body?.code)}`, !done.ok && done.status >= 500);
  const settle = await request('POST', '/settlements', { work_order_ids: [settleWoId] }, adminA);
  const sid = settle.body?.settlement?.id;
  recordCustom('准备', '生成结算单', !!sid, `status=${settle.status} sid=${sid}`, settle.status >= 500);
  if (sid) {
    const s1 = await request('POST', `/settlements/${sid}/confirm`, {}, adminA);
    const s2 = await request('POST', `/settlements/${sid}/confirm`, {}, adminA);
    recordCustom(C6, '重复确认结算第二次非 2xx', [200, 201].includes(s1.status) && !([200, 201].includes(s2.status)), `first=${s1.status} second=${s2.status}`, s1.status >= 500 || s2.status >= 500);
    const voidR = await request('POST', `/settlements/${sid}/void`, {}, adminA);
    const reconfirm = await request('POST', `/settlements/${sid}/confirm`, {}, adminA);
    recordCustom(C6, '作废后不可再确认', !([200, 201].includes(reconfirm.status)), `void=${voidR.status} reconfirm=${reconfirm.status}`, reconfirm.status >= 500);
  }

  // ============ 7. 上传安全 ============
  const C7 = '上传';
  record(C7, '无 token 上传', [401], await request('POST', '/upload', { filename: 'a.png', contentType: 'image/png', base64: Buffer.from('x').toString('base64') }));
  record(C7, '空 base64', [400, 413], await request('POST', '/upload', { filename: 'a.png', contentType: 'image/png', base64: '' }, adminA));
  record(C7, '非法 base64 字符', [400], await request('POST', '/upload', { filename: 'a.png', contentType: 'image/png', base64: '!!!!notbase64!!!!' }, adminA));
  record(C7, '可执行文件类型', [400, 415], await request('POST', '/upload', { filename: 'evil.exe', contentType: 'application/x-msdownload', base64: Buffer.from('MZ').toString('base64') }, adminA));
  record(C7, '文件名路径穿越', [200, 201], await request('POST', '/upload', { filename: '../../evil.png', contentType: 'image/png', base64: Buffer.from('x'.repeat(32)).toString('base64') }, adminA));
  record(C7, '6MB 超限', [413], await request('POST', '/upload', { filename: 'big.png', contentType: 'image/png', base64: crypto.randomBytes(6 * 1024 * 1024).toString('base64') }, adminA));
  const tinyB64 = Buffer.from('public-upload-probe').toString('base64');
  record(C7, '公开上传无 org', [400, 404, 422], await request('POST', '/public/upload', { filename: 'a.png', contentType: 'image/png', base64: tinyB64 }));
  record(C7, '公开上传 org 不存在', [404], await request('POST', '/public/upload?org=no-such-tenant', { filename: 'a.png', contentType: 'image/png', base64: tinyB64 }));
  record(C7, '公开上传 org 路径穿越', [400, 404], await request('POST', '/public/upload?org=..%2F..%2Fetc', { filename: 'a.png', contentType: 'image/png', base64: tinyB64 }));
  const up = await request('POST', '/upload', { filename: 'probe.png', contentType: 'image/png', base64: crypto.randomBytes(64).toString('base64') }, adminA);
  const upUrl = up.body?.url;
  recordCustom('准备', '上传成功返回 url', typeof upUrl === 'string' && upUrl.startsWith('/uploads/'), `url=${upUrl}`, up.status >= 500);
  if (upUrl) {
    // 静态文件走根路径 /uploads（不在 /api/v1 下）；无 cookie → 401，本租户 cookie → 200，跨租户 cookie → 401
    const own = await request('GET', ROOT_BASE + upUrl, undefined, undefined, { Cookie: cookieA });
    const anon = await request('GET', ROOT_BASE + upUrl);
    const cross = await request('GET', ROOT_BASE + upUrl.replace(`/uploads/${TA}/`, `/uploads/${TB}/`), undefined, undefined, { Cookie: cookieA });
    recordCustom(C7, '本租户 cookie 可读上传文件', own.status === 200, `status=${own.status}`);
    recordCustom(C7, '匿名读上传文件被拒', anon.status === 401, `status=${anon.status}`);
    recordCustom(C7, '跨租户 cookie 读文件被拒', cross.status === 401 || cross.status === 404, `status=${cross.status}`);
  }

  // ============ 8. CSV ============
  const C8 = 'CSV';
  const exp = await request('GET', '/assets/export', undefined, adminA);
  record(C8, '资产导出', [200], exp);
  if (exp.status === 200) {
    recordCustom(C8, '导出非空且含表头', typeof exp.raw === 'string' && exp.raw.split(/\r?\n/).length >= 2, `len=${exp.raw?.length}`);
    // 公式注入：先建一条以 = 开头的资产，再导出，必须被单引号中和
    await request('POST', '/assets', { name: '=1+2', location: 'DP-LOC' }, adminA);
    const exp2 = await request('GET', '/assets/export', undefined, adminA);
    const line = (exp2.raw || '').split(/\r?\n/).find((l) => l.includes('1+2')) || '';
    recordCustom(C8, '导出中和 CSV 公式注入', line.includes("'=1+2") || line.includes("\"'=1+2\""), `line=${line.slice(0, 60)}`);
  }
  record(C8, '导入空 body', [400, 422], await request('POST', '/assets/import', {}, adminA));
  record(C8, '导入仅表头', [200], await request('POST', '/assets/import', { csv: '资产名称\n' }, adminA));
  record(C8, '导入超过 2000 行', [400, 422], await request('POST', '/assets/import', { csv: '资产名称\n' + 'x\n'.repeat(2001) }, adminA));

  // ============ 9. 权限矩阵 ============
  const C9 = '权限';
  record(C9, 'worker 建资产', [403], await request('POST', '/assets', { name: 'x' }, w1A));
  record(C9, 'worker 建耗材', [403], await request('POST', '/materials', matBase, w1A));
  record(C9, 'worker 读统计', [403], await request('GET', '/stats', undefined, w1A));
  record(C9, 'worker 读账号列表', [403], await request('GET', '/accounts', undefined, w1A));
  record(C9, 'operator 删除账号', [403], await request('DELETE', `/accounts/${crypto.randomUUID()}`, undefined, opA));
  record(C9, 'operator 改术语', [200, 201, 403], await request('POST', '/config/terms', { module: 'global', code: `DPT_${RUN}`, default_label: 'x' }, opA));
  record(C9, '租户 token 访问平台接口', [401, 403], await request('GET', '/platform/summary', undefined, adminA));
  record(C9, 'worker 调管理端工单列表', [200, 403], await request('GET', '/open/work_orders?limit=1', undefined, w1A));

  // ============ 10. 公开接口 ============
  const C10 = '公开接口';
  record(C10, '公开报修缺 consent', [400, 422], await request('POST', '/public/repair-report', { org: TA, name: 'x', phone: '13800000000', location: 'DP-LOC', description: 'x' }));
  record(C10, '公开报修 NUL 描述', [400, 422], await request('POST', '/public/repair-report', { org: TA, name: 'x', phone: '13800000000', location: 'DP-LOC', description: 'a\u0000b', consent: true }));
  record(C10, '公开报修 org 不存在', [400, 404, 422], await request('POST', '/public/repair-report', { org: 'no-such-tenant', name: 'x', phone: '13800000000', location: 'x', description: 'x', consent: true }));
  record(C10, '我的报修 token 非法', [400, 404, 200], await request('GET', `/public/my-reports?org=${encodeURIComponent(TA)}&tokens=!!!`));
  record(C10, '报修进度缺参数', [422], await request('GET', '/public/repair-status'));
  record(C10, '报修进度单号不存在', [404], await request('GET', `/public/repair-status?org=${encodeURIComponent(TA)}&order_no=WO_NOT_EXIST`));
  record(C10, '公开租户列表缺关键词', [422], await request('GET', '/public/tenants'));
  record(C10, '公开租户列表正常', [200], await request('GET', '/public/tenants?q=' + encodeURIComponent('医院')));
  record(C10, '公开 AI 空消息', [400, 422], await request('POST', '/public/ai-chat', { org: TA, message: '' }));

  // ============ 11. 安全头 ============
  const C11 = '安全头';
  const meR = await request('GET', '/auth/me', undefined, adminA);
  recordCustom(C11, 'API 响应含 x-content-type-options', meR.headers['x-content-type-options'] === 'nosniff', `value=${meR.headers['x-content-type-options'] || '-'}`);
  recordCustom(C11, 'API 响应含 x-request-id', !!meR.headers['x-request-id'], `value=${meR.headers['x-request-id'] || '-'}`);
  const cors = await request('OPTIONS', '/auth/login', undefined, undefined, { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' });
  recordCustom(C11, 'CORS 未对任意源放行', (cors.headers['access-control-allow-origin'] || '') !== '*', `acao=${cors.headers['access-control-allow-origin'] || '-'} status=${cors.status}`);

  // ============ 汇总 ============
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
