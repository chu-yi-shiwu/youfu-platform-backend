// 隔离 UAT 租户 · 全模块闭环集成测试
//
// 覆盖 PC 模块：工单/结算/巡检/巡检计划/巡更/资产/耗材/设备/应急预案/
//              志愿者/优化/统计/账号权限/派单规则/术语/反馈/工作流
// 覆盖小程序 API：公开报修/我的报修、师傅任务、巡检、巡更、志愿者、运送
//
// 运行（ECS）：
//   cd /opt/youfu/pilot/backend
//   PGDATABASE=youfu_pilot ENV_FILE=.env \
//     /opt/node16/bin/node scripts/pilot-uat-all-modules-e2e.mjs
//
// 完全隔离：创建 uat-all-<run> 租户，结束后按 tenant_id 清理全部数据。
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
const RUN = process.env.E2E_RUN_ID || `all${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const TENANT = `uat-all-${RUN}`;
const DEPT_CODE = `UAT-${RUN}`;
const CAT_CODE = `uat_all_${RUN}`;
const CAT_NAME = `UAT综合-${RUN}`;
const SKILL = `uat_all_${RUN}`;
const WORKER_ID = `UAT-W-${RUN}`;
const ADMIN_USER = 'admin';
const OPERATOR_USER = 'operator';
const WORKER_USER = 'uat_worker';
const ADMIN_PASS = 'UatAdmin!2026';
const OPERATOR_PASS = 'UatOperator!2026';
const WORKER_PASS = 'UatWorker!2026';
// 主站（youfu）同步测试用：模板源租户可切换；pilot 默认 zixing-hospital。
const SOURCE_TENANT = process.env.SOURCE_TENANT || 'zixing-hospital';

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
  if (r.status !== 200 || !r.body?.token) throw new Error(`login ${username} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); };
const expectStatus = (r, code, msg) => assert(r.status === code, `${msg}（期望 ${code}，实际 ${r.status} ${JSON.stringify(r.body)}）`);
const expectOk = (r, msg) => assert(r.status >= 200 && r.status < 300, `${msg}（实际 ${r.status} ${JSON.stringify(r.body)}）`);
const bodyOf = (r) => r.body?.item || r.body?.result || r.body || {};

const results = [];
async function runModule(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`[uat] PASS ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.error(`[uat] FAIL ${name}: ${e.message}`);
  }
}

let sourceWf = null;
let adminToken = null;
let operatorToken = null;
let workerToken = null;
let deptId = null;
const uploaded = [];

async function setupTenant() {
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id','${SOURCE_TENANT}',true), set_config('app.scope','system',true)`);
  const src = await db.query(
    `SELECT entity_type, def, version FROM workflow_def WHERE tenant_id='${SOURCE_TENANT}' AND entity_type='work_order' ORDER BY version DESC LIMIT 1`,
  );
  await db.query('COMMIT');
  assert(src.rowCount === 1, '缺少源 workflow_def');
  sourceWf = src.rows[0];

  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  await db.query(`INSERT INTO tenant_registry (tenant_id,name,status) VALUES ($1,$2,'active')`, [TENANT, `UAT全模块 ${RUN}`]);
  const dept = await db.query(
    `INSERT INTO dept (tenant_id,name,code,remark,is_default) VALUES ($1,'UAT后勤',$2,'E2E',true) RETURNING id`,
    [TENANT, DEPT_CODE],
  );
  deptId = dept.rows[0].id;
  const admin = await db.query(
    `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
     VALUES ($1,$2,$3,'UAT管理员','admin',true) RETURNING id`,
    [TENANT, ADMIN_USER, hashPassword(ADMIN_PASS)],
  );
  await db.query(
    `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
     VALUES ($1,$2,$3,'UAT运营','operator',true)`,
    [TENANT, OPERATOR_USER, hashPassword(OPERATOR_PASS)],
  );
  const workerAcc = await db.query(
    `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
     VALUES ($1,$2,$3,'UAT师傅','worker',true) RETURNING id`,
    [TENANT, WORKER_USER, hashPassword(WORKER_PASS)],
  );
  await db.query(
    `INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id,department_id)
     VALUES ($1,$2,'UAT师傅',$3::text[],0,true,$4,$5)`,
    [WORKER_ID, TENANT, ['repair', SKILL], workerAcc.rows[0].id, deptId],
  );
  await db.query(
    `INSERT INTO fault_category (tenant_id,code,name,business_type,skill_tags,sort,enabled)
     VALUES ($1,$2,$3,'repair',$4::jsonb,1,true)`,
    [TENANT, CAT_CODE, CAT_NAME, JSON.stringify(['repair', SKILL])],
  );
  await db.query(
    `INSERT INTO location_dict (tenant_id,code,name,category,enabled) VALUES ($1,'UAT-LOC','UAT-1F','位置',true)`,
    [TENANT],
  );
  await db.query(
    `INSERT INTO workflow_def (tenant_id,entity_type,def,version,updated_by)
     VALUES ($1,'work_order',$2::jsonb,$3,'e2e')`,
    [TENANT, JSON.stringify(sourceWf.def), sourceWf.version],
  );
  await db.query('COMMIT');
}

