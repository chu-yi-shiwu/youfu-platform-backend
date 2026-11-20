// Round 3 · Phase 2：跨模块业务链 C9–C16
//
// C9 陪检 / C10 流程版本 / C11 规则与术语 / C12 权限即时生效 /
// C13 账号停用与任务转派 / C14 结算锁定与作废 / C15 通知 / C16 反馈统计导出
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
        resolve({ status: res.statusCode, body: parsed, raw });
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
  return signJwt({ sub: accountId, tid: tenant, role, username, tv: 0, iat: now, exp: now + 3600 }, process.env.JWT_SECRET);
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

async function createAssignedOrder(c, title) {
  const r = await request('POST', '/open/work_order', {
    id: crypto.randomUUID(), business_type: 'repair', catalog: c.catCode,
    title, description: title, location: 'R3-1F', priority: 'normal', skill_tags: [c.skill],
  }, c.adminToken);
  ok(r, '建单');
  let id = r.body.id;
  if (r.body.assignee !== c.workerId) {
    ok(await request('POST', `/open/work_order/${id}/transition`, { to: 'assigned', assignee: c.workerId }, c.adminToken), '派单');
  }
  return id;
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

  // ---------- C9 陪检登记 → 工单 → 派单 → 完成 → 通知 ----------
  await chain('C9', async (c) => {
    const r = await request('POST', '/open/work_order', {
      id: crypto.randomUUID(), business_type: 'escort', priority: 'normal',
      title: 'R3陪检登记', description: 'R3 陪检', location: 'R3-1F', skill_tags: [c.skill],
    }, c.adminToken);
    ok(r, '陪检登记');
    const id = r.body.id;
    const detail = await request('GET', `/open/work_order/${id}`, undefined, c.adminToken);
    eq(bodyOf(detail).business_type, 'escort', '陪检业务类型');
    if (bodyOf(detail).assignee_id !== c.workerId) {
      ok(await request('POST', `/open/work_order/${id}/transition`, { to: 'assigned', assignee: c.workerId }, c.adminToken), '陪检派单');
    }
    ok(await request('POST', `/open/work_order/${id}/transition`, { to: 'arrived' }, c.workerToken), '陪检到场');
    ok(await request('POST', `/open/work_order/${id}/transition`, { to: 'processing' }, c.workerToken), '陪检开始');
    ok(await request('POST', `/open/work_order/${id}/transition`, { to: 'pending_review' }, c.workerToken), '陪检提交');
    ok(await request('POST', `/open/work_order/${id}/transition`, { to: 'review_passed' }, c.adminToken), '陪检复核');
    ok(await request('POST', `/open/work_order/${id}/transition`, { to: 'completed' }, c.adminToken), '陪检完成');
    const n = await request('GET', `/open/notifications?recipient=${encodeURIComponent(c.workerId)}`, undefined, c.workerToken);
    ok(n, '陪检通知');
    assert((n.body.items || []).length >= 1, '陪检应产生站内通知');
  });

  // ---------- C10 流程版本：在途单锁旧版，新单新版 ----------
  await chain('C10', async (c) => {
    const oldOrder = await createAssignedOrder(c, 'R3流程版本-旧单');
    const oldDetail = await request('GET', `/open/work_order/${oldOrder}`, undefined, c.adminToken);
    const oldVer = Number(bodyOf(oldDetail).def_version);
    assert(oldVer >= 1, `旧单应有 def_version，实际 ${oldVer}`);

    const wf = await request('GET', '/workflow-defs/work_order', undefined, c.adminToken);
    ok(wf, '读取流程');
    const newDef = JSON.parse(JSON.stringify(wf.body.def));
    if (!newDef.states.includes('archived_r3')) newDef.states.push('archived_r3');
    newDef.transitions = (newDef.transitions || []).filter((t) => t.event !== 'archive_r3');
    newDef.transitions.push({ from: 'evaluated', to: 'archived_r3', event: 'archive_r3' });

    // 097 归属闸门：pilot 的流程配置归平台运维，租户侧编辑必须 403，不能绕过。
    const draft = await request('PUT', '/workflow-defs/work_order/draft', { def: newDef, note: 'R3 新增归档态' }, c.adminToken);
    eq(draft.status, 403, '租户侧改流程应 403');
    eq(draft.body.code, 'WORKFLOW_CONFIG_PLATFORM_ONLY', '租户侧改流程错误码');

    // 模拟平台运维发布新版本：历史表留旧版快照，live 行推进版本。
    // （workflow_def 是每实体一行；历史版本在 workflow_def_history，引擎按 def_version 回查。）
    const newVer = oldVer + 1;
    await db.query('BEGIN');
    try {
      await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [c.tenant]);
      await db.query(
        `INSERT INTO workflow_def_history (tenant_id,entity_type,version,def,operator,reason)
         VALUES ($1,'work_order',$2,$3::jsonb,'platform-r3','R3 seed old version')
         ON CONFLICT (tenant_id,entity_type,version) DO NOTHING`,
        [c.tenant, oldVer, JSON.stringify(wf.body.def)],
      );
      await db.query(
        `UPDATE workflow_def SET def=$2::jsonb, version=$3, updated_at=now(), updated_by='platform-r3'
         WHERE tenant_id=$1 AND entity_type='work_order'`,
        [c.tenant, JSON.stringify(newDef), newVer],
      );
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }

    const wf2 = await request('GET', '/workflow-defs/work_order', undefined, c.adminToken);
    assert((wf2.body.def.states || []).includes('archived_r3'), '新流程应包含归档态');
    const versions = await request('GET', '/workflow-defs/work_order/versions', undefined, c.adminToken);
    ok(versions, '版本列表');
    eq(Number(versions.body.currentVersion), newVer, '当前流程版本');
    assert((versions.body.history || []).length >= 1, '历史版本应至少 1 条');

    const oldStill = await request('GET', `/open/work_order/${oldOrder}`, undefined, c.adminToken);
    eq(Number(bodyOf(oldStill).def_version), oldVer, '在途单版本不应被改写');
    ok(await request('POST', `/open/work_order/${oldOrder}/transition`, { to: 'arrived' }, c.workerToken), '旧单按旧版流转');

    const newOrder = await createAssignedOrder(c, 'R3流程版本-新单');
    const newDetail = await request('GET', `/open/work_order/${newOrder}`, undefined, c.adminToken);
    assert(Number(bodyOf(newDetail).def_version) > oldVer, `新单应使用新版本，旧=${oldVer} 新=${bodyOf(newDetail).def_version}`);
  });

  // ---------- C11 派单规则 + 术语 ----------
  await chain('C11', async (c) => {
    const rule = await request('POST', '/config/dispatch-rules', {
      name: `R3规则-${RUN}`, priority: 200,
      match_json: { business_type: 'repair' }, strategy_json: { type: 'load_balance' }, enabled: true,
    }, c.adminToken);
    ok(rule, '新建派单规则');
    const rid = rule.body.item.id;
    const list = await request('GET', '/config/dispatch-rules', undefined, c.adminToken);
    assert((list.body.items || []).some((x) => x.id === rid), '规则列表缺少新规则');
    const order = await createAssignedOrder(c, 'R3规则生效-新单');
    assert(!!order, '规则变更后建单失败');

    const term = await request('POST', '/config/terms', {
      module: 'global', code: `R3_TERM_${RUN}`, default_label: 'R3术语',
    }, c.adminToken);
    ok(term, '新增术语');
    ok(await request('GET', '/meta/labels/me', undefined, c.adminToken), '术语/标签读取');
    ok(await request('DELETE', `/config/terms/${term.body.item.id}`, undefined, c.adminToken), '删除术语');
    ok(await request('DELETE', `/config/dispatch-rules/${rid}`, undefined, c.adminToken), '删除规则');
  });

  // ---------- C12 权限变更立即生效 ----------
  await chain('C12', async (c) => {
    const before = await request('GET', '/accounts', undefined, c.opToken);
    eq(before.status, 403, 'operator 初始不应能读账号');

    const perms = await request('GET', '/accounts/roles/permissions', undefined, c.adminToken);
    ok(perms, '读取权限矩阵');
    const opRow = (perms.body.items || []).find((x) => x.role === 'operator');
    assert(!!opRow, '缺少 operator 权限行');
    const nextPerms = Array.from(new Set([...(opRow.perms || []), 'role.manage']));
    ok(await request('PUT', '/accounts/roles/operator/permissions', { perms: nextPerms }, c.adminToken), '授予 role.manage');
    const afterGrant = await request('GET', '/accounts', undefined, c.opToken);
    eq(afterGrant.status, 200, '授权后旧 token 应立即生效');

    ok(await request('PUT', '/accounts/roles/operator/permissions', { perms: opRow.perms || [] }, c.adminToken), '回收 role.manage');
    const afterRevoke = await request('GET', '/accounts', undefined, c.opToken);
    eq(afterRevoke.status, 403, '回收后旧 token 应立即失效');
  });

  // ---------- C13 账号停用 → token 失效 → 任务转派 ----------
  await chain('C13', async (c) => {
    await db.query('BEGIN');
    let acc2Id = '';
    try {
      await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [c.tenant]);
      const acc2 = await db.query(
        `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
         VALUES ($1,$2,$3,'R3师傅2','worker',true) RETURNING id`,
        [c.tenant, 'r3_worker2', hashPassword(PASS)],
      );
      acc2Id = acc2.rows[0].id;
      const worker2 = `R3-C13B-${RUN}`;
      await db.query(
        `INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id,department_id)
         VALUES ($1,$2,'R3师傅2',$3::text[],0,true,$4,$5)`,
        [worker2, c.tenant, ['repair', c.skill], acc2Id, c.deptId],
      );
      await db.query('COMMIT');
      c.worker2 = worker2;
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
    const worker2 = c.worker2;
    const token2 = token(acc2Id, 'worker', c.tenant, 'r3_worker2');
    const alive = await request('GET', '/open/work_orders', undefined, token2);
    eq(alive.status, 200, '删除前 token 应可用');

    const order = await createAssignedOrder(c, 'R3账号停用-任务');
    ok(await request('POST', `/open/work_order/${order}/transition`, { to: 'assigned', assignee: worker2 }, c.adminToken), '改派给师傅2');

    ok(await request('DELETE', `/accounts/${acc2Id}`, undefined, c.adminToken), '删除师傅2账号');
    const dead = await request('GET', '/open/work_orders', undefined, token2);
    assert([401, 403].includes(dead.status), `删除账号后 token 应失效，实际 ${dead.status}`);

    ok(await request('POST', `/open/work_order/${order}/transition`, { to: 'assigned', assignee: c.workerId }, c.adminToken), '任务转回主师傅');
    const detail = await request('GET', `/open/work_order/${order}`, undefined, c.adminToken);
    eq(bodyOf(detail).assignee_id, c.workerId, '任务应已转派');
  });

  // ---------- C14 结算锁定 + 作废解锁 ----------
  await chain('C14', async (c) => {
    const order = await createAssignedOrder(c, 'R3结算锁定');
    ok(await request('POST', `/open/work_order/${order}/transition`, { to: 'arrived' }, c.workerToken), '到场');
    ok(await request('POST', `/open/work_order/${order}/transition`, { to: 'processing' }, c.workerToken), '处理');
    ok(await request('POST', `/open/work_order/${order}/transition`, { to: 'pending_review' }, c.workerToken), '提交');
    ok(await request('POST', `/open/work_order/${order}/transition`, { to: 'review_passed' }, c.adminToken), '复核');
    ok(await request('POST', `/open/work_order/${order}/transition`, { to: 'completed' }, c.adminToken), '完成');

    const mat = await request('POST', '/materials', { code: `R3-C14-${RUN}`, name: 'R3C14耗材', unit: '个', price: 5, enabled: true }, c.adminToken);
    const materialId = mat.body.item.id;
    ok(await request('POST', '/inventory/in', { material_id: materialId, qty: 5 }, c.adminToken), '入库');

    const st = await request('POST', '/settlements', { work_order_ids: [order] }, c.adminToken);
    ok(st, '建结算');
    const sid = st.body.settlement?.id || st.body.settlement?.settlement?.id;
    ok(await request('POST', `/settlements/${sid}/confirm`, {}, c.adminToken), '确认结算');
    const orderDetail = await request('GET', `/open/work_order/${order}`, undefined, c.adminToken);
    const orderNo = bodyOf(orderDetail).order_no;

    const blocked = await request('POST', '/inventory/out', {
      material_id: materialId, qty: 1, work_order_no: orderNo,
    }, c.adminToken);
    assert([409, 422, 423].includes(blocked.status), `确认后挂单出库应被锁定，实际 ${blocked.status} ${JSON.stringify(blocked.body)}`);

    // 工单 completed 后领料本身永久关闭（ORDER_CLOSED），这是独立口径，不是结算锁。
    const consumeClosed = await request('POST', '/inventory/consume', {
      work_order_id: order, items: [{ material_id: materialId, qty: 1 }],
    }, c.workerToken);
    eq(consumeClosed.status, 422, 'completed 工单领料应 422');
    eq(consumeClosed.body.code, 'ORDER_CLOSED', 'completed 工单领料错误码');

    ok(await request('POST', `/settlements/${sid}/void`, { void_reason: 'R3 作废测试' }, c.adminToken), '作废结算');
    const unlocked = await request('POST', '/inventory/out', {
      material_id: materialId, qty: 1, work_order_no: orderNo,
    }, c.adminToken);
    ok(unlocked, '作废后挂单出库应恢复');
    const inv = await request('GET', '/inventory', undefined, c.adminToken);
    const row = (inv.body.items || []).find((x) => x.material_id === materialId);
    eq(Number(row?.qty), 4, '作废后出库 1 库存应为 4');
  });

  // ---------- C15 通知中心 ----------
  await chain('C15', async (c) => {
    const order = await createAssignedOrder(c, 'R3通知中心');
    const list = await request('GET', `/open/notifications?recipient=${encodeURIComponent(c.workerId)}`, undefined, c.workerToken);
    ok(list, '通知列表');
    const items = list.body.items || [];
    assert(items.length >= 1, '应有站内通知');
    const first = items[0];
    eq(first.channel || 'in_app', 'in_app', '通知列表只应包含站内信');
    ok(await request('POST', '/open/notifications/read', { ids: [first.id] }, c.workerToken), '单条已读');
    ok(await request('POST', '/open/notifications/read', {}, c.workerToken), '全部已读');
    const after = await request('GET', `/open/notifications?recipient=${encodeURIComponent(c.workerId)}`, undefined, c.workerToken);
    assert((after.body.items || []).every((x) => x.read), '全部已读后不应有未读');
    const forbidden = await request('GET', `/open/notifications?recipient=${encodeURIComponent(c.workerId)}`, undefined, c.adminToken);
    eq(forbidden.status, 403, '管理员不能读工人收件箱');
    assert(!!order, '通知链工单');
  });

  // ---------- C16 反馈 → 统计 → 导出 / 过程挖掘 ----------
  await chain('C16', async (c) => {
    const order = await createAssignedOrder(c, 'R3反馈关联');
    const detail = await request('GET', `/open/work_order/${order}`, undefined, c.adminToken);
    const orderNo = bodyOf(detail).order_no;
    const f = await request('POST', '/feedback', {
      type: 'opinion', content: 'R3 反馈内容', channel: 'desk', work_order_no: orderNo,
    }, c.adminToken);
    ok(f, '提交反馈');
    const fid = f.body.item.id;
    const list = await request('GET', '/feedback', undefined, c.adminToken);
    assert((list.body.items || []).some((x) => x.id === fid), '反馈列表缺少新反馈');
    ok(await request('POST', `/feedback/${fid}/reply`, { reply: 'R3 已处理' }, c.adminToken), '回复反馈');
    ok(await request('GET', '/feedback/stats', undefined, c.adminToken), '反馈统计');
    const exp = await request('GET', '/feedback/export', undefined, c.adminToken);
    ok(exp, '反馈导出');
    assert(exp.raw.length > 0, '导出内容为空');
    ok(await request('GET', '/process-mining?entityType=work_order&days=30&limit=100', undefined, c.adminToken), '过程挖掘');
    ok(await request('GET', '/stats', undefined, c.adminToken), '统计');
  });

  console.log('[chain] SUMMARY', JSON.stringify({ run: RUN, results }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`[chain] ${failed.length === 0 ? 'PASS' : 'PARTIAL'} chains=${results.length} failed=${failed.length}`);
}

main()
  .then(async () => { await db.end(); process.exit(0); })
  .catch(async (e) => { console.error('[chain] FATAL', e.message); try { await db.end(); } catch { /* ignore */ } process.exit(1); });
