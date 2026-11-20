// 微信通知失败诊断（2026-11-20）
// 只读：按失败原因分类，并检查环境变量是否配置；不打印密钥。
// 用法：ENV_FILE=.env node scripts/wechat-notify-diagnose.mjs
import { readFileSync, existsSync } from 'node:fs';
import pg from 'pg';

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

const mask = (v) => (!v ? 'MISSING' : v.length <= 6 ? 'SET' : `${v.slice(0, 3)}***${v.slice(-2)}`);
const db = new Client({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'youfu_pilot',
  user: process.env.PGUSER || 'youfu_app',
  password: process.env.PGPASSWORD,
});

const tenant = process.argv[2] || process.env.DIAG_TENANT || '';
const params = [tenant || 'zixing-hospital'];
let where = `channel='wechat' AND delivered=false AND tenant_id=$1 AND created_at > now() - interval '365 days'`;

try {
  await db.connect();
  // 诊断脚本必须显式设置租户上下文，否则 RLS 会把 notification 过滤为空。
  const diagTenant = tenant || 'zixing-hospital';
  await db.query("SELECT set_config('app.tenant_id',$1,false), set_config('app.scope','system',false)", [diagTenant]);
  const r = await db.query(
    `SELECT COALESCE(payload->>'_note', '(no note)') AS reason, count(*)::int AS count
       FROM notification
      WHERE ${where}
      GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
    params,
  );
  console.log('=== wechat config ===');
  console.log('MP_APPID=', mask(process.env.MP_APPID || process.env.WECHAT_MP_APPID || process.env.WX_MP_APPID));
  console.log('MP_APPSECRET=', mask(process.env.MP_APPSECRET || process.env.WECHAT_MP_APPSECRET || process.env.WX_MP_SECRET));
  console.log('WX_MP_TEMPLATE_ID=', mask(process.env.WX_MP_TEMPLATE_ID));
  console.log(`=== failed notifications ${tenant ? `(tenant=${tenant})` : '(all tenants)'} ===`);
  for (const row of r.rows) console.log(`${row.count}\t${row.reason}`);
  await db.end();
} catch (e) {
  console.error('FATAL', e);
  try { await db.end(); } catch {}
  process.exit(1);
}
