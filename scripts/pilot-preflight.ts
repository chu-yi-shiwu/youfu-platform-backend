// 试点上线前自检脚本（只读）。
//
// 用法（在 backend 目录）：
//   PILOT_TENANT=zixing-hospital npx tsx scripts/pilot-preflight.ts
//   npx tsx scripts/pilot-preflight.ts --tenant=zixing-hospital
//
// 环境变量与 .env 一致：PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD；
// 建议以 youfu_app（或能 SET ROLE youfu_app 的属主）连接。
//
// 退出码：0=全部 PASS/WARN；1=存在 FAIL；2=参数/连接错误。
import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 必须在导入 pool 之前加载 env（pool 在模块初始化时读取 PG*）。
dotenv.config({ path: process.env.ENV_FILE ?? '.env' });

const backendRoot = fileURLToPath(new URL('..', import.meta.url));

function argValue(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const tenantId = argValue('tenant') ?? process.env.PILOT_TENANT ?? '';
  if (!tenantId) {
    console.error('用法：npx tsx scripts/pilot-preflight.ts --tenant=<tenant_id>');
    process.exit(2);
  }

  const [{ withTenantClient }, { runPreflight, formatPreflightReport, queryFromClient }, { listMigrationFiles }] =
    await Promise.all([
      import('../src/db/pool.js'),
      import('../src/pilot/preflight.js'),
      import('../src/db/migrationFiles.js'),
    ]);

  const migrationFiles = listMigrationFiles(backendRoot);
  const expectedMigrationCount = migrationFiles.length;
  const rlsTables = new Set<string>();
  for (const f of migrationFiles) {
    const text = readFileSync(join(backendRoot, f), 'utf8');
    for (const m of text.matchAll(
      /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi,
    )) {
      rlsTables.add(m[1].toLowerCase());
    }
  }
  const expectedRlsTables = rlsTables.size;
  console.log(`=== 优服家试点自检 ===`);
  console.log(`tenant=${tenantId}`);
  console.log(`migration_files=${expectedMigrationCount}`);
  console.log(`rls_migration_tables=${expectedRlsTables}`);
  console.log('');

  try {
    const result = await withTenantClient(tenantId, async (client) =>
      runPreflight({
        tenantId,
        expectedMigrationCount,
        expectedRlsTables,
        env: process.env,
        query: queryFromClient(client),
      }),
    { system: true });
    console.log(formatPreflightReport(result));
    process.exit(result.ok ? 0 : 1);
  } catch (e) {
    console.error('[pilot-preflight] 执行失败：', (e as Error).message);
    process.exit(2);
  }
}

main();
