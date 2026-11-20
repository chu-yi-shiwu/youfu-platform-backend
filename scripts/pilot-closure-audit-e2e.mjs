// 方向 A 业务闭环补齐 · 线上审计（隔离 UAT 租户）
// 覆盖：基础数据停用、反馈关闭、设备保养、应急转工单、耗材退库、结算作废、资产维修回写。
// 运行：在 /opt/youfu/pilot/backend 下 PGDATABASE=youfu_pilot ENV_FILE=.env node scripts/pilot-closure-audit-e2e.mjs
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { signJwt } from '../dist/middleware/auth.js';

const { Client } = pg;
const BASE = 'http://127.0.0.1:4101/api/v1';
const UPLOAD_ROOT = '/opt/youfu/pilot/uploads';
const RUN = `cl${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const TENANT = `uat-closure-${RUN}`;
const PASS = 'Closure!2026';

function loadEnv() {
  for (const f of ['.env', '/opt/youfu/pilot/initial-credentials.txt']) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();

const db = new Client({
  host: process.env.PGHOST || '127.0.0.1', port: 5432, database: process.env.PGDATABASE || 'youfu_pilot',
  user: process.env.PGUSER || 'youfu_app', password: process.env.PGPASSWORD,
});
function hash(p) { const s = crypto.randomBytes(16); return `scrypt$${s.toString('hex')}$${crypto.scryptSync(p, s, 64).toString('hex')}`; }
function request(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const u = new URL(p.startsWith('http') ? p : BASE + p);
    const r = http.request(u, {
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
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); };
const results = [];
function record(name, status, note) { results.push({ name, status, note }); console.log(`[closure] ${status} ${name}${note ? ' — ' + note : ''}`); }

async function sql(q, params = []) {
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  const r = await db.query(q, params);
  await db.query('COMMIT');
  return r;
}

async function cleanup() {
  const q = `BEGIN; SET LOCAL session_replication_role = replica;
