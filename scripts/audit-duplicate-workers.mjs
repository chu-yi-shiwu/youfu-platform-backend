// 只读审计：同一租户 + 同一账号是否挂了多条 worker 档案。
//
// 背景：worker.id 是业务编码，worker.account_id 指向登录账号。正常情况下一个账号
// 只有一条 worker；历史迁移/重复绑定可能产生多条。
// 任务列表（巡检）已按全部档案查询，而工作台统计当前仍取主档案；在清洗数据前，
// 这个脚本用于发现“统计与列表可能不一致”的租户，不做任何写操作。
//
// 运行：
//   ENV_FILE=.env node scripts/audit-duplicate-workers.mjs
// 退出码：0 = 未发现；1 = 发现重复（需人工清洗）。
import fs from 'node:fs';
import pg from 'pg';

for (const f of [process.env.ENV_FILE || '.env']) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { Client } = pg;
const db = new Client({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'youfu',
  user: process.env.PGUSER || 'youfu_app',
  password: process.env.PGPASSWORD,
});

await db.connect();
const r = await db.query(
  `SELECT tenant_id, account_id, COUNT(*)::int AS worker_count,
          ARRAY_AGG(id ORDER BY id) AS worker_ids
     FROM worker
    WHERE account_id IS NOT NULL
    GROUP BY tenant_id, account_id
   HAVING COUNT(*) > 1
    ORDER BY tenant_id, account_id`,
);
await db.end();

if (r.rows.length === 0) {
  console.log('[duplicate-workers] PASS 未发现同一账号多条 worker 档案');
  process.exit(0);
}

console.log(`[duplicate-workers] FAIL 发现 ${r.rows.length} 组重复档案：`);
for (const row of r.rows) {
  console.log(JSON.stringify({
    tenant_id: row.tenant_id,
    account_id: row.account_id,
    worker_count: row.worker_count,
    worker_ids: row.worker_ids,
  }));
}
process.exit(1);
