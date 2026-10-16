// 095_role_permission_check_drop.sql 的**真执行**验证（PGlite = 真实 PostgreSQL 编译到 WASM）。
//
// 【为什么要有这个测试】
//   095 是"撤销约束"型迁移，写错就是两种灾难：
//     ① 该删的没删 → 自定义岗位配权限继续 23514（角色可配置链路永远只通一半）；
//     ② 删错对象（按名字删、或 to_regclass 用错导致误判）→ 生产库结构被改坏。
//   两者都无法靠"看代码"确认，必须真跑。
//
// 【⚠️ 版本差异（如实标注）】
//   PGlite 0.5.10 = PostgreSQL 18.6；生产库实测 = PostgreSQL 15.19。
//   095 只用 pg_constraint / pg_get_constraintdef / to_regclass / ALTER TABLE DROP CONSTRAINT，
//   15 与 18 行为一致；但本测试证明的是逻辑正确，不替代真库首跑。
//
// 【不做什么】
//   不验证"应用层能否真的写入自定义角色"——那是 HTTP 层测试（retiredRoleGuard 系列）的事。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { stripPsqlMeta } from '../db/psqlMeta.js';

const REPO_ROOT = join(__dirname, '..', '..');
const sql095 = () => stripPsqlMeta(readFileSync(join(REPO_ROOT, '095_role_permission_check_drop.sql'), 'utf8')).sql;

const CHECK_6ROLES = `CHECK (role = ANY (ARRAY['admin'::text, 'operator'::text, 'dispatcher'::text, 'worker'::text, 'reviewer'::text, 'service_desk'::text]))`;

function makeTableSql(withCheck: boolean): string {
  const inline = withCheck ? ` ${CHECK_6ROLES}` : '';
  return `CREATE TABLE IF NOT EXISTS role_permission (
  tenant_id  TEXT NOT NULL,
  role       TEXT NOT NULL${inline},
  perm       TEXT NOT NULL
);`;
}

async function constraintsOf(db: PGlite): Promise<Array<{ conname: string; def: string }>> {
  const r = await db.query<{ conname: string; def: string }>(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'role_permission'::regclass AND contype = 'c'`,
  );
  return r.rows ?? [];
}

describe('095_role_permission_check_drop（PGlite 真执行）', () => {
  it('① 带 6 角色 CHECK 的表 → 跑完 CHECK 归零', async () => {
    const db = new PGlite();
    await db.exec(makeTableSql(true));
    expect((await constraintsOf(db)).length).toBe(1); // 前置：确实带着 CHECK
    await db.exec(sql095());
    expect(await constraintsOf(db)).toEqual([]);
    await db.close();
  });

  it('② 撤销后：内置角色仍可写（没把表写废）', async () => {
    const db = new PGlite();
    await db.exec(makeTableSql(true));
    await db.exec(sql095());
    await db.exec(`INSERT INTO role_permission (tenant_id, role, perm) VALUES ('t1','operator','ticket.view')`);
    const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM role_permission`);
    expect(r.rows[0].n).toBe(1);
    await db.close();
  });

  it('③ 撤销后：自定义岗位（非内置 code）可写 —— 这才是本迁移的目的', async () => {
    const db = new PGlite();
    await db.exec(makeTableSql(true));
    // 撤销前必被拒（坐实"不跑 095 就是 23514"）
    await expect(
      db.exec(`INSERT INTO role_permission (tenant_id, role, perm) VALUES ('t1','my_custom_role','ticket.view')`),
    ).rejects.toThrow();
    await db.exec(sql095());
    await db.exec(`INSERT INTO role_permission (tenant_id, role, perm) VALUES ('t1','my_custom_role','ticket.view')`);
    const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM role_permission WHERE role='my_custom_role'`);
    expect(r.rows[0].n).toBe(1);
    await db.close();
  });

  it('④ 幂等：已无 CHECK 时重跑不报错（收敛到同一终态）', async () => {
    const db = new PGlite();
    await db.exec(makeTableSql(false));
    await db.exec(sql095());
    await db.exec(sql095());
    expect(await constraintsOf(db)).toEqual([]);
    await db.close();
  });

  it('⑤ 表不存在时不报错（to_regclass 返回 NULL，循环 0 次）', async () => {
    const db = new PGlite();
    await expect(db.exec(sql095())).resolves.toBeDefined();
    await db.close();
  });

  it('⑥ 只删角色枚举 CHECK，不动其它 CHECK（perm 非空约束必须留存）', async () => {
    const db = new PGlite();
    await db.exec(`CREATE TABLE role_permission (
      tenant_id  TEXT NOT NULL,
      role       TEXT NOT NULL ${CHECK_6ROLES},
      perm       TEXT NOT NULL CHECK (length(perm) > 0)
    );`);
    await db.exec(sql095());
    const cs = await constraintsOf(db);
    expect(cs.length).toBe(1);
    expect(cs[0].def).toMatch(/length/);
    await db.close();
  });

  it('⑦ 迁移文件不含事务包裹（由 migrate-as-owner.sh 的 --single-transaction 统一兜底）', () => {
    const raw = readFileSync(join(REPO_ROOT, '095_role_permission_check_drop.sql'), 'utf8');
    expect(raw).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(raw).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});
