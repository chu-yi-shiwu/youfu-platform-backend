// 迁移脚本：读取根目录下所有 NNN_*.sql 并按字母序应用。
// 关键修复：引入 _migrations 追踪表，只执行"未应用过"的文件，保证幂等、可重跑。
//   - 首次运行（_migrations 为空）视为"基线初始化"：DB 已由人工/历史脚本建至最新，
//     仅把当前所有迁移文件名登记为已应用，不再重跑（避免重跑 001 的 CREATE OR REPLACE
//     FUNCTION app_tenant_id 因属主(postgres)报错）。
//   - 之后新增的迁移文件（如 033_xxx.sql）会被正常执行并登记。
//   - 开发环境全新库可用 MIGRATE_FORCE=1 强制重跑全部（仍靠各 SQL 的 IF NOT EXISTS 保证安全）。
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from 'pg';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', '..');
const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => /^\d+_.*\.sql$/.test(f))
  .sort();

async function main() {
  const pool = new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE ?? 'youfu',
    user: process.env.PGUSER ?? 'youfu_app',
    password: process.env.PGPASSWORD ?? 'change_me',
  });
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS _migrations (name text primary key, applied_at timestamptz not null default now())`,
    );
    const rec = await pool.query(`SELECT name FROM _migrations`);
    const applied = new Set<string>(rec.rows.map((r: any) => r.name));
    const force = process.env.MIGRATE_FORCE === '1';

    const toRun = migrationFiles.filter((f) => force || !applied.has(f));

    if (!force && applied.size === 0 && migrationFiles.length > 0) {
      // 基线初始化：DB 已处于最新状态，仅登记、不重跑。
      console.warn(
        '[migrate] _migrations 为空 -> 执行基线初始化：登记当前全部迁移为已应用（不重跑）。' +
          '若这是全新库，请删除 _migrations 表后用 MIGRATE_FORCE=1 运行。',
      );
      for (const f of migrationFiles) {
        await pool.query(`INSERT INTO _migrations(name) VALUES ($1) ON CONFLICT DO NOTHING`, [f]);
      }
      console.log(`[migrate] baseline recorded: ${migrationFiles.length} files. 无 SQL 被执行。`);
      return;
    }

    if (toRun.length === 0) {
      console.log('[migrate] 无新增迁移，已是最新。');
      return;
    }
    for (const file of toRun) {
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      await pool.query('BEGIN');
      try {
        await pool.query(sql);
        await pool.query(`INSERT INTO _migrations(name) VALUES ($1)`, [file]);
        await pool.query('COMMIT');
        console.log(`migration ok: ${file} applied`);
      } catch (e: any) {
        await pool.query('ROLLBACK');
        throw new Error(`${file} failed: ${e.message}`);
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('migration failed:', err.message);
  process.exit(1);
});
