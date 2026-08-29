// 演示账户种子（生产化④「自建账号」）。幂等：已存在则跳过（ON CONFLICT DO NOTHING）。
// 运行： npm run seed:accounts   （需先 007_account.sql 建表；用 .env 的 youfu_app 运行时角色，RLS 经 withTenantClient 生效）
// 改密： 生产部署请改下方默认密码，或用环境变量覆盖：
//   SEED_ADMIN_PWD=xxx SEED_OPERATOR_PWD=yyy npm run seed:accounts
import { hashPassword, withTenantClient } from '../src/account.js';

const TENANT = process.env.SEED_TENANT ?? 't-verification';
const demo = [
  {
    username: 'admin',
    password: process.env.SEED_ADMIN_PWD ?? 'admin123!',
    display_name: '演示管理员',
    role: 'admin' as const,
  },
  {
    username: 'operator',
    password: process.env.SEED_OPERATOR_PWD ?? 'operator123!',
    display_name: '演示运维',
    role: 'operator' as const,
  },
];

async function main() {
  for (const u of demo) {
    await withTenantClient(TENANT, async (client) => {
      await client.query(
        `INSERT INTO account_user (tenant_id, username, password_hash, display_name, role, active)
         VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (tenant_id, username) DO NOTHING`,
        [TENANT, u.username, hashPassword(u.password), u.display_name, u.role],
      );
    });
    console.log(`[seed] ensured account ${u.username}@${TENANT} (role=${u.role})`);
  }
  console.log('[seed] done. 默认密码仅为演示，生产请立即更改或删除演示账户。');
}

main().catch((e) => {
  console.error('[seed] failed:', e);
  process.exit(1);
});
