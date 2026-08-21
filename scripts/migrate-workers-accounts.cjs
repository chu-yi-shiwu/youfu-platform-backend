// 批次 A2 · S6 存量 worker → account_user 关联（v2：匹配回填，不重复建号）
// 真实场景（ECS 实测）：8 个工人已有登录账号（w_*，t-verification，role=operator），
// 缺的是 worker.account_id 关联；另有 t-phasea 3 个 worker 无账号。
// 策略：对每租户每 worker，按 username=worker.id 找同租户 account_user：
//   - 已存在 → UPDATE worker SET account_id（不新建、不改角色、不改密码）
//   - 不存在 → 新建（role='worker'，scrypt 临时密码）并回填
// R1：不切 H5 登录；本脚本不改任何既有账号的角色/密码。
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

// 租户列表：优先命令行参数，否则默认两租户
const TENANTS = process.argv.slice(2).length ? process.argv.slice(2) : ['t-verification', 't-phasea'];

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

  for (const tenant of TENANTS) {
    await client.query(`SET app.tenant_id = '${tenant}'`);
    const r = await client.query(`SELECT id, name, account_id FROM worker WHERE tenant_id = $1 ORDER BY id`, [tenant]);
    const workers = r.rows;
    console.log(`\n[migrate] tenant=${tenant} workers=${workers.length}`);
    const linked = [];
    const created = [];
    const skipped = [];
    for (const w of workers) {
      if (w.account_id) {
        skipped.push({ id: w.id, name: w.name, reason: '已关联' });
        continue;
      }
      const dup = await client.query(
        `SELECT id FROM account_user WHERE tenant_id=$1 AND username=$2 LIMIT 1`,
        [tenant, w.id],
      );
      if (dup.rowCount && dup.rowCount > 0) {
        await client.query(`UPDATE worker SET account_id=$1 WHERE id=$2`, [dup.rows[0].id, w.id]);
        linked.push({ id: w.id, name: w.name, account_id: dup.rows[0].id, via: '已有账号回填' });
        continue;
      }
      const password = genPassword();
      const ins = await client.query(
        `INSERT INTO account_user (tenant_id, username, password_hash, display_name, role, active)
         VALUES ($1,$2,$3,$4,'worker',true) RETURNING id, username`,
        [tenant, w.id, hashPassword(password), w.name || w.id],
      );
      await client.query(`UPDATE worker SET account_id=$1 WHERE id=$2`, [ins.rows[0].id, w.id]);
      created.push({ id: w.id, name: w.name, username: ins.rows[0].username, password });
    }
    if (linked.length) {
      console.log('已关联（复用既有账号，未动角色/密码）:');
      for (const l of linked) console.log(`  ${l.id} ${l.name} → account ${l.account_id} (${l.via})`);
    }
    if (created.length) {
      console.log('新建账号（role=worker，临时密码仅本次打印）:');
      for (const c of created) console.log(`  ${c.id} ${c.name} → 账号 ${c.username}  密码 ${c.password}`);
    }
    if (skipped.length) {
      console.log('跳过:');
      for (const s of skipped) console.log(`  ${s.id} ${s.name} — ${s.reason}`);
    }
  }

  console.log('\n注意：新建账号的初始密码仅本次打印；H5 登录暂未切换（批次 C 统一身份时切 account_user）。');
  await client.end();
}

main().catch((e) => {
  console.error('[migrate] FAILED', e);
  process.exit(1);
});
