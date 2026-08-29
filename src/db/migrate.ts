// 迁移脚本：读取后端根目录下所有 NNN_*.sql 迁移，按文件名顺序、且**幂等**地应用。
// 关键修复：通过 _migrations 表记录已应用的迁移，避免每次全量重跑（旧版会重跑 001_init.sql
// 并因当前连接角色 youfu_app 不是表属主而报 "must be owner of function app_tenant_id"）。
//
// 注意（部署契约）：DDL 迁移必须以数据库属主（ECS 上为 postgres）身份执行，因为应用连接角色
// youfu_app 仅为受 RLS 约束的非属主角色，无权 ALTER 表。已应用的迁移被记录后，本脚本作为
// youfu_app 运行时将是安全的空操作（no-op）。新增 DDL 迁移请在 ECS 上以 postgres 身份应用：
//   sudo -u postgres psql -d youfu -v ON_ERROR_STOP=1 -f <迁移文件>
// 或执行仓库内 scripts/migrate-as-owner.sh（自动跳过已记录项）。
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from 'pg';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', '..');

async function main() {
  const pool = new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE ?? 'youfu',
    user: process.env.PGUSER ?? 'youfu_app',
    password: process.env.PGPASSWORD ?? 'change_me',
  });
  try {
    // 确保追踪表存在（首次运行时由属主创建）。
    await pool.query(
      `CREATE TABLE IF NOT EXISTS _migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const appliedRes = await pool.query('SELECT name FROM _migrations');
    const applied = new Set(appliedRes.rows.map((r: any) => r.name));

    const migrationFiles = readdirSync(migrationsDir)
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .sort();

    // R25-005：检测重复的数字前缀（如 037_xxx.sql 与 037_yyy.sql 同号兄弟迁移），仅作告警，
    // 不改文件名——重命名已部署迁移会因 _migrations 按文件名追踪而重复执行，有破坏风险。
    // 排序按全文件名进行，同号内顺序确定性 OK；此处仅防未来手误造成混淆。
    const prefixCounts = new Map<string, number>();
    for (const f of migrationFiles) {
      const m = /^(\d+)_/.exec(f);
      if (m) prefixCounts.set(m[1], (prefixCounts.get(m[1]) ?? 0) + 1);
    }
    for (const [prefix, count] of prefixCounts) {
      if (count > 1) {
        console.warn(
          `[migrate] WARN 重复迁移序号 ${prefix}（${count} 个文件）；排序按全文件名确定性执行，请勿重命名已部署迁移`,
        );
      }
    }

    let ran = 0;
    for (const file of migrationFiles) {
      if (applied.has(file)) {
        console.log(`skip (already applied): ${file}`);
        continue;
      }
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      await pool.query(sql);
      await pool.query('INSERT INTO _migrations(name) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
      applied.add(file);
      ran += 1;
      console.log(`migration ok: ${file} applied`);
    }
    console.log(ran === 0 ? 'migrate: nothing to do (all applied)' : `migrate: ${ran} migration(s) applied`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('migration failed:', err.message);
  process.exit(1);
});
