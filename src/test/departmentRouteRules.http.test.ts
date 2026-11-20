// 部门路由规则 CRUD 真 HTTP + PGlite 回归：配置面必须可用，且不能被一线角色改。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';
import type { AuthLocals } from '../middleware/auth.js';

const box = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('../db/pool.js', () => ({
  default: { query: async () => ({ rows: [], rowCount: 0 }) },
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => {
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        const s = String(sql);
        if (/^\s*SET\s+LOCAL/i.test(s)) return { rows: [], rowCount: 0 };
        return (box.db as { query: (a: string, b: unknown[]) => Promise<unknown> }).query(s, params);
      },
    };
    return fn(client);
  },
}));

import { PGlite } from '@electric-sql/pglite';
import departmentRoutesRouter from '../routes/departmentRoutes.js';

const T = 't-dept-rules';
const OTHER = 't-dept-rules-other';
const DEPT = '11111111-1111-4111-8111-111111111111';
const DEPT2 = '44444444-4444-4444-8444-444444444444';
const OTHER_DEPT = '22222222-2222-4222-8222-222222222222';

let server: Server;
let base = '';
const auth: AuthLocals & { role: string } = {
  tenantId: T,
  requestId: 'req-dept-rules',
  idempotencyKey: undefined,
  userId: 'u-admin',
  username: 'admin',
  role: 'admin',
  authMode: 'prod',
};

const DDL = `
CREATE TABLE dept (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  name text NOT NULL,
  code text,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE department_route_rule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  name text NOT NULL,
  priority int NOT NULL DEFAULT 100,
  enabled boolean NOT NULL DEFAULT true,
  match_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  department_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE role_permission (
  tenant_id text NOT NULL,
  role text NOT NULL,
  perm text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, role, perm)
);
`;

beforeAll(async () => {
  box.db = new PGlite();
  await (box.db as unknown as { exec: (s: string) => Promise<void> }).exec(DDL);
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => { res.locals.auth = auth; next(); });
  app.use('/api/v1', departmentRoutesRouter);
  app.use((_req, res) => res.status(404).json({ ok: false, code: 'NOT_FOUND' }));
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await (box.db as unknown as { close: () => Promise<void> }).close();
});

beforeEach(async () => {
  auth.role = 'admin';
  const db = () => box.db as unknown as { query: (s: string, p?: unknown[]) => Promise<unknown> };
  await db().query('DELETE FROM department_route_rule');
  await db().query('DELETE FROM dept');
  await db().query(`INSERT INTO dept (id, tenant_id, name, is_default) VALUES ($1,$2,'总务科',true)`, [DEPT, T]);
  await db().query(`INSERT INTO dept (id, tenant_id, name) VALUES ($1,$2,'维修组')`, [DEPT2, T]);
  await db().query(`INSERT INTO dept (id, tenant_id, name) VALUES ($1,$2,'别家部门')`, [OTHER_DEPT, OTHER]);
});

async function req(method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}

const validRule = {
  name: '维修单归维修组',
  priority: 200,
  enabled: true,
  department_id: DEPT,
  match: { business_type: 'repair', description_contains: '漏水' },
};

describe('部门路由规则 CRUD', () => {
  it('创建 → 列表（带部门名）→ 更新 → 删除', async () => {
    const created = await req('POST', '/department-route-rules', validRule);
    expect(created.status).toBe(201);
    expect(created.body.item.name).toBe('维修单归维修组');
    const id = created.body.item.id as string;

    const list = await req('GET', '/department-route-rules');
    expect(list.status).toBe(200);
    expect(list.body.items[0].department_name).toBe('总务科');
    expect(list.body.items[0].match.business_type).toBe('repair');

    const updated = await req('PUT', `/department-route-rules/${id}`, { priority: 50, enabled: false });
    expect(updated.status).toBe(200);
    expect(updated.body.item.priority).toBe(50);
    expect(updated.body.item.enabled).toBe(false);

    const del = await req('DELETE', `/department-route-rules/${id}`);
    expect(del.status).toBe(200);
    expect((await req('GET', '/department-route-rules')).body.items).toHaveLength(0);
  });

  it('未知 match 键被拒（防"配了但永不命中"）', async () => {
    const r = await req('POST', '/department-route-rules', {
      ...validRule,
      match: { hacker_key: 'x' },
    });
    expect(r.status).toBe(422);
  });

  it('跨租户部门被拒：422', async () => {
    const r = await req('POST', '/department-route-rules', { ...validRule, department_id: OTHER_DEPT });
    expect(r.status).toBe(422);
  });

  it('worker 无 basicdata.edit → 403', async () => {
    auth.role = 'worker';
    const r = await req('POST', '/department-route-rules', validRule);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FORBIDDEN');
  });

  it('更新不存在的规则 → 404', async () => {
    const r = await req('PUT', '/department-route-rules/33333333-3333-4333-8333-333333333333', { priority: 1 });
    expect(r.status).toBe(404);
  });

  it('设默认部门：旧默认被清掉，只保留一个', async () => {
    const r = await req('PUT', `/departments/${DEPT2}/default`);
    expect(r.status).toBe(200);
    expect(r.body.item.is_default).toBe(true);
    const rows = await (box.db as unknown as { query: (s: string) => Promise<{ rows: any[] }> })
      .query(`SELECT id, is_default FROM dept WHERE tenant_id='${T}' ORDER BY id`);
    const defaults = rows.rows.filter((x) => x.is_default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(DEPT2);
  });
});
