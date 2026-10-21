/**
 * 096_retired_roles_assign_submit.sql —— PGlite 真跑验证
 *
 * 背景：093 只覆盖了 dispatch/forward/cancel/accept/claim 五个事件，
 * 漏了 assign（派单指派）与 submit（提交）。真库复核实测残留 2 条边：
 *   demo_tenant | work_order | v2 | assign | ["admin","dispatcher"]
 *   demo_tenant | work_order | v2 | submit | ["admin","operator","dispatcher"]
 *
 * 096 的口径：**只摘不补**（与 093 的 accept/claim 同口径）。
 * 为什么不给 assign 补 dispatch.override：
 *   1. 退场角色已不可新建账号（account.ts createUser 的 isRoleUsable 闸门 + invite.ts）；
 *   2. 存量 3 个退场账号全在 t-verification / t-phasea，**不在 demo_tenant**（真库实测），
 *      ⇒ 摘掉这两条边对任何现存账号零掉权；
 *   3. 补 dispatch.override 只会把 operator 放进 demo_tenant 的 assign 门禁 = 无收益的扩权；
 *   4. 093 自己对 accept/claim 就是这么论证的：「补 dispatch.override 反而会把 operator
 *      放进接单门禁，属扩权，不做」。
 *
 * 因此本测试断言的核心不只是「摘掉了」，还包括「**没有**顺手补权限点」。
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');

/** 剥离 psql 元命令（\echo 等）：PGlite 走 pg 协议，不认反斜杠命令。 */
function stripPsqlMeta(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => !/^\s*\\/.test(l))
    .join('\n');
}

function readMigration(name: string): string {
  return stripPsqlMeta(readFileSync(join(ROOT, name), 'utf8'));
}

