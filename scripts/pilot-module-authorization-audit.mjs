// 模块授权 live 验收（隔离租户 uat-module-*，结束清理）。
// 验证：租户开关 → 部门收紧 → 不同部门/角色 /auth/me 差异 → 部门成员角色分配 → 执行豁免。
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';

const { Client } = pg;
const BASE = (process.env.PILOT_API_BASE || 'http://127.0.0.1:4101/api/v1').replace(/\/+$/, '');
const RUN = (process.env.E2E_RUN_ID || `md${Date.now().toString(36)}`).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
const TENANT = `uat-module-${RUN}`;
const PASS = 'Module!2026';
const DBNAME = process.env.PGDATABASE || 'youfu_pilot';

for (const f of [process.env.ENV_FILE || '.env']) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const db = new Client({
  host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 5432),
  database: DBNAME, user: process.env.PGUSER || 'youfu_app', password: process.env.PGPASSWORD,
});

function request(method, p, body, token) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(new URL(p.startsWith('http') ? p : BASE + p), {
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
    req.on('error', (e) => resolve({ status: 0, body: { error: e.message } }));
    if (data) req.write(data);
    req.end();
  });
}

function hashPassword(p) {
  const s = crypto.randomBytes(16);
  return `scrypt$${s.toString('hex')}$${crypto.scryptSync(p, s, 64).toString('hex')}`;
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: !!ok });
  console.log(`[${ok ? 'PASS' : 'GAP'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

let deptA = '';
let deptB = '';
const accounts = {};

async function cleanup() {
  try {
    const sql = `
BEGIN;
SET LOCAL session_replication_role = replica;
DO $$ DECLARE r record; BEGIN
FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id'
LOOP EXECUTE format('DELETE FROM %I WHERE tenant_id=$1', r.table_name) USING '${TENANT}'; END LOOP; END $$;
COMMIT;`;
    execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', DBNAME, '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' });
    execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', DBNAME, '-v', 'ON_ERROR_STOP=1', '-c', `DELETE FROM platform_audit WHERE target_tenant='${TENANT}'`], { stdio: 'pipe' });
    for (const root of new Set([process.env.UPLOAD_DIR, '/opt/youfu/pilot/uploads', '/opt/youfu/uploads'].filter(Boolean))) {
      rmSync(`${root}/${TENANT}`, { recursive: true, force: true });
    }
    console.log('[module-audit] cleaned', TENANT);
  } catch (e) {
    console.error('[module-audit] cleanup failed', e.message);
  }
}

async function login(username, channel) {
  const r = await request('POST', '/auth/login', { username, password: PASS, tenant: TENANT, channel });
  if (r.status !== 200 || !r.body?.token) throw new Error(`login ${username} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

async function main() {
  await db.connect();
  await db.query('BEGIN');
  // RLS 策略依赖 app.tenant_id；隔离租户验收必须显式设置会话变量。
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  await db.query(`INSERT INTO tenant_registry (tenant_id,name,status) VALUES ($1,'模块授权验收租户','active')`, [TENANT]);
  deptA = (await db.query(`INSERT INTO dept (tenant_id,name,code,is_default,enabled) VALUES ($1,'模块A部','MODA',true,true) RETURNING id`, [TENANT])).rows[0].id;
  deptB = (await db.query(`INSERT INTO dept (tenant_id,name,code,is_default,enabled) VALUES ($1,'模块B部','MODB',false,true) RETURNING id`, [TENANT])).rows[0].id;
  for (const [u, role, dept] of [
    ['mod_admin', 'admin', null],
    ['mod_deptadmin', 'operator', deptA],
    ['mod_member', 'worker', deptA],
    ['mod_outsider', 'worker', deptB],
  ]) {
    const acc = await db.query(
      `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
       VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
      [TENANT, u, hashPassword(PASS), u, role],
    );
    accounts[u] = acc.rows[0].id;
    if (dept) {
      await db.query(
        `INSERT INTO worker (id,tenant_id,name,skill_tags,load,active,account_id,department_id)
         VALUES ($1,$2,$3,'{}'::text[],0,true,$1,$4)`,
        [acc.rows[0].id, TENANT, u, dept],
      );
    }
  }
  // 部门管理员：dept.manage + 成员执行所需最小权限；worker 权限是其子集，便于验证“只能分配已有角色”。
  for (const perm of ['dept.manage', 'dashboard.view', 'consumable.consume']) {
    await db.query(`INSERT INTO role_permission (tenant_id,role,perm) VALUES ($1,'operator',$2)`, [TENANT, perm]);
  }
  for (const perm of ['dashboard.view', 'consumable.consume']) {
    await db.query(`INSERT INTO role_permission (tenant_id,role,perm) VALUES ($1,'worker',$2)`, [TENANT, perm]);
  }
  await db.query('COMMIT');

  const admin = await login('mod_admin', 'pc');
  const deptadmin = await login('mod_deptadmin', 'pc');
  const member = await login('mod_member', 'mp');
  const outsider = await login('mod_outsider', 'mp');

  const tenantModules = await request('GET', '/tenant/modules', undefined, admin);
  check('租户模块目录默认全开', tenantModules.status === 200 && tenantModules.body.items.every((m) => m.enabled));

  const disableAsset = await request('PUT', '/tenant/modules', { modules: [{ key: 'asset', enabled: false }] }, admin);
  check('租户管理员关闭资产模块', disableAsset.status === 200 && disableAsset.body.items.find((m) => m.key === 'asset')?.enabled === false);

  const deptModules = await request('GET', `/departments/${deptA}/modules`, undefined, deptadmin);
  const assetDept = deptModules.body?.items?.find((m) => m.key === 'asset');
  check('部门可见租户上限（资产已关闭且不可再开）', deptModules.status === 200 && assetDept?.tenant_enabled === false && assetDept?.effective === false);

  // 设置中心写门禁：foundation/configuration/system 关闭后，写端点 403；读端点保留。
  const disableSettings = await request('PUT', '/tenant/modules', {
    modules: [
      { key: 'foundation', enabled: false },
      { key: 'configuration', enabled: false },
      { key: 'system', enabled: false },
    ],
  }, admin);
  check('租户关闭基础数据/业务规则/系统管理模块', disableSettings.status === 200
    && ['foundation', 'configuration', 'system'].every((k) => disableSettings.body.items.find((m) => m.key === k)?.enabled === false));

  const deptWrite = await request('POST', '/basic-data/dept', { name: '不应落库' }, admin);
  check('基础数据写被 403 MODULE_DISABLED', deptWrite.status === 403 && deptWrite.body?.code === 'MODULE_DISABLED');
  const deptRead = await request('GET', '/basic-data/dept', undefined, admin);
  check('基础数据读保留（移动端字典不受影响）', deptRead.status === 200);
  const ruleWrite = await request('POST', '/config/dispatch-rules', { name: 'x', match: {}, strategy: {} }, admin);
  check('业务规则写被 403 MODULE_DISABLED', ruleWrite.status === 403 && ruleWrite.body?.code === 'MODULE_DISABLED');
  const accountWrite = await request('POST', '/accounts', { username: 'x', password: 'xxxxxx' }, admin);
  check('账号写被 403 MODULE_DISABLED', accountWrite.status === 403 && accountWrite.body?.code === 'MODULE_DISABLED');

  const disableMaterial = await request('PUT', `/departments/${deptA}/modules`, { modules: [{ key: 'material', enabled: false }] }, deptadmin);
  check('部门管理员关闭本部门耗材模块', disableMaterial.status === 200 && disableMaterial.body.items.find((m) => m.key === 'material')?.effective === false,
    `status=${disableMaterial.status} code=${disableMaterial.body?.code ?? ''} msg=${disableMaterial.body?.message ?? ''}`);

  const modMember = await request('GET', '/auth/me', undefined, member);
  const modOutsider = await request('GET', '/auth/me', undefined, outsider);
  const modAdmin = await request('GET', '/auth/me', undefined, admin);
  check('A 部成员同时受租户+部门收紧', modMember.status === 200 && !modMember.body.modules.includes('asset') && !modMember.body.modules.includes('material'),
    `status=${modMember.status} modules=${Array.isArray(modMember.body?.modules) ? modMember.body.modules.join(',') : 'n/a'}`);
  check('B 部成员只受租户收紧（部门隔离）', modOutsider.status === 200 && !modOutsider.body.modules.includes('asset') && modOutsider.body.modules.includes('material'));
  check('租户管理员忽略部门收紧（仍受租户上限）', modAdmin.status === 200 && !modAdmin.body.modules.includes('asset') && modAdmin.body.modules.includes('material'));

  const assignSelf = await request('PUT', `/departments/${deptA}/members/${accounts.mod_member}/role`, { role: 'worker' }, deptadmin);
  check('部门管理员分配已有低权角色', assignSelf.status === 200 && assignSelf.body.item?.role === 'worker',
    `status=${assignSelf.status} code=${assignSelf.body?.code ?? ''} msg=${assignSelf.body?.message ?? ''}`);

  const assignAdmin = await request('PUT', `/departments/${deptA}/members/${accounts.mod_member}/role`, { role: 'admin' }, deptadmin);
  check('部门管理员不能分配 admin', assignAdmin.status === 403);

  const outsiderRole = await request('PUT', `/departments/${deptB}/members/${accounts.mod_member}/role`, { role: 'worker' }, deptadmin);
  check('部门管理员不能操作其他部门成员', outsiderRole.status === 403 || outsiderRole.status === 404);

  // 角色变更会递增 token_version，旧 token 按设计失效；重新登录后再验证模块门禁。
  const memberAfterRole = await login('mod_member', 'mp');

  // 耗材模块已在 A 部关闭：领料（个人任务执行）必须放行到业务校验；仓库入库（管理写）必须被模块门禁拦截。
  const consume = await request('POST', '/inventory/consume', {}, memberAfterRole);
  check('模块关闭时个人领料不被模块门禁拦截', consume.status === 400, `status=${consume.status} code=${consume.body?.code ?? ''} msg=${consume.body?.message ?? ''}`);
  const inventoryIn = await request('POST', '/inventory/in', { material_id: '11111111-1111-4111-8111-111111111111', qty: 1 }, memberAfterRole);
  check('模块关闭时仓库管理写被 403 MODULE_DISABLED', inventoryIn.status === 403 && inventoryIn.body?.code === 'MODULE_DISABLED');

  const summary = { total: checks.length, pass: checks.filter((c) => c.ok).length, gaps: checks.filter((c) => !c.ok).map((c) => c.name) };
  console.log('SUMMARY=' + JSON.stringify(summary, null, 2));
  await cleanup();
  await db.end();
  process.exit(summary.gaps.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error('FATAL', e);
  try { await cleanup(); } catch {}
  process.exit(1);
});
