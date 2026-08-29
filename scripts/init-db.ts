// 优服家 · TencentDB for PostgreSQL 初始化脚本（一次性）
// 作用：在新建的 TencentDB PG 实例上完成"库 + 角色 + 迁移 + 权限 + 种子"。
// 分工（与原型一致，满足 RLS 多租户隔离）：
//   - 本脚本以【实例管理员/超级用户】(PGADMINUSER, 默认 postgres) 连接，负责 DDL/授权/种子。
//   - 运行时后端以 【youfu_app】 角色连接（非超级用户），SET ROLE youfu_app 后 RLS 生效。
//
// 用法（在 backend 目录，需先 npm install）：
//   PGHOST=<pg公网域名> PGPORT=5432 \
//   PGADMINUSER=postgres PGADMINPASSWORD=<实例管理员密码> \
//   YOUFU_APP_PASSWORD=<给youfu_app设的密码,缺省自动生成> \
//   npx tsx scripts/init-db.ts
//
// 脚本会打印 youfu_app 的最终密码，供后续 CloudRun / 后端 .env 配置 PGPASSWORD 使用。
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 迁移/种子 SQL 与本脚本同在 backend/ 下；__dirname = backend/scripts，上一级即 backend 根。
const backendRoot = join(__dirname, '..');

const PGHOST = process.env.PGHOST ?? '127.0.0.1';
const PGPORT = Number(process.env.PGPORT ?? 5432);
const DBNAME = process.env.PGDATABASE ?? 'youfu';
const ADMIN = process.env.PGADMINUSER ?? 'postgres';
// 兼容两种命名：PGADMINPASSWORD（脚本首选）/ PG_ADMIN_PWD（compose 透传）
const ADMIN_PWD = process.env.PGADMINPASSWORD ?? process.env.PG_ADMIN_PWD ?? '';
const APP_ROLE = 'youfu_app';
// 兼容 YOUFU_APP_PASSWORD / YOUFU_APP_PWD；缺省自动生成并打印
const APP_PWD = process.env.YOUFU_APP_PASSWORD ?? process.env.YOUFU_APP_PWD ?? crypto.randomBytes(24).toString('hex');
// SSL 模式可配：本地 Docker PG 用 disable；腾讯云 PG 用 require
const SSLMODE = process.env.PGSSLMODE ?? 'require';

if (!ADMIN_PWD) {
  console.error('[init-db] 缺少 PGADMINPASSWORD（TencentDB PG 实例管理员密码）');
  process.exit(1);
}

async function runOnce(connString: string, sql: string): Promise<void> {
  const p = new Pool({ connectionString: connString });
  try {
    await p.query(sql);
  } finally {
    await p.end();
  }
}

async function main() {
  const adminConn = (db: string) =>
    `postgres://${encodeURIComponent(ADMIN)}:${encodeURIComponent(ADMIN_PWD)}@${PGHOST}:${PGPORT}/${db}?sslmode=${SSLMODE}`;

  // 1) 建库（已存在则忽略）
  try {
    await runOnce(adminConn('postgres'), `CREATE DATABASE ${DBNAME} WITH OWNER ${ADMIN};`);
    console.log(`[init-db] 数据库 ${DBNAME} 已创建`);
  } catch (e: any) {
    if (e?.code === '42P04') console.log(`[init-db] 数据库 ${DBNAME} 已存在，跳过`);
    else throw e;
  }

  // 2) 建运行时角色 youfu_app + 授权连接
  await runOnce(
    adminConn(DBNAME),
    `DO $$
     BEGIN
       IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
         CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PWD}' NOSUPERUSER;
       END IF;
     END$$;
     ALTER ROLE ${APP_ROLE} PASSWORD '${APP_PWD}';
     GRANT CONNECT ON DATABASE ${DBNAME} TO ${APP_ROLE};`,
  );
  console.log(`[init-db] 角色 ${APP_ROLE} 就绪`);

  // 3) 跑迁移 001..007（以管理员身份，DDL/RLS 策略/授权）
  const migrationFiles = readdirSync(backendRoot)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  const migPool = new Pool({ connectionString: adminConn(DBNAME) });
  try {
    for (const file of migrationFiles) {
      const sql = readFileSync(join(backendRoot, file), 'utf8');
      await migPool.query(sql);
      console.log(`[init-db] migration ok: ${file}`);
    }
  } finally {
    await migPool.end();
  }

  // 4) 补齐 youfu_app 的表/序列/函数权限（迁移脚本只授权了 account_user，基础表需在外部授权）
  await runOnce(
    adminConn(DBNAME),
    `GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
     GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
     GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE};
     GRANT EXECUTE ON FUNCTION app_tenant_id() TO ${APP_ROLE};
     ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE};
     ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE};
     ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${APP_ROLE};`,
  );
  console.log(`[init-db] ${APP_ROLE} 表/序列/函数权限已补齐`);

  // 5) 灌演示 worker 种子（以管理员身份，绕过 RLS 直接写入 t-verification）
  await runOnce(adminConn(DBNAME), readFileSync(join(backendRoot, '003_seed_workers.sql'), 'utf8'));
  console.log('[init-db] worker 种子已写入');

  console.log('\n=== 初始化完成 ===');
  console.log(`youfu_app 密码（请用于后端 PGPASSWORD / CloudRun EnvParams）：`);
  console.log(APP_PWD);
}

main().catch((e) => {
  console.error('[init-db] 失败:', e?.message ?? e);
  process.exit(1);
});
