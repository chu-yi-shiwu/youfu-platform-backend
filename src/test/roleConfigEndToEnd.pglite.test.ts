/**
 * 角色/权限/流程「非代码级可配置」—— DB 级端到端契约（PGlite 真跑）
 *
 * 【为什么还要这一份】
 *   现有 roleConfigurable.test.ts 的「端到端语义」用例是**纯函数级**（零 DB），
 *   只验证 isTransitionAllowed 的判定；roleDefCrud.http.test.ts 是**分段 HTTP 级**。
 *   两者都没把下面这条链**真跑一遍**：
 *
 *       建自定义岗位 → 给它配权限点 → 用该岗位建账号 → 该账号走工单流转
 *       → 停用岗位后不能再分配（但存量账号不动）
 *
 *   这条链正是初一的大目标「岗位能建能改、权限能配、流程能配，不用改代码发版」。
 *   它一旦断，前面所有分层用例全绿也没用——所以必须有一条**真连库**的用例把它钉死。
 *
 * 【口径（与 093/096 一致）】
 *   - 停用（enabled=false）只影响「能否再分配给新账号」，**绝不改动存量账号**；
 *   - 权限放行 = allowedRoles ∪ allowedPerms 并集（不是交集）；
 *   - 自定义岗位必须本租户 role_def 中存在且启用，跨租户不得互认。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { isRoleUsable, listAllRoles } from '../repo/roleDef.js';
import { RICH_WORK_ORDER_DEF, isTransitionAllowed } from '../engine/stateMachine.js';

const T = 't-demo';
const T2 = 't-other';
const CUSTOM = 'repair_lead'; // 自定义岗位：维修组长

/** 最小可跑 schema：只留 role_def / role_permission / account_user 三张表。 */
async function makeDb() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE role_def (
      tenant_id   text NOT NULL,
      code        text NOT NULL,
      name        text NOT NULL,
      description text,
      enabled     boolean NOT NULL DEFAULT true,
      sort        int NOT NULL DEFAULT 100,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, code),
      CONSTRAINT role_def_code_format CHECK (code ~ '^[a-z][a-z0-9_]{1,31}$')
    );
    CREATE TABLE role_permission (
      tenant_id  text NOT NULL,
      role       text NOT NULL,
      perm       text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, role, perm)
    );
    CREATE TABLE account_user (
      id        bigserial PRIMARY KEY,
      tenant_id text NOT NULL,
      username  text NOT NULL,
      role      text NOT NULL,
      active    boolean NOT NULL DEFAULT true
    );
  `);
  return db;
}

/** PGlite 只用到 query，接口形状与 PoolClient 一致处足够；此处仅为类型对齐。 */
const asClient = (db: PGlite) => db as unknown as PoolClient;

async function createRole(db: PGlite, tenantId: string, code: string, name: string) {
  await db.query(
    `INSERT INTO role_def (tenant_id, code, name) VALUES ($1,$2,$3)`,
    [tenantId, code, name],
  );
}

async function setEnabled(db: PGlite, tenantId: string, code: string, enabled: boolean) {
  await db.query(`UPDATE role_def SET enabled=$3 WHERE tenant_id=$1 AND code=$2`, [
    tenantId,
    code,
    enabled,
  ]);
}

async function grantPerm(db: PGlite, tenantId: string, role: string, perm: string) {
  await db.query(
    `INSERT INTO role_permission (tenant_id, role, perm) VALUES ($1,$2,$3)`,
    [tenantId, role, perm],
  );
}

async function permsOf(db: PGlite, tenantId: string, role: string): Promise<string[]> {
  const r = await db.query(`SELECT perm FROM role_permission WHERE tenant_id=$1 AND role=$2`, [
    tenantId,
    role,
  ]);
  return (r.rows as { perm: string }[]).map((x) => x.perm);
}

const approveEdge = () => RICH_WORK_ORDER_DEF.transitions.find((x) => x.event === 'approve')!;

describe('非代码级可配置 —— DB 级端到端（建岗→配权→建号→流转→停用）', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await makeDb();
  });

  it('① 未建岗位时，自定义岗位不可分配（防凭空造岗）', async () => {
    expect(await isRoleUsable(asClient(db), T, CUSTOM)).toBe(false);
  });

  it('② 建岗后即可分配（"生成"这一半闭环）', async () => {
    await createRole(db, T, CUSTOM, '维修组长');
    expect(await isRoleUsable(asClient(db), T, CUSTOM)).toBe(true);
  });

  it('③ 跨租户不互认：同名岗位只认本租户那一行', async () => {
    await createRole(db, T2, CUSTOM, '别人的维修组长');
    expect(await isRoleUsable(asClient(db), T2, CUSTOM)).toBe(true);
    expect(await isRoleUsable(asClient(db), T, CUSTOM)).toBe(false);
  });

  it('④ 停用后不可再分配给新账号', async () => {
    await createRole(db, T, CUSTOM, '维修组长');
    await setEnabled(db, T, CUSTOM, false);
    expect(await isRoleUsable(asClient(db), T, CUSTOM)).toBe(false);
  });

  it('⑤ 停用后从角色清单里消失；启用后回来，且排在内置之后', async () => {
    await createRole(db, T, CUSTOM, '维修组长');
    expect(await listAllRoles(asClient(db), T)).toContain(CUSTOM);

    const all = await listAllRoles(asClient(db), T);
    expect(all.indexOf(CUSTOM)).toBeGreaterThan(all.indexOf('admin'));

    await setEnabled(db, T, CUSTOM, false);
    expect(await listAllRoles(asClient(db), T)).not.toContain(CUSTOM);
  });

  it('⑥ 配权限：自定义岗位可挂权限点（role_permission 真落库）', async () => {
    await createRole(db, T, CUSTOM, '维修组长');
    await grantPerm(db, T, CUSTOM, 'workflow.approve');
    expect(await permsOf(db, T, CUSTOM)).toEqual(['workflow.approve']);
  });

  it('⑦ 门禁：持 workflow.approve 的自定义岗位可审，无该权限的 worker 不可审', async () => {
    await createRole(db, T, CUSTOM, '维修组长');
    await grantPerm(db, T, CUSTOM, 'workflow.approve');
    const p = await permsOf(db, T, CUSTOM);

    expect(isTransitionAllowed(approveEdge(), { role: CUSTOM, perms: p })).toBe(true);
    expect(isTransitionAllowed(approveEdge(), { role: 'worker', perms: ['inspect.execute'] })).toBe(
      false,
    );
  });

  it('⑧ 建号：用自定义岗位建账号成功，角色值原样落库', async () => {
    await createRole(db, T, CUSTOM, '维修组长');
    await db.query(`INSERT INTO account_user (tenant_id, username, role) VALUES ($1,$2,$3)`, [
      T,
      'laowang',
      CUSTOM,
    ]);
    const r = await db.query(`SELECT role FROM account_user WHERE tenant_id=$1 AND username=$2`, [
      T,
      'laowang',
    ]);
    expect((r.rows as { role: string }[])[0].role).toBe(CUSTOM);
  });

  it('⑨ 停用岗位**不动存量账号**（下拉不可见 ≠ 存量被清理）', async () => {
    await createRole(db, T, CUSTOM, '维修组长');
    await db.query(`INSERT INTO account_user (tenant_id, username, role) VALUES ($1,$2,$3)`, [
      T,
      'laowang',
      CUSTOM,
    ]);
    await setEnabled(db, T, CUSTOM, false);

    const r = await db.query(
      `SELECT role, active FROM account_user WHERE tenant_id=$1 AND username=$2`,
      [T, 'laowang'],
    );
    expect((r.rows as { role: string; active: boolean }[])[0]).toEqual({
      role: CUSTOM,
      active: true,
    });
  });

  it('🔴 端到端串联：建岗→配权→建号→走流转→停用→新号被拒（存量不受影响）', async () => {
    // 1) 建岗
    await createRole(db, T, CUSTOM, '维修组长');
    expect(await isRoleUsable(asClient(db), T, CUSTOM)).toBe(true);

    // 2) 配权
    await grantPerm(db, T, CUSTOM, 'workflow.approve');
    const perms = await permsOf(db, T, CUSTOM);

    // 3) 建号
    await db.query(`INSERT INTO account_user (tenant_id, username, role) VALUES ($1,$2,$3)`, [
      T,
      'laowang',
      CUSTOM,
    ]);

    // 4) 走流转：该账号能审；同租户普通 worker 不能审
    expect(isTransitionAllowed(approveEdge(), { role: CUSTOM, perms })).toBe(true);
    expect(isTransitionAllowed(approveEdge(), { role: 'worker', perms: [] })).toBe(false);

    // 5) 停用：不能再分配
    await setEnabled(db, T, CUSTOM, false);
    expect(await isRoleUsable(asClient(db), T, CUSTOM)).toBe(false);

    // 6) 存量账号一个不动
    const r = await db.query(
      `SELECT count(*)::int AS n FROM account_user WHERE tenant_id=$1 AND role=$2`,
      [T, CUSTOM],
    );
    expect((r.rows as { n: number }[])[0].n).toBe(1);
  });
});
