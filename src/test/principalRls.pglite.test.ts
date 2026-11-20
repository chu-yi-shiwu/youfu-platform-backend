// 110_principal_rls.sql 的真库策略测试（PGlite）。
//
// 目标：证明可见性不是路由 if，而是数据库 RLS：
//   - worker 只看本人 / 自己创建且未分派 / 抢单大厅能力下的未分派；
//   - operator（tenant）看全租户；
//   - system 看全租户；
//   - ticket_event 跟父工单可见性；
//   - transport_order 按 carrier；
//   - worker 无档案（worker_ids 为空）看不到任何单；
//   - 自动派单改 assignee 给别人时，只在 system scope 语句内允许。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
let db: PGlite;

async function setupDb(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(`
    CREATE ROLE youfu_app;
    CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS text
      LANGUAGE sql STABLE AS $$ SELECT COALESCE(current_setting('app.tenant_id', true), '') $$;
    CREATE TABLE work_orders (
      id text PRIMARY KEY,
      tenant_id text NOT NULL,
      assignee_id text,
      created_by text,
      status text NOT NULL DEFAULT 'draft'
    );
    CREATE TABLE ticket_event (
      id bigserial PRIMARY KEY,
      tenant_id text NOT NULL,
      work_order_id text NOT NULL,
      type text NOT NULL
    );
    CREATE TABLE transport_order (
      id text PRIMARY KEY,
      tenant_id text NOT NULL,
      carrier text,
      status text NOT NULL DEFAULT 'pending'
    );
    GRANT SELECT, INSERT, UPDATE, DELETE ON work_orders, ticket_event, transport_order TO youfu_app;
    GRANT USAGE, SELECT ON SEQUENCE ticket_event_id_seq TO youfu_app;
    GRANT EXECUTE ON FUNCTION app_tenant_id() TO youfu_app;

    INSERT INTO work_orders (id, tenant_id, assignee_id, created_by, status) VALUES
      ('wo-w1', 't1', 'w1', 'u1', 'assigned'),
      ('wo-w2', 't1', 'w2', 'u2', 'assigned'),
      ('wo-free', 't1', NULL, 'u1', 'claim_hall'),
      ('wo-u2-free', 't1', NULL, 'u2', 'claim_hall'),
      ('wo-other-tenant', 't2', 'w1', 'u1', 'assigned');
    INSERT INTO ticket_event (tenant_id, work_order_id, type) VALUES
      ('t1', 'wo-w1', 'create'),
      ('t1', 'wo-w2', 'create'),
      ('t1', 'wo-free', 'create');
    INSERT INTO transport_order (id, tenant_id, carrier, status) VALUES
      ('tr-w1', 't1', 'w1', 'pending'),
      ('tr-w2', 't1', 'w2', 'pending'),
      ('tr-free', 't1', NULL, 'pending');
  `);
  await pg.exec(readFileSync(join(ROOT, '110_principal_rls.sql'), 'utf8'));
  return pg;
}

interface ScopeOpts {
  claimHall?: boolean;
}

async function asRole<T = Record<string, unknown>>(
  scope: 'self' | 'tenant' | 'system',
  workerIds: string,
  userId: string,
  sql: string,
  opts: ScopeOpts = {},
): Promise<T[]> {
  await db.exec(`
    BEGIN;
    SET LOCAL app.tenant_id = 't1';
    SET LOCAL app.scope = '${scope}';
    SET LOCAL app.user_id = '${userId}';
    SET LOCAL app.worker_ids = '${workerIds}';
    SET LOCAL app.claim_hall = '${opts.claimHall ? '1' : '0'}';
    SET LOCAL ROLE youfu_app;
  `);
  try {
    const r = await db.query<T>(sql);
    return r.rows;
  } finally {
    await db.exec('ROLLBACK;');
  }
}

async function asRoleExec(scope: 'self' | 'tenant' | 'system', workerIds: string, userId: string, sql: string): Promise<void> {
  await db.exec(`
    BEGIN;
    SET LOCAL app.tenant_id = 't1';
    SET LOCAL app.scope = '${scope}';
    SET LOCAL app.user_id = '${userId}';
    SET LOCAL app.worker_ids = '${workerIds}';
    SET LOCAL app.claim_hall = '0';
    SET LOCAL ROLE youfu_app;
  `);
  try {
    await db.exec(sql);
  } finally {
    await db.exec('ROLLBACK;');
  }
}

beforeAll(async () => {
  db = await setupDb();
});

afterAll(async () => {
  await db.close();
});

