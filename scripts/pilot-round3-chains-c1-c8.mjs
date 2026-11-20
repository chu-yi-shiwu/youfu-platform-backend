// Round 3 · Phase 1：跨模块业务链 C1–C8
//
// 设计：每条链独立隔离租户，链内从用户动作走到业务结果 + 数据不变量。
// 认证：直接签发租户 JWT（登录流程由 UAT/PC/真机覆盖），避免登录限流干扰链测试。
//
// 运行（ECS）：
//   cd /opt/youfu/pilot/backend
//   PGDATABASE=youfu_pilot ENV_FILE=.env \
//     /opt/node16/bin/node scripts/pilot-round3-chains-c1-c8.mjs
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { signJwt } from '../dist/middleware/auth.js';

const { Client } = pg;
const BASE = (process.env.PILOT_API_BASE || 'http://127.0.0.1:4101/api/v1').replace(/\/+$/, '');
const UPLOAD_ROOT = process.env.UPLOAD_DIR || '/opt/youfu/pilot/uploads';
const RUN = process.env.E2E_RUN_ID || `r3${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const PASS = 'Round3!2026';

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
// 注意：上面的 hash 参数与生产不一致时登录会失败；本脚本不登录，只用于建号占位。

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

const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); };
const ok = (r, msg) => assert(r.status >= 200 && r.status < 300, `${msg}（实际 ${r.status} ${JSON.stringify(r.body)}）`);
const eq = (a, b, msg) => assert(a === b, `${msg}（期望 ${b}，实际 ${a}）`);
const bodyOf = (r) => r.body?.item || r.body?.result || r.body?.ticket || r.body || {};

function token(accountId, role, tenant, username) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ sub: accountId, tid: tenant, role, username, iat: now, exp: now + 3600 }, process.env.JWT_SECRET);
}

let sourceWf = null;
const results = [];

async function setupChain(chain) {
  const tenant = `uat-r3${chain.toLowerCase()}-${RUN}`;
  const skill = `r3_${chain.toLowerCase()}_${RUN}`;
  const catCode = `r3_cat_${chain.toLowerCase()}_${RUN}`;
  const catName = `R3分类-${chain}`;
  const workerId = `R3-${chain}-${RUN}`;
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [tenant]);
  await db.query(`INSERT INTO tenant_registry (tenant_id,name,status) VALUES ($1,$2,'active')`, [tenant, `R3 ${chain}`]);
  const dept = await db.query(
    `INSERT INTO dept (tenant_id,name,code,remark,is_default) VALUES ($1,$2,$3,'R3',true) RETURNING id`,
    [tenant, `R3部门-${chain}`, `R3-${chain}`],
  );
  const deptId = dept.rows[0].id;
  const admin = await db.query(
    `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
     VALUES ($1,$2,$3,'R3管理员','admin',true) RETURNING id`,
    [tenant, 'r3_admin', hashPassword(PASS)],
  );
  const op = await db.query(
    `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
     VALUES ($1,$2,$3,'R3运营','operator',true) RETURNING id`,
    [tenant, 'r3_op', hashPassword(PASS)],
  );
  const wa = await db.query(
    `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
     VALUES ($1,$2,$3,'R3师傅','worker',true) RETURNING id`,
    [tenant, 'r3_worker', hashPassword(PASS)],
  );
  await db.query(
    `INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id,department_id)
     VALUES ($1,$2,'R3师傅',$3::text[],0,true,$4,$5)`,
    [workerId, tenant, ['repair', skill], wa.rows[0].id, deptId],
  );
  await db.query(
    `INSERT INTO fault_category (tenant_id,code,name,business_type,skill_tags,sort,enabled)
     VALUES ($1,$2,$3,'repair',$4::jsonb,1,true)`,
    [tenant, catCode, catName, JSON.stringify(['repair', skill])],
  );
  await db.query(
    `INSERT INTO location_dict (tenant_id,code,name,category,enabled) VALUES ($1,'R3-LOC','R3-1F','位置',true)`,
    [tenant],
  );
  await db.query(
    `INSERT INTO workflow_def (tenant_id,entity_type,def,version,updated_by)
     VALUES ($1,'work_order',$2::jsonb,$3,'r3')`,
    [tenant, JSON.stringify(sourceWf.def), sourceWf.version],
  );
  await db.query('COMMIT');
  return {
    tenant, skill, catCode, catName, workerId, deptId,
    admin: admin.rows[0].id, op: op.rows[0].id, workerAccount: wa.rows[0].id,
    adminToken: token(admin.rows[0].id, 'admin', tenant, 'r3_admin'),
    opToken: token(op.rows[0].id, 'operator', tenant, 'r3_op'),
    workerToken: token(wa.rows[0].id, 'worker', tenant, 'r3_worker'),
  };
}

async function cleanupTenant(tenant) {
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
}

async function chain(name, fn) {
  const ctx = await setupChain(name);
  try {
    await fn(ctx);
    results.push({ chain: name, ok: true });
    console.log(`[chain] PASS ${name}`);
  } catch (e) {
    results.push({ chain: name, ok: false, error: e.message });
    console.error(`[chain] FAIL ${name}: ${e.message}`);
  } finally {
    try { await cleanupTenant(ctx.tenant); console.log(`[chain] cleaned ${ctx.tenant}`); }
    catch (e) { console.error('[chain] cleanup failed', ctx.tenant, e.message); }
  }
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

  // ---------- C1 公开报修 → 派单 → 处理 → 领料 → 结算 → 评价 ----------
  await chain('C1', async (c) => {
    const report = await request('POST', '/public/repair-report', {
      org: c.tenant, name: 'R3报修人', phone: '13800000003', location: 'R3-1F',
      description: 'R3 C1 公共区域水管漏水', category_name: c.catName, consent: true,
    });
    ok(report, '公开报修');
    const orderId = report.body.id;
    assert(!!orderId, '公开报修应返回工单 ID');
    const orderNo = report.body.order_no;

    const mine = await request('GET', `/public/my-reports?org=${encodeURIComponent(c.tenant)}&tokens=${encodeURIComponent(report.body.view_token)}`);
    ok(mine, '我的报修');
    assert((mine.body.items || []).some((x) => x.order_no === orderNo), '我的报修缺少该单');

    if (report.body.assignee !== c.workerId) {
      ok(await request('POST', `/open/work_order/${orderId}/transition`, { to: 'assigned', assignee: c.workerId }, c.adminToken), '派单');
    }
    ok(await request('POST', `/open/work_order/${orderId}/transition`, { to: 'arrived' }, c.workerToken), '到场');
    ok(await request('POST', `/open/work_order/${orderId}/transition`, { to: 'processing' }, c.workerToken), '开始处理');

    const mat = await request('POST', '/materials', { code: `R3-M-${RUN}`, name: 'R3耗材', unit: '个', price: 10, enabled: true }, c.adminToken);
    ok(mat, '建耗材');
    const materialId = mat.body.item.id;
    ok(await request('POST', '/inventory/in', { material_id: materialId, qty: 10 }, c.adminToken), '入库');
    const consume = await request('POST', '/inventory/consume', { work_order_id: orderId, items: [{ material_id: materialId, qty: 2 }] }, c.workerToken);
    ok(consume, '工单领用');
    const inv = await request('GET', '/inventory', undefined, c.adminToken);
    const row = (inv.body.items || []).find((x) => x.material_id === materialId);
    eq(Number(row?.qty), 8, '领用后库存应为 8');

    ok(await request('POST', `/open/work_order/${orderId}/transition`, { to: 'pending_review' }, c.workerToken), '提交复核');
    ok(await request('POST', `/open/work_order/${orderId}/transition`, { to: 'review_passed' }, c.adminToken), '复核通过');
    ok(await request('POST', `/open/work_order/${orderId}/transition`, { to: 'completed' }, c.adminToken), '完成');

    const st = await request('POST', '/settlements', { work_order_ids: [orderId] }, c.adminToken);
    ok(st, '生成结算');
    const settlementId = st.body.settlement?.id || st.body.settlement?.settlement?.id;
    assert(!!settlementId, '结算 ID 缺失');
    ok(await request('POST', `/settlements/${settlementId}/confirm`, {}, c.adminToken), '结算确认');
    const detail = await request('GET', `/settlements/${settlementId}`, undefined, c.adminToken);
    ok(detail, '结算详情');
    const items = detail.body.items || [];
    const sum = Math.round(items.reduce((s, x) => s + Number(x.amount || 0), 0) * 100) / 100;
    eq(Number(detail.body.settlement.total), sum, '结算合计应等于明细合计');
    if (items[0]) {
      const locked = await request('PUT', `/settlements/${settlementId}/items/${items[0].id}`, { qty: 99 }, c.adminToken);
      assert([403, 409, 422].includes(locked.status), `确认后改明细应拒绝，实际 ${locked.status}`);
    }

    ok(await request('POST', `/open/work_order/${orderId}/transition`, { to: 'closed', close_reason: 'R3 C1' }, c.adminToken), '关闭');
    ok(await request('POST', `/open/work_order/${orderId}/transition`, { to: 'evaluated', score: 5 }, c.adminToken), '评价');
    const final = await request('GET', `/open/work_order/${orderId}`, undefined, c.adminToken);
    const ticket = final.body.ticket || final.body.item;
    eq(ticket.status, 'evaluated', '最终状态');
    eq(Number(ticket.satisfaction_score), 5, '满意度');

    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [c.tenant]);
    const n = await db.query(`SELECT count(*)::int c FROM notification WHERE tenant_id=$1 AND work_order_id=$2 AND channel='in_app'`, [c.tenant, orderId]);
    const orphan = await db.query(`SELECT count(*)::int c FROM domain_event WHERE tenant_id=$1 AND entity_type='work_order' AND entity_id=$2 AND NOT EXISTS (SELECT 1 FROM work_orders w WHERE w.id=$2 AND w.tenant_id=$1)`, [c.tenant, orderId]);
    await db.query('COMMIT');
    assert(n.rows[0].c >= 1, '应至少 1 条站内通知');
    eq(orphan.rows[0].c, 0, '不应有孤儿事件');
  });

  // ---------- C2 巡检异常 → 预警 → 转工单 → 结算 ----------
  await chain('C2', async (c) => {
    const pt = await request('POST', '/inspection/points', { name: 'R3巡检点', code: `R3-P-${RUN}` }, c.adminToken);
    ok(pt, '巡检点');
    const item = await request('POST', '/inspection/items', { name: '温度', type: 'number', standard_value: '20', unit: 'C' }, c.adminToken);
    ok(item, '检查项');
    const task = await request('POST', '/inspection/tasks', {
      point_id: pt.body.item.id, type: 'free', title: 'R3巡检任务', assignee: c.workerId, item_ids: [item.body.item.id],
    }, c.adminToken);
    ok(task, '巡检任务');
    const taskId = task.body.item.id;
    ok(await request('POST', `/inspection/tasks/${taskId}/checkin`, { geo_lat: 25.9, geo_lng: 113.2 }, c.workerToken), '巡检签到');
    ok(await request('POST', `/inspection/tasks/${taskId}/exception`, { note: 'R3 巡检发现异常' }, c.workerToken), '巡检异常');
    const conv = await request('POST', `/inspection/tasks/${taskId}/convert`, {}, c.adminToken);
    ok(conv, '异常转工单');
    const orderId = conv.body.result?.id || conv.body.id || conv.body.work_order_id || conv.body.item?.id;
    assert(!!orderId, '转工单应返回工单 ID');

    const t = await request('GET', `/inspection/tasks/${taskId}`, undefined, c.adminToken);
    eq(bodyOf(t).linked_wo_id, orderId, '巡检任务应关联转出的工单');

    const detail = await request('GET', `/open/work_order/${orderId}`, undefined, c.adminToken);
    const ticket = detail.body.ticket || detail.body.item;
    if (ticket.assignee_id !== c.workerId) {
      ok(await request('POST', `/open/work_order/${orderId}/transition`, { to: 'assigned', assignee: c.workerId }, c.adminToken), '转单后派工');
    }
    ok(await request('POST', `/open/work_order/${orderId}/transition`, { to: 'arrived' }, c.workerToken), '到场');
    ok(await request('POST', `/open/work_order/${orderId}/transition`, { to: 'processing' }, c.workerToken), '处理');
    ok(await request('POST', `/open/work_order/${orderId}/transition`, { to: 'pending_review' }, c.workerToken), '提交复核');
    ok(await request('POST', `/open/work_order/${orderId}/transition`, { to: 'review_passed' }, c.adminToken), '复核通过');
    ok(await request('POST', `/open/work_order/${orderId}/transition`, { to: 'completed' }, c.adminToken), '完成');
    const st = await request('POST', '/settlements', { work_order_ids: [orderId] }, c.adminToken);
    ok(st, '转单工单可入结算');
  });

  // ---------- C3 资产故障 → 工单 → 维修 → 维保 ----------
  await chain('C3', async (c) => {
    const a = await request('POST', '/assets', { name: 'R3资产', location: 'R3-1F', status: 'in_use' }, c.adminToken);
    ok(a, '资产建档');
    const assetId = a.body.item.id;
    const f = await request('POST', `/assets/${assetId}/fault`, { title: 'R3资产故障', description: '无法启动' }, c.adminToken);
    ok(f, '资产故障');
    const orderId = f.body.result?.id || f.body.id || f.body.work_order_id || f.body.item?.id;
    assert(!!orderId, '资产故障应返回工单 ID');
    const ar = await request('GET', `/assets?name=${encodeURIComponent('R3资产')}`, undefined, c.adminToken);
    ok(ar, '资产列表');
    const assetRow = (ar.body.items || []).find((x) => x.id === assetId);
    eq(assetRow?.status, 'repairing', '资产状态应为 repairing');
    const m = await request('POST', `/assets/${assetId}/maintenance`, { type: 'repair', cost: 120, note: 'R3 维修' }, c.adminToken);
    ok(m, '资产维保');
    const list = await request('GET', `/assets/${assetId}/maintenance`, undefined, c.adminToken);
    ok(list, '维保列表');
    assert((list.body.items || []).length >= 1, '维保记录缺失');
    const hist = await request('GET', `/assets/${assetId}/history`, undefined, c.adminToken);
    ok(hist, '资产历史');
    assert((hist.body.items || hist.body.events || []).length >= 1, '资产历史缺少故障事件');
  });

  // ---------- C4 设备档案 → 维保计划/记录 ----------
  await chain('C4', async (c) => {
    const type = await request('POST', '/equipment/type', { code: `R3-ET-${RUN}`, name: 'R3设备类型' }, c.adminToken);
    ok(type, '设备类型');
    const vendor = await request('POST', '/equipment/vendor', { code: `R3-EV-${RUN}`, name: 'R3厂商' }, c.adminToken);
    ok(vendor, '设备厂商');
    const eqp = await request('POST', '/equipment/equipment', {
      name: 'R3设备', code: `R3-EQ-${RUN}`, type_id: type.body.item.id, vendor_id: vendor.body.item.id,
    }, c.adminToken);
    ok(eqp, '设备档案');
    const eqId = eqp.body.item.id;
    const m = await request('POST', `/equipment/${eqId}/maintenances`, { mtype: 'maintain', plan_date: '2026-12-01', note: 'R3 保养' }, c.adminToken);
    ok(m, '设备维保计划');
    const list = await request('GET', `/equipment/${eqId}/maintenances`, undefined, c.adminToken);
    ok(list, '设备维保列表');
    assert((list.body.items || []).length >= 1, '设备维保记录缺失');
  });

  // ---------- C5 巡更 → 漏检 ----------
  await chain('C5', async (c) => {
    const p = await request('POST', '/patrol/points', { name: 'R3巡更点', location: 'R3-1F', seq: 1 }, c.adminToken);
    ok(p, '巡更点');
    const t = await request('POST', '/patrol/tasks', { title: 'R3巡更漏检', assignee: c.workerId, point_ids: [p.body.item.id] }, c.adminToken);
    ok(t, '巡更任务');
    const id = t.body.item.id;
    const miss = await request('POST', `/patrol/tasks/${id}/miss`, { note: 'R3 漏检' }, c.workerToken);
    ok(miss, '巡更漏检');
    eq(bodyOf(miss).status, 'missed', '漏检状态');
    const again = await request('POST', `/patrol/tasks/${id}/checkin`, { point_id: p.body.item.id }, c.workerToken);
    assert([409, 422].includes(again.status), `漏检后签到应拒绝，实际 ${again.status}`);
  });

  // ---------- C6 应急预案 → 关联资产 → CRUD ----------
  await chain('C6', async (c) => {
    const p = await request('POST', '/emergency/plans', {
      title: 'R3停电预案', category: 'general', level: 'L2', content: 'R3',
      related_asset_area: 'R3-1F', owner: 'R3', contact_phone: '13800000003',
    }, c.adminToken);
    ok(p, '应急预案');
    const id = p.body.item.id;
    const up = await request('PUT', `/emergency/plans/${id}`, { title: 'R3停电预案V2', level: 'L1' }, c.adminToken);
    ok(up, '预案更新');
    const list = await request('GET', '/emergency/plans', undefined, c.adminToken);
    ok(list, '预案列表');
    assert((list.body.items || []).some((x) => x.id === id && x.level === 'L1'), '预案更新未生效');
    ok(await request('DELETE', `/emergency/plans/${id}`, undefined, c.adminToken), '预案删除');
  });

  // ---------- C7 志愿者 → 报名 → 签到/签退/核销 → 统计 ----------
  await chain('C7', async (c) => {
    const start = new Date(Date.now() - 3600e3).toISOString();
    const end = new Date(Date.now() + 7200e3).toISOString();
    const a = await request('POST', '/volunteer/activities', {
      title: 'R3志愿活动', location: 'R3-1F', start_at: start, end_at: end, slots: 2,
    }, c.adminToken);
    ok(a, '志愿活动');
    const aid = a.body.item.id;
    ok(await request('POST', `/volunteer/activities/${aid}/signup`, { user_name: 'R3志愿者A' }, c.adminToken), '报名 A');
    ok(await request('POST', `/volunteer/activities/${aid}/signup`, { user_name: 'R3师傅' }, c.workerToken), '报名 B');
    const full = await request('POST', `/volunteer/activities/${aid}/signup`, { user_name: 'R3志愿者C' }, c.adminToken);
    assert([409, 422].includes(full.status), `满员后报名应拒绝，实际 ${full.status}`);
    const recs = await request('GET', `/volunteer/activities/${aid}/records`, undefined, c.adminToken);
    ok(recs, '志愿记录');
    const rid = (recs.body.items || [])[0]?.id;
    assert(!!rid, '志愿记录缺失');
    ok(await request('POST', `/volunteer/records/${rid}/checkin`, {}, c.adminToken), '志愿签到');
    ok(await request('POST', `/volunteer/records/${rid}/checkout`, {}, c.adminToken), '志愿签退');
    ok(await request('POST', `/volunteer/records/${rid}/approve`, {}, c.adminToken), '志愿核销');

    // 工人本人报名后可自助签到/签退（record.user_name == worker.name）
    const workerRec = (recs.body.items || []).find((x) => x.user_name === 'R3师傅');
    assert(!!workerRec, '师傅报名记录缺失');
    ok(await request('POST', `/volunteer/records/${workerRec.id}/checkin`, {}, c.workerToken), '师傅自助签到');
    ok(await request('POST', `/volunteer/records/${workerRec.id}/checkout`, {}, c.workerToken), '师傅自助签退');
    ok(await request('POST', `/volunteer/records/${workerRec.id}/approve`, {}, c.adminToken), '师傅记录认定');
    ok(await request('GET', '/volunteer/stats', undefined, c.adminToken), '志愿统计');
  });

  // ---------- C8 运送 → 认领 → 接单 → 送达 ----------
  await chain('C8', async (c) => {
    const o = await request('POST', '/transport/orders', {
      item_name: 'R3标本', from_loc: 'A', to_loc: 'B', priority: 'normal', order_type: 'free',
    }, c.adminToken);
    ok(o, '运送单');
    const oid = o.body.item.id;
    let detail = await request('GET', `/transport/orders/${oid}`, undefined, c.adminToken);
    if (!bodyOf(detail).carrier) {
      ok(await request('POST', `/transport/orders/${oid}/claim`, {}, c.workerToken), '运送认领');
      detail = await request('GET', `/transport/orders/${oid}`, undefined, c.adminToken);
    }
    if (bodyOf(detail).carrier !== c.workerId) {
      ok(await request('POST', `/transport/orders/${oid}/transition`, { event: 'dispatch', carrier: c.workerId }, c.adminToken), '运送改派');
      detail = await request('GET', `/transport/orders/${oid}`, undefined, c.adminToken);
    }
    eq(bodyOf(detail).carrier, c.workerId, '承运人应为认领人');
    ok(await request('POST', `/transport/orders/${oid}/transition`, { event: 'receive', loc: 'A' }, c.workerToken), '运送接单');
    ok(await request('POST', `/transport/orders/${oid}/transition`, { event: 'complete', loc: 'B', note: 'R3 送达' }, c.workerToken), '运送完成');
    detail = await request('GET', `/transport/orders/${oid}`, undefined, c.adminToken);
    eq(bodyOf(detail).status, 'done', '运送最终状态');
    const again = await request('POST', `/transport/orders/${oid}/transition`, { event: 'complete' }, c.workerToken);
    assert([409, 422].includes(again.status), `完成后重复送达应拒绝，实际 ${again.status}`);
  });

  console.log('[chain] SUMMARY', JSON.stringify({ run: RUN, results }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`[chain] ${failed.length === 0 ? 'PASS' : 'PARTIAL'} chains=${results.length} failed=${failed.length}`);
}

main()
  .then(async () => { await db.end(); process.exit(0); })
  .catch(async (e) => { console.error('[chain] FATAL', e.message); try { await db.end(); } catch { /* ignore */ } process.exit(1); });
