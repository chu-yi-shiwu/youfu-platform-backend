// workOrderMasterVisibility.http.test.ts —— 角色数据范围收敛后的路由契约测试。
//
// 2026-11-08 根治：
//   - 行可见性已下沉到 work_orders RLS（见 principalRls.pglite.test.ts）；
//   - 路由不再写 MASTER_ROLES，也不再把 operator 当师傅；
//   - 路由不再“worker 档案查不到 → 放行全量”；
//   - 本文件只验证路由不再注入越权 scope、详情在 RLS 不可见时返回 404。
//
// 真正的“谁能看到哪一行”由 principalRls.pglite.test.ts 用真库策略验证。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

const h = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(h.client),
  withTenantScope: async (_c: unknown, _scope: string, fn: () => unknown) => fn(),
  assertSafeTenantId: (t: string) => t,
  default: { connect: async () => { throw new Error('[workOrderMasterVisibility.http.test] 单测禁用真实 pool'); } },
}));

import workOrderRouter from '../routes/workOrder.js';

interface Handler {
  match: (text: string) => boolean;
  reply: (text: string, params: unknown[]) => { rows: unknown[]; rowCount?: number };
}

function makeClient(handlers: Handler[]) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  h.client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      for (const hd of handlers) {
        if (hd.match(text)) return hd.reply(text, params ?? []);
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return calls;
}

const T = 't-master-vis';
let server: Server;
let baseUrl = '';
const auth = { tenantId: T, requestId: 'req-scope', userId: 'u-1', username: 'u', role: 'worker', authMode: 'prod' as const };

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = auth;
    next();
  });
  app.use('/api/v1', workOrderRouter);
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const listHandlers = (): Handler[] => [
  {
    match: (t) => t.includes('FROM work_orders wo') && (t.includes('COUNT(*)') || t.includes('ORDER BY wo.created_at')),
    reply: (t) => (t.includes('COUNT(*)') ? { rows: [{ c: '1' }] } : { rows: [{ id: 'wo-1', order_no: 'WO_1', status: 'assigned', assignee_id: 'W0001' }] }),
  },
  { match: (t) => t.includes('FROM workflow_def'), reply: () => ({ rows: [] }) },
];

const detailHandlers = (row: Record<string, unknown> | null): Handler[] => [
  { match: (t) => t.includes('FROM work_orders') && t.includes('WHERE'), reply: () => ({ rows: row ? [row] : [] }) },
  { match: (t) => t.includes('FROM workflow_def'), reply: () => ({ rows: [] }) },
  { match: (t) => t.includes('FROM ticket_event'), reply: () => ({ rows: [] }) },
];

const get = async (path: string, role = 'worker') => {
  auth.role = role;
  const r = await fetch(baseUrl + path);
  auth.role = 'worker';
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
};

describe('角色数据范围收敛：路由不再注入 MASTER_ROLES scope', () => {
  it('worker 显式 assignee=别人：路由原样透传，交给 RLS 过滤', async () => {
    const calls = makeClient(listHandlers());
    const r = await get('/open/work_orders?assignee=W9999', 'worker');
    expect(r.status).toBe(200);
    const listCall = calls.find((c) => c.text.includes('FROM work_orders wo') && c.text.includes('ORDER BY'));
    expect(listCall).toBeTruthy();
    expect(listCall!.params).toContain('W9999');
    expect(listCall!.params).not.toContainEqual(['W0001']);
  });

  it('operator 不传 assignee：不注入本人 scope（运营看全局）', async () => {
    const calls = makeClient(listHandlers());
    const r = await get('/open/work_orders', 'operator');
    expect(r.status).toBe(200);
    const listCall = calls.find((c) => c.text.includes('FROM work_orders wo') && c.text.includes('ORDER BY'));
    expect(listCall).toBeTruthy();
    expect(listCall!.params).not.toContainEqual(['W0001']);
  });

  it('admin 不传 assignee：不注入本人 scope', async () => {
    const calls = makeClient(listHandlers());
    const r = await get('/open/work_orders', 'admin');
    expect(r.status).toBe(200);
    const listCall = calls.find((c) => c.text.includes('FROM work_orders wo') && c.text.includes('ORDER BY'));
    expect(listCall!.params).not.toContainEqual(['W0001']);
  });

  it('worker 详情：RLS 不可见（findOne 返回空）→ 404', async () => {
    makeClient(detailHandlers(null));
    const r = await get('/open/work_order/wo-other', 'worker');
    expect(r.status).toBe(404);
  });

  it('operator 详情：RLS 可见（findOne 返回行）→ 200', async () => {
    makeClient(detailHandlers({ id: 'wo-x', order_no: 'WO_X', status: 'assigned', assignee_id: 'W0002', def_version: 0 }));
    const r = await get('/open/work_order/wo-x', 'operator');
    expect(r.status).toBe(200);
  });
});