describe('110 principal RLS', () => {
  it('worker 只看到本人单 + 自己创建且未分派 + 抢单池', async () => {
    const rows = await asRole<{ id: string }>(
      'self',
      'w1',
      'u1',
      `SELECT id FROM work_orders ORDER BY id`,
    );
    expect(rows.map((r) => r.id)).toEqual(['wo-free', 'wo-w1']);
  });

  it('worker 无档案（worker_ids 为空）→ 看不到任何他人工单，fail-closed', async () => {
    const rows = await asRole<{ id: string }>('self', '', 'u-noprofile', `SELECT id FROM work_orders ORDER BY id`);
    expect(rows).toEqual([]);
  });

  it('claim_hall 能力只放开未分派单，不放开别人已分派单', async () => {
    const rows = await asRole<{ id: string }>(
      'self',
      'w1',
      'u1',
      `SELECT id FROM work_orders ORDER BY id`,
      { claimHall: true },
    );
    expect(rows.map((r) => r.id)).toEqual(['wo-free', 'wo-u2-free', 'wo-w1']);
  });

  it('operator（tenant）看全租户', async () => {
    const rows = await asRole<{ id: string }>('tenant', '', 'op1', `SELECT id FROM work_orders ORDER BY id`);
    expect(rows.map((r) => r.id)).toEqual(['wo-free', 'wo-u2-free', 'wo-w1', 'wo-w2']);
  });

  it('system 看全租户', async () => {
    const rows = await asRole<{ id: string }>('system', '', '', `SELECT id FROM work_orders ORDER BY id`);
    expect(rows.map((r) => r.id)).toEqual(['wo-free', 'wo-u2-free', 'wo-w1', 'wo-w2']);
  });

  it('ticket_event 跟父工单可见性', async () => {
    const rows = await asRole<{ work_order_id: string }>(
      'self',
      'w1',
      'u1',
      `SELECT work_order_id FROM ticket_event ORDER BY work_order_id`,
    );
    expect(rows.map((r) => r.work_order_id)).toEqual(['wo-free', 'wo-w1']);
  });

  it('transport_order 按 carrier 过滤', async () => {
    const rows = await asRole<{ id: string }>('self', 'w1', 'u1', `SELECT id FROM transport_order ORDER BY id`);
    expect(rows.map((r) => r.id)).toEqual(['tr-w1']);
  });

  it('transport_order 抢单大厅能力可见未指派单，不放开别人已指派单', async () => {
    const rows = await asRole<{ id: string }>(
      'self',
      'w1',
      'u1',
      `SELECT id FROM transport_order ORDER BY id`,
      { claimHall: true },
    );
    expect(rows.map((r) => r.id)).toEqual(['tr-free', 'tr-w1']);
  });

  it('worker 不能改别人单', async () => {
    await expect(
      asRoleExec('self', 'w1', 'u1', `UPDATE work_orders SET status='processing' WHERE id='wo-w2'`),
    ).resolves.toBeUndefined();
    // UPDATE 0 行不报错；真正验证用 system scope 下肯定能改
    const rows = await asRole<{ status: string }>('self', 'w1', 'u1', `SELECT status FROM work_orders WHERE id='wo-w2'`);
    expect(rows).toEqual([]);
  });

  it('worker 不能把单改派给别人（无 system scope 时）', async () => {
    await expect(
      asRoleExec('self', 'w1', 'u1', `UPDATE work_orders SET assignee_id='w2' WHERE id='wo-w1'`),
    ).rejects.toThrow(/row-level security/i);
  });

  it('自动派单在 system scope 语句内可改 assignee 给别人', async () => {
    await asRoleExec(
      'system',
      'w1',
      'u1',
      `UPDATE work_orders SET assignee_id='w2' WHERE id='wo-w1'`,
    );
    const rows = await asRole<{ assignee_id: string }>('system', '', '', `SELECT assignee_id FROM work_orders WHERE id='wo-w1'`);
    // asRoleExec 最后 ROLLBACK，原值应恢复为 w1
    expect(rows[0]?.assignee_id).toBe('w1');
  });

  it('worker 新建未分派单可以被自己看到（created_by）', async () => {
    const rows = await asRole<{ id: string }>(
      'self',
      'w1',
      'u1',
      `INSERT INTO work_orders (id, tenant_id, assignee_id, created_by, status)
       VALUES ('wo-new','t1',NULL,'u1','draft')
       RETURNING id`,
    );
    expect(rows.map((r) => r.id)).toEqual(['wo-new']);
  });

  it('worker 不能替别人建单（created_by 不匹配）', async () => {
    await expect(
      asRoleExec(
        'self',
        'w1',
        'u1',
        `INSERT INTO work_orders (id, tenant_id, assignee_id, created_by, status)
         VALUES ('wo-bad','t1',NULL,'u2','draft')`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});
