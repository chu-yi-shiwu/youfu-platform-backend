// CSV 往返验证：中文表头导入 → 导出 → 字段/日期/名称映射；隔离租户，结束清理。
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
const RUN = `csv${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const TENANT = `uat-csv-${RUN}`;
const db = new Client({
  host: process.env.PGHOST || '127.0.0.1', port: 5432, database: process.env.PGDATABASE || 'youfu_pilot',
  user: process.env.PGUSER || 'youfu_app', password: process.env.PGPASSWORD,
});

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

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const u = new URL(BASE + p);
    const r = http.request(u, {
      method,
      headers: {
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(data.length) } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const json = (r) => { try { return JSON.parse(r.body); } catch { return {}; } };
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); };

async function cleanup() {
  const sql = `BEGIN; SET LOCAL session_replication_role = replica;
DO $$ DECLARE r record; BEGIN
FOR r IN SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id'
LOOP EXECUTE format('DELETE FROM %I WHERE tenant_id=$1', r.table_name) USING '${TENANT}'; END LOOP; END $$; COMMIT;`;
  try { execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', process.env.PGDATABASE || 'youfu_pilot', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' }); } catch (e) { console.error('cleanup', e.message); }
  rmSync(path.join(UPLOAD_ROOT, TENANT), { recursive: true, force: true });
}

async function main() {
  await db.connect();
  await db.query('BEGIN');
  await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [TENANT]);
  await db.query(`INSERT INTO tenant_registry (tenant_id,name,status) VALUES ($1,'CSV UAT','active')`, [TENANT]);
  const a = await db.query(
    `INSERT INTO account_user (tenant_id,username,password_hash,display_name,role,active)
     VALUES ($1,'csv_admin','x','CSV管理员','admin',true) RETURNING id`,
    [TENANT],
  );
  await db.query('COMMIT');
  const now = Math.floor(Date.now() / 1000);
  const token = signJwt({ sub: a.rows[0].id, tid: TENANT, role: 'admin', username: 'csv_admin', tv: 0, iat: now, exp: now + 3600 }, process.env.JWT_SECRET);

  // 资产
  let r = await req('POST', '/assets/import', { csv: '资产名称,型号,位置,状态,购置日期\nCSV测试资产,A1,1F,在用,2026-01-02\n' }, token);
  assert(json(r).inserted === 1, '资产中文表头导入');
  r = await req('GET', '/assets/export', undefined, token);
  assert(r.body.includes('资产名称'), '资产导出中文表头');
  assert(r.body.includes('2026-01-02'), '资产导出日期格式');
  assert(r.body.includes('在用'), '资产导出状态中文');

  // 耗材
  r = await req('POST', '/materials/import', { csv: '材料编号,材料名称,类别,启用\nCSV-M1,CSV耗材,耗材,是\n' }, token);
  assert(json(r).inserted === 1, '耗材中文表头导入');
  r = await req('GET', '/materials/export', undefined, token);
  assert(r.body.includes('材料编号') && r.body.includes('启用'), '耗材导出中文表头');

  // 设备类型 + 设备（中文名称解析）
  r = await req('POST', '/equipment/type', { code: `CSV-T-${RUN}`, name: 'CSV空调' }, token);
  assert(r.status === 201, '建设备类型');
  r = await req('POST', '/equipment/vendor', { code: `CSV-V-${RUN}`, name: 'CSV厂商' }, token);
  assert(r.status === 201, '建设备厂商');
  r = await req('POST', '/equipment/equipment/import', {
    csv: '设备名称,设备编号,设备类型,设备厂商,状态,购置日期\nCSV设备,CSV-EQ,CSV空调,CSV厂商,在用,2026-02-03\n',
  }, token);
  const eq = json(r);
  assert(eq.inserted === 1, `设备中文表头导入：${r.body}`);
  r = await req('GET', '/equipment/equipment/export', undefined, token);
  assert(r.body.includes('CSV空调') && r.body.includes('CSV厂商'), '设备导出类型/厂商名称');
  assert(r.body.includes('2026-02-03'), '设备导出日期格式');

  // 基础数据部门
  r = await req('POST', '/basic-data/dept/import', { csv: '部门名称,编码,备注\nCSV部门,CSV-DEPT,测试\n' }, token);
  const dept = json(r);
  assert(dept.inserted === 1, `部门中文表头导入：${r.body}`);
  r = await req('GET', '/basic-data/dept/export', undefined, token);
  assert(r.body.includes('部门名称') && r.body.includes('CSV部门'), '部门导出中文表头/值');

  console.log('[csv] PASS');
}

main()
  .then(async () => { await cleanup(); await db.end(); console.log('[csv] cleaned', TENANT); process.exit(0); })
  .catch(async (e) => { console.error('[csv] FAIL', e.message); await cleanup(); try { await db.end(); } catch {} process.exit(1); });
