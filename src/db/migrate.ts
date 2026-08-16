// 迁移脚本：读取 001_init.sql 并在 PG 执行。
// 仅在新目录运行，不触碰任何现有服务。
// 本机若无 PG，本脚本会因连接失败报错——此时按约定改为"结构已审，待 PG 就绪执行"。
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from 'pg';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 按文件名字母序加载根目录下所有 NNN_*.sql 迁移（001_init → 002_... → ...）
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
    for (const file of migrationFiles) {
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      await pool.query(sql);
      console.log(`migration ok: ${file} applied`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('migration failed:', err.message);
  process.exit(1);
});
