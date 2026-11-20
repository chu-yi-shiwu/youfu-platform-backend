// 资产报障流程预检（2026-11-20）
// 用法：ENV_FILE=.env node scripts/asset-workflow-preflight.mjs [tenant ...]
// 退出码：0 = 全部租户可发布；1 = 存在取消/完成路径缺失。
import { readFileSync, existsSync } from 'node:fs';
import pg from 'pg';
import { getWorkflowDef } from '../dist/engine/workflowDef.js';
import { analyzeWorkflowReadiness } from '../dist/services/assetWorkflowReadiness.js';

const { Client } = pg;

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

const argTenants = process.argv.slice(2).filter((x) => !x.startsWith('-'));
let failed = false;

try {
  await db.connect();
  let tenants = argTenants;
  if (tenants.length === 0) {
    const r = await db.query(`SELECT tenant_id FROM tenant_registry WHERE status='active' ORDER BY tenant_id`);
    tenants = r.rows.map((x) => x.tenant_id);
  }
  for (const tenant of tenants) {
    await db.query('BEGIN');
    try {
      await db.query(`SELECT set_config('app.tenant_id',$1,true), set_config('app.scope','system',true)`, [tenant]);
      const def = await getWorkflowDef(db, tenant, 'work_order');
      const result = analyzeWorkflowReadiness(def);
      console.log(`[${tenant}] ${result.ok ? 'PASS' : 'FAIL'} cancel_from=${result.cancel_from.join(',') || '-'} done=${result.done_from.join(',') || '-'}`);
      for (const issue of result.issues) console.log(`  - ${issue.code}: ${issue.message}`);
      if (!result.ok) failed = true;
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
  }
  await db.end();
  process.exit(failed ? 1 : 0);
} catch (e) {
  console.error('FATAL', e);
  try { await db.end(); } catch {}
  process.exit(1);
}
