// 城市级平台层种子（E_min）——在 ECS /opt/youfu/backend 下运行：
//   1) 创建平台管理员（scrypt 强密码，打印一次交付）
//   2) 把现有租户登记进 tenant_registry（幂等）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function genPassword() {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#';
  const b = crypto.randomBytes(20);
  let p = '';
  for (let i = 0; i < 20; i++) p += cs[b[i] % cs.length];
  return p;
}

async function main() {
  const client = new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'youfu',
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  });
  await client.connect();

  // 1) 平台管理员
  const ADMIN_USER = process.env.PLATFORM_ADMIN_USER || 'platform_admin';
  const dup = await client.query(`SELECT 1 FROM platform_admin WHERE username=$1`, [ADMIN_USER]);
  if (dup.rowCount && dup.rowCount > 0) {
    console.log(`[platform] 管理员 ${ADMIN_USER} 已存在，跳过（如需重置请走 DB 改密）`);
  } else {
    const password = genPassword();
    await client.query(
      `INSERT INTO platform_admin (username, password_hash, display_name, active) VALUES ($1,$2,$3,true)`,
      [ADMIN_USER, hashPassword(password), '城市级平台管理员'],
    );
    console.log(`[platform] 已创建平台管理员：账号 ${ADMIN_USER}  密码 ${password}（仅本次打印，请妥善保存）`);
  }

  // 2) 登记现有租户（幂等）
  const tenants = [
    ['t-verification', '优服家验证租户', 'hospital'],
    ['t-phasea', 'Phase A 演示租户', 'hospital'],
    ['demo_tenant', '演示租户', 'property'],
  ];
  for (const [tid, name, category] of tenants) {
    await client.query(
      `INSERT INTO tenant_registry (tenant_id, name, category, status) VALUES ($1,$2,$3,'active')
       ON CONFLICT (tenant_id) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category`,
      [tid, name, category],
    );
  }
  console.log(`[platform] 已登记租户 ${tenants.length} 个（幂等）`);
  await client.end();
}

main().catch((e) => {
  console.error('[platform] FAILED', e);
  process.exit(1);
});