DO $$ DECLARE r record; BEGIN
FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id'
LOOP EXECUTE format('DELETE FROM %I WHERE tenant_id=$1', r.table_name) USING '${TENANT}'; END LOOP; END $$; COMMIT;`;
  try { execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', process.env.PGDATABASE || 'youfu_pilot', '-v', 'ON_ERROR_STOP=1', '-c', q], { stdio: 'pipe' }); } catch (e) { console.error('cleanup', e.message); }
  rmSync(path.join(UPLOAD_ROOT, TENANT), { recursive: true, force: true });
}

async function main() {
  await db.connect();
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  await db.query(`INSERT INTO tenant_registry (tenant_id,name,status) VALUES ($1,'Closure UAT','active')`, [TENANT]);
  const admin = await db.query(`INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active) VALUES ($1,'closure_admin',$2,'闭环管理员','admin',true) RETURNING id`, [TENANT, hash(PASS)]);
  // 关联工单（资产报障/预警转单）需要责任部门；给 UAT 租户建一个默认部门。
  await db.query(`INSERT INTO dept (tenant_id,name,code,is_default) VALUES ($1,'后勤部','CLOS-DEPT',true)`, [TENANT]);
  await db.query('COMMIT');
  const now = Math.floor(Date.now() / 1000);
  const token = signJwt({ sub: admin.rows[0].id, tid: TENANT, role: 'admin', username: 'closure_admin', tv: 0, iat: now, exp: now + 3600 }, process.env.JWT_SECRET);

  // 1) 基础数据停用优先
  const dept = await request('POST', '/basic-data/dept', { name: '停用科室', code: `D-${RUN}`, enabled: false }, token);
  assert(dept.status === 201, `建停用部门 ${dept.status}`);
  const listDefault = await request('GET', '/basic-data/dept', undefined, token);
  record('基础数据停用：默认列表不含停用项', listDefault.status === 200 && !(listDefault.body.items || []).some((x) => x.id === dept.body.item.id) ? 'PASS' : 'FAIL');
  const listAll = await request('GET', '/basic-data/dept?include_disabled=1', undefined, token);
  record('基础数据停用：include_disabled=1 可见', listAll.status === 200 && (listAll.body.items || []).some((x) => x.id === dept.body.item.id) ? 'PASS' : 'FAIL');
  const enable = await request('PUT', `/basic-data/dept/${dept.body.item.id}`, { enabled: true }, token);
  record('基础数据停用：可重新启用', enable.status === 200 && enable.body.item?.enabled === true ? 'PASS' : `HTTP ${enable.status}`);

  // 2) 反馈关闭
  const fb = await request('POST', '/feedback', { type: 'opinion', content: '闭环审计反馈' }, token);
  assert(fb.status === 201, `建反馈 ${fb.status}`);
  const close1 = await request('POST', `/feedback/${fb.body.item.id}/close`, { note: '已回访' }, token);
  record('反馈关闭：closed + 留痕', close1.status === 200 && close1.body.item?.status === 'closed' && close1.body.item?.closed_by === 'closure_admin' ? 'PASS' : `HTTP ${close1.status}`);
  const close2 = await request('POST', `/feedback/${fb.body.item.id}/close`, {}, token);
  record('反馈关闭：重复关闭 409', close2.status === 409 ? 'PASS' : `HTTP ${close2.status}`);
  const replyClosed = await request('POST', `/feedback/${fb.body.item.id}/reply`, { reply: '再处理' }, token);
  record('反馈关闭：关闭后回复 409（回绝重开）', replyClosed.status === 409 ? 'PASS' : `HTTP ${replyClosed.status}`);

  // 3) 设备保养
  const eq = await request('POST', '/equipment/equipment', { name: '闭环测试设备', code: `EQ-${RUN}`, status: 'in_use' }, token);
  assert(eq.status === 201, `建设备 ${eq.status}`);
  const mt = await request('POST', `/equipment/${eq.body.item.id}/maintenances`, { mtype: 'maintain', plan_date: '2026-11-01', responsible: '审计', note: '闭环' }, token);
  record('设备保养：新增 201', mt.status === 201 ? 'PASS' : `HTTP ${mt.status}`);
  const mtList = await request('GET', `/equipment/${eq.body.item.id}/maintenances`, undefined, token);
  record('设备保养：列表回读', mtList.status === 200 && (mtList.body.items || []).length === 1 ? 'PASS' : `HTTP ${mtList.status}`);

  // 4) 应急转工单
  const alert = await request('POST', '/emergency/alerts', { source_type: 'manual', level: 'L2', title: `闭环预警${RUN}` }, token);
  assert(alert.status === 201, `建预警 ${alert.status}`);
  const convert = await request('POST', `/emergency/alerts/${alert.body.item.id}/convert`, {}, token);
  record('应急转工单：生成工单', convert.status === 200 && !!convert.body.result?.orderNo ? 'PASS' : `HTTP ${convert.status} ${JSON.stringify(convert.body)}`);

  // 5) 资产故障 → 维修工单 → 完成后资产回写
  const asset = await request('POST', '/assets', { name: '闭环测试资产', status: 'in_use' }, token);
  assert(asset.status === 201, `建资产 ${asset.status}`);
  const fault = await request('POST', `/assets/${asset.body.item.id}/fault`, { description: '闭环测试故障' }, token);
  assert(fault.status === 200, `资产报障 ${fault.status} ${JSON.stringify(fault.body)}`);
  const woId = fault.body.result?.id;
  const woNo = fault.body.result?.orderNo;
  const repairing = await sql(`SELECT status FROM asset WHERE tenant_id=$1 AND id=$2`, [TENANT, asset.body.item.id]);
  record('资产报障：状态 repairing', repairing.rows[0]?.status === 'repairing' ? 'PASS' : String(repairing.rows[0]?.status));
  // 夹具：把工单推进到 processing，便于走 completed 流转与耗材消耗
  await sql(`UPDATE work_orders SET status='processing' WHERE tenant_id=$1 AND id=$2`, [TENANT, woId]);

  // 6) 耗材入库 → 挂单消耗 → 退库
  const mat = await request('POST', '/materials', { code: `M-${RUN}`, name: '闭环测试耗材', unit: '个', price: 1 }, token);
  assert(mat.status === 201, `建耗材 ${mat.status}`);
  const mid = mat.body.item.id;
  const stockIn = await request('POST', '/inventory/in', { material_id: mid, warehouse: '中心库', qty: 5 }, token);
  assert(stockIn.status === 200, `入库 ${stockIn.status}`);
  const consume = await request('POST', '/inventory/consume', { work_order_id: woId, items: [{ material_id: mid, qty: 2 }] }, token);
  record('耗材：挂单消耗 200', consume.status === 200 ? 'PASS' : `HTTP ${consume.status}`);
  const ret = await request('POST', '/inventory/return', { material_id: mid, work_order_no: woNo, qty: 1, note: '退库审计' }, token);
  record('耗材退库：接口 200', ret.status === 200 ? 'PASS' : `HTTP ${ret.status}`);
  const inv = await sql(`SELECT qty FROM inventory WHERE tenant_id=$1 AND material_id=$2 AND warehouse='中心库'`, [TENANT, mid]);
  record('耗材退库：库存回补（5-2+1=4）', Number(inv.rows[0]?.qty) === 4 ? 'PASS' : `qty=${inv.rows[0]?.qty}`);

  // 7) 工单完成 → 资产回写
  const done = await request('POST', `/open/work_order/${woId}/transition`, { to: 'completed' }, token);
  record('工单完成：流转 200', done.status === 200 ? 'PASS' : `HTTP ${done.status} ${JSON.stringify(done.body?.message || '')}`);
  const inUse = await sql(`SELECT status FROM asset WHERE tenant_id=$1 AND id=$2`, [TENANT, asset.body.item.id]);
  record('资产维修回写：completed → in_use', inUse.rows[0]?.status === 'in_use' ? 'PASS' : `status=${inUse.rows[0]?.status}`);

  // 8) 结算确认 → 作废 → 导出拒绝
  const setIns = await sql(
    `INSERT INTO settlement (tenant_id, settlement_no, status, total, item_count, created_at, updated_at)
     VALUES ($1,$2,'draft',10,1,now(),now()) RETURNING id`,
    [TENANT, `ST-${RUN}`],
  );
  const sid = setIns.rows[0].id;
  await sql(
    `INSERT INTO settlement_item (tenant_id, settlement_id, work_order_id, category_name, price, qty, amount)
     VALUES ($1,$2,$3,'测试',$4,1,$5)`,
    [TENANT, sid, `WO-SET-${RUN}`, 10, 10],
  );
  const confirm = await request('POST', `/settlements/${sid}/confirm`, {}, token);
  record('结算：确认锁定 200', confirm.status === 200 ? 'PASS' : `HTTP ${confirm.status}`);
  const voided = await request('POST', `/settlements/${sid}/void`, { void_reason: '审计作废' }, token);
  record('结算作废：voided + 原因留痕', voided.status === 200 && voided.body.settlement?.status === 'voided' && voided.body.settlement?.voided_reason === '审计作废' ? 'PASS' : `HTTP ${voided.status}`);
  const exp = await request('GET', `/settlements/${sid}/export`, undefined, token);
  record('结算作废：导出 409', exp.status === 409 ? 'PASS' : `HTTP ${exp.status}`);

  const fails = results.filter((r) => r.status !== 'PASS');
  console.log('[closure] SUMMARY', JSON.stringify(results, null, 2));
  if (fails.length) console.log(`[closure] GAPS=${fails.length}`);
  else console.log('[closure] NO_GAPS');
  await db.end();
}

try {
  await main();
} finally {
  await cleanup();
  console.log('[closure] cleaned', TENANT);
}