/** 建最小可跑环境：workflow_def + _migrations（094/095 harness 同款形态）。 */
async function makeDb() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE workflow_def (
      tenant_id   text NOT NULL,
      entity_type text NOT NULL,
      version     int  NOT NULL,
      def         jsonb NOT NULL,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, entity_type, version)
    );
    CREATE TABLE _migrations (name text PRIMARY KEY);
    -- 096④ 复核会查存量退场账号（真库 3 行），harness 必须有同名表，否则 exec 整段失败
    CREATE TABLE account_user (
      id           bigserial PRIMARY KEY,
      tenant_id    text NOT NULL,
      username     text NOT NULL,
      role         text NOT NULL,
      active       boolean NOT NULL DEFAULT true
    );
  `);
  return db;
}

/** 造一条含 transitions 的 def。 */
function defWith(transitions: any[]) {
  return JSON.stringify({ states: ['new', 'done'], transitions });
}

type Row = { tenant_id: string; entity_type: string; version: number; def: any; updated_at: string };

async function q(db: PGlite, text: string, params: any[] = []): Promise<Row[]> {
  const r = await db.query<Row>(text, params);
  return r.rows ?? [];
}

/** 取某条边的 allowedRoles / allowedPerms 字符串数组。 */
async function edge(
  db: PGlite,
  tenant: string,
  event: string,
): Promise<{ roles: string[]; perms: string[]; raw: any } | null> {
  const rows = await q(
    db,
    `SELECT t FROM workflow_def w
       JOIN LATERAL jsonb_array_elements(w.def->'transitions') t ON true
      WHERE w.tenant_id = $1 AND t->>'event' = $2`,
    [tenant, event],
  );
  if (rows.length === 0) return null;
  const raw = rows[0] as any;
  const t = raw.t ?? raw;
  return {
    roles: (t.allowedRoles ?? []).slice(),
    perms: (t.allowedPerms ?? []).slice(),
    raw: t,
  };
}

describe('096_retired_roles_assign_submit.sql（PGlite 真跑）', () => {
  let sql: string;

  beforeAll(() => {
    sql = readMigration('096_retired_roles_assign_submit.sql');
  });

  it('① assign / submit 边上的 dispatcher 被摘掉', async () => {
    const db = await makeDb();
    await db.query(
      `INSERT INTO workflow_def(tenant_id, entity_type, version, def) VALUES
       ('demo_tenant','work_order',2,$1)`,
      [
        defWith([
          { event: 'assign', from: 'new', to: 'assigned', allowedRoles: ['admin', 'dispatcher'] },
          { event: 'submit', from: 'new', to: 'submitted', allowedRoles: ['admin', 'operator', 'dispatcher'] },
        ]),
      ],
    );
    await db.exec(sql);

    const a = await edge(db, 'demo_tenant', 'assign');
    const s = await edge(db, 'demo_tenant', 'submit');
    expect(a!.roles).toEqual(['admin']);
    expect(s!.roles).toEqual(['admin', 'operator']);
  });

  it('② 只摘不补：两条边都不得出现 allowedPerms（防无收益扩权）', async () => {
    const db = await makeDb();
    await db.query(
      `INSERT INTO workflow_def(tenant_id, entity_type, version, def) VALUES
       ('demo_tenant','work_order',2,$1)`,
      [
        defWith([
          { event: 'assign', from: 'new', to: 'assigned', allowedRoles: ['admin', 'dispatcher'] },
          { event: 'submit', from: 'new', to: 'submitted', allowedRoles: ['admin', 'operator', 'dispatcher'] },
        ]),
      ],
    );
    await db.exec(sql);

    const a = await edge(db, 'demo_tenant', 'assign');
    const s = await edge(db, 'demo_tenant', 'submit');
    expect(a!.perms).toEqual([]);
    expect(s!.perms).toEqual([]);
    // 连键都不许被创建出来（jsonb_set create_missing=true 会造出空数组键）
    expect('allowedPerms' in a!.raw).toBe(false);
    expect('allowedPerms' in s!.raw).toBe(false);
  });

  it('③ service_desk 同样被摘（与 dispatcher 同批退场角色）', async () => {
    const db = await makeDb();
    await db.query(
      `INSERT INTO workflow_def(tenant_id, entity_type, version, def) VALUES
       ('t1','work_order',1,$1)`,
      [defWith([{ event: 'assign', allowedRoles: ['admin', 'service_desk'] }])],
    );
    await db.exec(sql);
    const a = await edge(db, 't1', 'assign');
    expect(a!.roles).toEqual(['admin']);
  });

  it('④ 非 assign/submit 事件一字不动（093 已处理过的边不被重复改）', async () => {
    const db = await makeDb();
    await db.query(
      `INSERT INTO workflow_def(tenant_id, entity_type, version, def) VALUES
       ('t1','work_order',1,$1)`,
      [
        defWith([
          { event: 'dispatch', allowedRoles: ['admin', 'operator'], allowedPerms: ['dispatch.override'] },
          { event: 'accept', allowedRoles: ['admin', 'worker'] },
        ]),
      ],
    );
    await db.exec(sql);
    const d = await edge(db, 't1', 'dispatch');
    const c = await edge(db, 't1', 'accept');
    expect(d!.roles).toEqual(['admin', 'operator']);
    expect(d!.perms).toEqual(['dispatch.override']);
    expect(c!.roles).toEqual(['admin', 'worker']);
  });

  it('⑤ 干净租户（无退场角色）字节不动，updated_at 不推进', async () => {
    const db = await makeDb();
    await db.query(
      `INSERT INTO workflow_def(tenant_id, entity_type, version, def, updated_at) VALUES
       ('t_clean','work_order',1,$1,'2026-01-01 00:00:00+00')`,
      [defWith([{ event: 'assign', allowedRoles: ['admin', 'operator'] }])],
    );
    await db.exec(sql);
    const rows = await q(db, `SELECT updated_at FROM workflow_def WHERE tenant_id='t_clean'`);
    // PGlite 把 timestamptz 读成 JS Date，统一转 ISO 比较，避免本地时区串格式差异
    expect(new Date(rows[0].updated_at as any).toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('⑥ 幂等：二次执行 0 行变更（updated_at 不再推进）', async () => {
    const db = await makeDb();
    await db.query(
      `INSERT INTO workflow_def(tenant_id, entity_type, version, def) VALUES
       ('t1','work_order',1,$1)`,
      [defWith([{ event: 'assign', allowedRoles: ['admin', 'dispatcher'] }])],
    );
    await db.exec(sql);
    const t1 = (await q(db, `SELECT updated_at FROM workflow_def WHERE tenant_id='t1'`))[0].updated_at;
    await db.exec(sql);
    const t2 = (await q(db, `SELECT updated_at FROM workflow_def WHERE tenant_id='t1'`))[0].updated_at;
    expect(String(t1)).toBe(String(t2));
    const a = await edge(db, 't1', 'assign');
    expect(a!.roles).toEqual(['admin']);
  });

  it('⑦ 边本身不增不减（只改 allowedRoles 内容，绝不删边）', async () => {
    const db = await makeDb();
    await db.query(
      `INSERT INTO workflow_def(tenant_id, entity_type, version, def) VALUES
       ('t1','work_order',1,$1)`,
      [
        defWith([
          { event: 'assign', allowedRoles: ['admin', 'dispatcher'] },
          { event: 'submit', allowedRoles: ['dispatcher'] },
          { event: 'close', allowedRoles: ['admin'] },
        ]),
      ],
    );
    await db.exec(sql);
    const rows = await q(
      db,
      `SELECT jsonb_array_length(w.def->'transitions') AS n FROM workflow_def w WHERE tenant_id='t1'`,
    );
    expect(Number((rows[0] as any).n)).toBe(3);
  });

  it('⑧ submit 摘空后允许 allowedRoles 为 []（绝不因此删边）', async () => {
    const db = await makeDb();
    await db.query(
      `INSERT INTO workflow_def(tenant_id, entity_type, version, def) VALUES
       ('t1','work_order',1,$1)`,
      [defWith([{ event: 'submit', allowedRoles: ['dispatcher'] }])],
    );
    await db.exec(sql);
    const s = await edge(db, 't1', 'submit');
    expect(s).not.toBeNull();
    expect(s!.roles).toEqual([]);
  });

  it('⑨ 迁移文件不含事务包裹（部署脚本统一 --single-transaction）', () => {
    expect(/^\s*BEGIN\s*;/im.test(sql)).toBe(false);
    expect(/^\s*COMMIT\s*;/im.test(sql)).toBe(false);
  });

  it('⑩ 只覆盖 assign/submit 两个事件（不得扩大到其它事件）', async () => {
    const db = await makeDb();
    await db.query(
      `INSERT INTO workflow_def(tenant_id, entity_type, version, def) VALUES
       ('t1','work_order',1,$1)`,
      [
        defWith([
          { event: 'forward', allowedRoles: ['admin', 'dispatcher'] },
          { event: 'cancel', allowedRoles: ['admin', 'dispatcher'] },
        ]),
      ],
    );
    await db.exec(sql);
    // forward / cancel 归 093，096 必须放过（保持原样）
    const f = await edge(db, 't1', 'forward');
    const c = await edge(db, 't1', 'cancel');
    expect(f!.roles).toEqual(['admin', 'dispatcher']);
    expect(c!.roles).toEqual(['admin', 'dispatcher']);
  });
});