async function cleanupTenant() {
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
    EXECUTE format('DELETE FROM %I WHERE tenant_id=$1', r.table_name) USING '${TENANT}';
  END LOOP;
END $$;
COMMIT;`;
    execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', process.env.PGDATABASE || 'youfu_pilot', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' });
    // 平台审计 append-only；测试动作按目标租户清掉，避免 UAT 痕迹长期留在 pilot 审计里。
    execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', process.env.PGDATABASE || 'youfu_pilot', '-v', 'ON_ERROR_STOP=1', '-c', `DELETE FROM platform_audit WHERE target_tenant='${TENANT}'`], { stdio: 'pipe' });
    // 清理所有可能的 uploads 根：主站默认 /opt/youfu/uploads，pilot 默认 /opt/youfu/pilot/uploads；
    // 历史脚本只按 UPLOAD_ROOT 删，跨环境会漏删（2026-11-15 实测遗留 uat-* 目录）。
    for (const root of new Set([process.env.UPLOAD_DIR, '/opt/youfu/uploads', '/opt/youfu/pilot/uploads'].filter(Boolean))) {
      rmSync(path.join(root, TENANT), { recursive: true, force: true });
    }
    console.log(`[uat] cleaned ${TENANT}`);
  } catch (e) {
    console.error('[uat] cleanup failed', e.message);
  }
}

async function publicUpload(bytes, contentType, filename) {
  const base64 = crypto.randomBytes(bytes).toString('base64');
  const r = await request('POST', `/public/upload?org=${encodeURIComponent(TENANT)}`, { filename, contentType, base64 });
  expectStatus(r, 201, 'public upload');
  uploaded.push(r.body.url);
  return r.body.url;
}

async function main() {
  await db.connect();
  await setupTenant();
  adminToken = await login(ADMIN_USER, ADMIN_PASS, 'pc');
  operatorToken = await login(OPERATOR_USER, OPERATOR_PASS, 'pc');
  workerToken = await login(WORKER_USER, WORKER_PASS, 'mp');

  let workOrderId = null;
  let workOrderNo = null;
  let materialId = null;
  let settlementId = null;

  await runModule('工单 + 耗材 + 结算闭环', async () => {
    const create = await request('POST', '/open/work_order', {
      id: crypto.randomUUID(), business_type: 'repair', catalog: CAT_CODE,
      title: 'UAT全模块工单', description: 'UAT 全模块闭环测试', location: 'UAT-1F',
      reporter_name: 'UAT', priority: 'normal', skill_tags: [SKILL],
      ext: { uat_all: RUN },
    }, adminToken);
    expectStatus(create, 201, '建单');
    workOrderId = create.body.id;
    workOrderNo = create.body.order_no;
    if (create.body.assignee !== WORKER_ID) {
      expectOk(await request('POST', `/open/work_order/${workOrderId}/transition`, { to: 'assigned', assignee: WORKER_ID }, adminToken), '派单');
    }
    expectOk(await request('POST', `/open/work_order/${workOrderId}/transition`, { to: 'arrived' }, workerToken), '到场');
    expectOk(await request('POST', `/open/work_order/${workOrderId}/transition`, { to: 'processing' }, workerToken), '开始');

    const mat = await request('POST', '/materials', { code: `UAT-MAT-${RUN}`, name: 'UAT耗材', unit: '个', price: 12.5, enabled: true }, adminToken);
    expectStatus(mat, 201, '建耗材');
    materialId = mat.body.item.id;
    expectOk(await request('POST', '/inventory/in', { material_id: materialId, qty: 10 }, adminToken), '入库');
    expectOk(await request('POST', '/inventory/consume', { work_order_id: workOrderId, items: [{ material_id: materialId, qty: 2 }] }, workerToken), '工单领用');
    const inv = await request('GET', '/inventory', undefined, adminToken);
    expectOk(inv, '库存查询');
    const row = (inv.body.items || []).find((x) => x.material_id === materialId);
    assert(row && Number(row.qty) === 8, `库存应为 8，实际 ${row?.qty}`);

    expectOk(await request('POST', `/open/work_order/${workOrderId}/transition`, { to: 'pending_review' }, workerToken), '提交复核');
    expectOk(await request('POST', `/open/work_order/${workOrderId}/transition`, { to: 'review_passed' }, adminToken), '复核通过');
    expectOk(await request('POST', `/open/work_order/${workOrderId}/transition`, { to: 'completed' }, adminToken), '完成');

    const st = await request('POST', '/settlements', { work_order_ids: [workOrderId] }, adminToken);
    expectStatus(st, 201, '生成结算草稿');
    settlementId = st.body.settlement?.id || st.body.settlement?.settlement?.id;
    assert(!!settlementId, '结算 ID 缺失');
    expectOk(await request('POST', `/settlements/${settlementId}/confirm`, {}, adminToken), '结算确认');
  });

  await runModule('巡检执行', async () => {
    const pt = await request('POST', '/inspection/points', { name: 'UAT巡检点', code: `UAT-P-${RUN}`, lng: 113.2, lat: 25.9 }, adminToken);
    expectStatus(pt, 201, '巡检点');
    const pointId = pt.body.item.id;
    const item = await request('POST', '/inspection/items', { name: '温度', type: 'number', standard_value: '20', unit: 'C' }, adminToken);
    expectStatus(item, 201, '检查项');
    const itemId = item.body.item.id;
    const task = await request('POST', '/inspection/tasks', { point_id: pointId, type: 'free', title: 'UAT巡检任务', assignee: WORKER_ID, item_ids: [itemId] }, adminToken);
    expectStatus(task, 201, '巡检任务');
    const taskId = task.body.item.id;
    expectOk(await request('POST', `/inspection/tasks/${taskId}/checkin`, { geo_lat: 25.9, geo_lng: 113.2 }, workerToken), '巡检签到');
    expectOk(await request('POST', `/inspection/tasks/${taskId}/complete`, { note: 'UAT完成', records: [{ item_id: itemId, actual_value: '22', passed: true }] }, workerToken), '巡检完成');
    const detail = await request('GET', `/inspection/tasks/${taskId}`, undefined, adminToken);
    assert(bodyOf(detail).status === 'done', `巡检状态应为 done，实际 ${bodyOf(detail).status}`);

    // 异常 → 转工单
    const t2 = await request('POST', '/inspection/tasks', { point_id: pointId, type: 'free', title: 'UAT巡检异常', assignee: WORKER_ID, item_ids: [itemId] }, adminToken);
    expectStatus(t2, 201, '异常任务');
    const t2id = t2.body.item.id;
    expectOk(await request('POST', `/inspection/tasks/${t2id}/checkin`, { geo_lat: 25.9, geo_lng: 113.2 }, workerToken), '异常签到');
    expectOk(await request('POST', `/inspection/tasks/${t2id}/exception`, { note: 'UAT发现异常' }, workerToken), '巡检异常');
    const conv = await request('POST', `/inspection/tasks/${t2id}/convert`, {}, adminToken);
    expectOk(conv, '异常转工单');
    assert(bodyOf(conv).id || bodyOf(conv).work_order_id, '转工单结果缺失');

    // 计划 → 生成
    const plan = await request('POST', '/inspection/plans', { name: 'UAT巡检计划', point_ids: [pointId], frequency: 'daily', item_ids: [itemId] }, adminToken);
    expectOk(plan, '巡检计划');
    const planId = plan.body.plan_id;
    assert(!!planId, '巡检计划 ID 缺失');
    const gen = await request('POST', `/inspection/plans/${planId}/generate`, {}, adminToken);
    expectOk(gen, '计划生成任务');
  });

  await runModule('巡更执行', async () => {
    const p = await request('POST', '/patrol/points', { name: 'UAT巡更点', location: '1F', seq: 1 }, adminToken);
    expectStatus(p, 201, '巡更点');
    const pid = p.body.item.id;
    const t = await request('POST', '/patrol/tasks', { title: 'UAT巡更任务', assignee: WORKER_ID, point_ids: [pid] }, adminToken);
    expectStatus(t, 201, '巡更任务');
    const tid = t.body.item.id;
    const code = p.body.item.checkin_code;
    assert(!!code, '巡更点应生成签到码');
    // 2026-11-14 契约：worker 必须扫码签到；直接 point_id 仅管理端补签。
    const blocked = await request('POST', `/patrol/tasks/${tid}/checkin`, { point_id: pid }, workerToken);
    expectStatus(blocked, 403, 'worker 不扫码签到');
    const c = await request('POST', `/patrol/tasks/${tid}/checkin`, { code, note: 'UAT扫码' }, workerToken);
    expectOk(c, '巡更扫码签到');
    assert(bodyOf(c).status === 'done', `巡更状态应为 done，实际 ${bodyOf(c).status}`);
    assert(bodyOf(c).checkins && bodyOf(c).checkins[0] && bodyOf(c).checkins[0].via === 'scan', '签到记录应标记 via=scan');

    const t2 = await request('POST', '/patrol/tasks', { title: 'UAT漏检任务', assignee: WORKER_ID, point_ids: [pid] }, adminToken);
    expectStatus(t2, 201, '漏检任务');
    const m = await request('POST', `/patrol/tasks/${t2.body.item.id}/miss`, { note: 'UAT漏检' }, workerToken);
    expectOk(m, '巡更漏检');
    assert(bodyOf(m).status === 'missed', `漏检状态应为 missed，实际 ${bodyOf(m).status}`);
  });

  await runModule('资产故障 → 工单', async () => {
    const a = await request('POST', '/assets', { name: 'UAT资产', location: 'UAT-1F', status: 'in_use' }, adminToken);
    expectStatus(a, 201, '资产建档');
    const aid = a.body.item.id;
    const f = await request('POST', `/assets/${aid}/fault`, { title: 'UAT资产故障', description: 'UAT故障' }, adminToken);
    expectOk(f, '资产故障');
    assert(bodyOf(f).id || bodyOf(f).work_order_id, '资产故障工单缺失');
    const m = await request('POST', `/assets/${aid}/maintenance`, { type: 'repair', cost: 100, note: 'UAT维保' }, adminToken);
    expectStatus(m, 201, '资产维保');
    expectOk(await request('GET', `/assets/${aid}/maintenance`, undefined, adminToken), '资产维保列表');
  });

  await runModule('设备档案 + 维保', async () => {
    const type = await request('POST', '/equipment/type', { code: `UAT-ET-${RUN}`, name: 'UAT设备类型' }, adminToken);
    expectStatus(type, 201, '设备类型');
    const vendor = await request('POST', '/equipment/vendor', { code: `UAT-EV-${RUN}`, name: 'UAT设备厂商' }, adminToken);
    expectStatus(vendor, 201, '设备厂商');
    const eq = await request('POST', '/equipment/equipment', { name: 'UAT设备', code: `UAT-EQ-${RUN}`, type_id: type.body.item.id, vendor_id: vendor.body.item.id }, adminToken);
    expectStatus(eq, 201, '设备档案');
    const eqId = eq.body.item.id;
    const m = await request('POST', `/equipment/${eqId}/maintenances`, { mtype: 'maintain', plan_date: '2026-11-20', note: 'UAT保养' }, adminToken);
    expectStatus(m, 201, '设备维保');
    expectOk(await request('GET', `/equipment/${eqId}/maintenances`, undefined, adminToken), '设备维保列表');
  });

  await runModule('应急预案', async () => {
    const p = await request('POST', '/emergency/plans', { title: 'UAT应急预案', category: 'general', level: 'L3', content: 'UAT' }, adminToken);
    expectStatus(p, 201, '应急预案');
    const id = p.body.item.id;
    expectOk(await request('PUT', `/emergency/plans/${id}`, { title: 'UAT应急预案2' }, adminToken), '应急预案更新');
    expectOk(await request('GET', '/emergency/plans', undefined, adminToken), '应急预案列表');
    expectOk(await request('DELETE', `/emergency/plans/${id}`, undefined, adminToken), '应急预案删除');
  });

  await runModule('志愿者活动闭环', async () => {
    const start = new Date(Date.now() - 3600e3).toISOString();
    const end = new Date(Date.now() + 7200e3).toISOString();
    const a = await request('POST', '/volunteer/activities', { title: 'UAT志愿活动', location: 'UAT-1F', start_at: start, end_at: end, slots: 2 }, adminToken);
    expectStatus(a, 201, '志愿活动');
    const aid = a.body.item.id;
    const s = await request('POST', `/volunteer/activities/${aid}/signup`, { user_name: 'UAT志愿者' }, adminToken);
    expectOk(s, '志愿报名');
    const sw = await request('POST', `/volunteer/activities/${aid}/signup`, { user_name: 'UAT师傅志愿' }, workerToken);
    expectOk(sw, '小程序师傅志愿报名');
    const recs = await request('GET', `/volunteer/activities/${aid}/records`, undefined, adminToken);
    expectOk(recs, '志愿记录');
    const rid = (recs.body.items || [])[0]?.id;
    assert(!!rid, '志愿记录 ID 缺失');
    expectOk(await request('POST', `/volunteer/records/${rid}/checkin`, {}, adminToken), '志愿签到');
    expectOk(await request('POST', `/volunteer/records/${rid}/checkout`, {}, adminToken), '志愿签退');
    expectOk(await request('POST', `/volunteer/records/${rid}/approve`, {}, adminToken), '志愿核销');
    expectOk(await request('GET', '/volunteer/stats', undefined, adminToken), '志愿统计');
  });

  await runModule('优化 + 工作流', async () => {
    expectOk(await request('GET', '/workflow/def', undefined, adminToken), '读取工作流');
    const on = await request('PUT', '/auto-tune', { enabled: true }, adminToken);
    assert([200, 409].includes(on.status), `auto-tune 应 200/409，实际 ${on.status}`);
    expectOk(await request('POST', '/optimize/generate', {}, adminToken), '生成优化建议');
    expectOk(await request('GET', '/optimize/list', undefined, adminToken), '优化列表');
    const apply = await request('POST', '/optimize/apply-workflow', {}, adminToken);
    expectOk(apply, '应用工作流优化');
    const off = await request('PUT', '/auto-tune', { enabled: false }, adminToken);
    assert([200, 409].includes(off.status), `关闭自动优化应 200/409，实际 ${off.status}`);
  });

  await runModule('派单规则 + 术语 + 系统配置', async () => {
    const r = await request('POST', '/config/dispatch-rules', { name: `UAT规则-${RUN}`, priority: 100, match_json: { business_type: 'repair' }, strategy_json: { type: 'load_balance' }, enabled: true }, adminToken);
    expectStatus(r, 201, '派单规则');
    const rid = r.body.item.id;
    expectOk(await request('GET', '/config/dispatch-rules', undefined, adminToken), '派单规则列表');
    expectOk(await request('DELETE', `/config/dispatch-rules/${rid}`, undefined, adminToken), '派单规则删除');
    const t = await request('POST', '/config/terms', { module: 'global', code: `UAT_TERM_${RUN}`, default_label: 'UAT术语' }, adminToken);
    expectOk(t, '术语新增');
    const tid = t.body.item.id;
    expectOk(await request('DELETE', `/config/terms/${tid}`, undefined, adminToken), '术语删除');
    expectOk(await request('GET', '/config/system', undefined, adminToken), '系统配置读取');
  });

  await runModule('账号/角色/体验用户', async () => {
    expectOk(await request('GET', '/accounts/roles/perm-catalog', undefined, adminToken), '权限目录');
    expectOk(await request('GET', '/accounts/roles', undefined, adminToken), '角色列表');
    const u = await request('POST', '/accounts', { username: `uat_trial_${RUN}`, password: 'UatTrial!2026', display_name: 'UAT体验', role: 'operator' }, adminToken);
    expectStatus(u, 201, '体验用户');
    const uid = u.body.item.id;
    expectOk(await request('GET', '/accounts', undefined, adminToken), '账号列表');
    expectOk(await request('DELETE', `/accounts/${uid}`, undefined, adminToken), '体验用户删除');
  });

  await runModule('需求反馈', async () => {
    const f = await request('POST', '/feedback', { type: 'opinion', content: 'UAT反馈内容', channel: 'desk' }, adminToken);
    expectStatus(f, 201, '反馈提交');
    const fid = f.body.item.id;
    expectOk(await request('GET', '/feedback', undefined, adminToken), '反馈列表');
    expectOk(await request('POST', `/feedback/${fid}/reply`, { reply: 'UAT已处理' }, adminToken), '反馈回复');
    expectOk(await request('GET', '/feedback/stats', undefined, adminToken), '反馈统计');
  });

  await runModule('统计/工作台/过程挖掘', async () => {
    expectOk(await request('GET', '/stats', undefined, adminToken), '统计');
    expectOk(await request('GET', '/stats/workbench', undefined, adminToken), '工作台统计');
    expectOk(await request('GET', '/process-mining?entityType=work_order&days=30&limit=10', undefined, adminToken), '过程挖掘');
    expectOk(await request('GET', '/auto-tune', undefined, adminToken), '自动优化状态');
  });

  await runModule('公开报修 / 我的报修', async () => {
    const photo = await publicUpload(16 * 1024, 'image/png', 'uat.png');
    const r = await request('POST', '/public/repair-report', {
      org: TENANT, name: 'UAT报修人', phone: '13800000000', location: 'UAT-1F',
      description: 'UAT公开报修：卫生间漏水', category_name: CAT_NAME, consent: true,
      attachments: [{ kind: 'image', url: photo, name: 'uat.png', size: 16 * 1024 }],
    });
    expectStatus(r, 201, '公开报修');
    const token = r.body.view_token;
    const my = await request('GET', `/public/my-reports?org=${encodeURIComponent(TENANT)}&tokens=${encodeURIComponent(token)}`);
    expectOk(my, '我的报修');
    assert((my.body.items || []).some((x) => x.order_no === r.body.order_no), '我的报修缺少公开单');
  });

  await runModule('小程序陪检登记', async () => {
    const e = await request('POST', '/open/work_order', {
      id: crypto.randomUUID(), business_type: 'escort', priority: 'normal',
      title: 'UAT陪检登记', description: 'UAT陪检流程', location: 'UAT-1F',
      ext: { uat_all: RUN },
    }, workerToken);
    expectStatus(e, 201, '陪检登记');
    expectOk(await request('GET', '/open/work_orders?limit=10', undefined, workerToken), '陪检后任务列表');
  });

  await runModule('小程序运送单', async () => {
    const o = await request('POST', '/transport/orders', { item_name: 'UAT标本', from_loc: 'A', to_loc: 'B', priority: 'normal', order_type: 'free' }, adminToken);
    expectStatus(o, 201, '运送单');
    const oid = o.body.item.id;
    expectOk(await request('GET', '/transport/orders', undefined, adminToken), '运送列表');
    const claim = await request('POST', `/transport/orders/${oid}/claim`, {}, workerToken);
    assert([200, 409].includes(claim.status), `运送认领应 200/409，实际 ${claim.status} ${JSON.stringify(claim.body)}`);
    const detail = await request('GET', `/transport/orders/${oid}`, undefined, adminToken);
    assert(bodyOf(detail).carrier, '运送单应有承运人');
    // 认领/自动派单后，师傅可接单并完成
    const recv = await request('POST', `/transport/orders/${oid}/transition`, { event: 'receive' }, workerToken);
    assert([200, 409].includes(recv.status), `运送接单应 200/409，实际 ${recv.status} ${JSON.stringify(recv.body)}`);
    const done = await request('POST', `/transport/orders/${oid}/transition`, { event: 'complete', note: 'UAT送达' }, workerToken);
    assert([200, 409].includes(done.status), `运送完成应 200/409，实际 ${done.status} ${JSON.stringify(done.body)}`);
  });

  await runModule('小程序师傅任务接口', async () => {
    expectOk(await request('GET', '/open/work_orders?limit=10', undefined, workerToken), '师傅任务列表');
    expectOk(await request('GET', '/open/claim-hall', undefined, workerToken), '抢单大厅');
    expectOk(await request('GET', '/open/notifications', undefined, workerToken), '通知列表');
    expectOk(await request('GET', '/auth/me', undefined, workerToken), '个人中心');
  });

  console.log('[uat] SUMMARY', JSON.stringify({ tenant: TENANT, results }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`[uat] ${failed.length === 0 ? 'PASS' : 'PARTIAL'} modules=${results.length} failed=${failed.length}`);
}

main()
  .then(async () => { await cleanupTenant(); await db.end(); process.exit(0); })
  .catch(async (e) => {
    console.error('[uat] FATAL', e.message);
    await cleanupTenant();
    try { await db.end(); } catch { /* ignore */ }
    process.exit(1);
  });
