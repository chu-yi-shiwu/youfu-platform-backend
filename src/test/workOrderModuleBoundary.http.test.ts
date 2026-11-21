// work_order 模块边界 HTTP 契约：
//   - /admin/work-orders/* 受 work_order 模块开关控制；
//   - /open/work_orders 只允许 worker 执行角色，admin/operator 不能借共享路由绕过模块；
//   - 移动端 worker 执行不因模块开关被误伤。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';
import type { AuthLocals } from '../middleware/auth.js';

const h = vi.hoisted(() => ({
  moduleEnabled: true,
  role: 'admin' as string,
  userId: 'u-admin',
}));

const fakeClient = {
  query: vi.fn(async (text: string) => {
    const sql = String(text);
    if (sql.includes('FROM tenant_module')) {
      return { rows: [{ module_key: 'work_order', enabled: h.moduleEnabled }], rowCount: 1 };
    }
    if (sql.includes('FROM department_module')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM role_permission')) return { rows: [], rowCount: 0 };
    if (sql.includes('COUNT(*)::text AS c')) return { rows: [{ c: '0' }], rowCount: 1 };
    if (sql.includes('SELECT DISTINCT def_version')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM workflow_def')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM work_orders')) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  }),
};

vi.mock('../db/pool.js', () => ({
  default: { query: async () => ({ rows: [], rowCount: 0 }) },
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(fakeClient),
}));

import workOrderRouter from '../routes/workOrder.js';

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    const auth: AuthLocals = {
      tenantId: 't-wo-boundary',
      userId: h.userId,
      role: h.role,
      authMode: 'prod',
      requestId: 'wo-boundary',
    } as AuthLocals;
    res.locals.auth = auth;
    next();
  });
  app.use('/api/v1', workOrderRouter);
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  h.moduleEnabled = true;
  h.role = 'admin';
  h.userId = 'u-admin';
  fakeClient.query.mockClear();
});

describe('work_order 模块边界', () => {
  it('模块关闭：管理面 /admin/work-orders 403 MODULE_DISABLED', async () => {
    h.moduleEnabled = false;
    const r = await fetch(`${base}/admin/work-orders`);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { code: string }).code).toBe('MODULE_DISABLED');
  });

  it('模块开启：管理面 /admin/work-orders 200', async () => {
    h.moduleEnabled = true;
    const r = await fetch(`${base}/admin/work-orders`);
    expect(r.status).toBe(200);
  });

  it('模块关闭：管理面代报修补照片/语音 403 MODULE_DISABLED', async () => {
    h.moduleEnabled = false;
    const photo = await fetch(`${base}/admin/work-orders/wo-1/photos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ photo: 'data:image/png;base64,AAA' }),
    });
    expect(photo.status).toBe(403);
    expect(((await photo.json()) as { code: string }).code).toBe('MODULE_DISABLED');
    const voice = await fetch(`${base}/admin/work-orders/wo-1/voice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: '/upload/a.mp3' }),
    });
    expect(voice.status).toBe(403);
  });

  it('模块开启：管理面补照片进入 handler（无工单 404，不是 403）', async () => {
    h.moduleEnabled = true;
    const r = await fetch(`${base}/admin/work-orders/wo-1/photos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ photo: 'data:image/png;base64,AAA' }),
    });
    expect(r.status).toBe(404);
  });

  it('模块关闭：worker 执行建单 /open/work_order 不被模块门禁误伤', async () => {
    h.role = 'worker';
    h.userId = 'w-1';
    h.moduleEnabled = false;
    const r = await fetch(`${base}/open/work_order`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'wo-boundary-create',
        business_type: 'escort',
        title: 'UAT boundary escort',
        location: 'UAT',
        contact: '13800000000',
      }),
    });
    // 该用例只守模块边界：不能 404（路由被删）或 403 MODULE_DISABLED（被模块误伤）。
    expect(r.status).not.toBe(404);
    expect(r.status).not.toBe(403);
  });

  it('共享执行路由只允许 worker：admin 走 /open/work_orders 403', async () => {
    h.role = 'admin';
    const r = await fetch(`${base}/open/work_orders`);
    expect(r.status).toBe(403);
    expect(((await r.json()) as { message: string }).message).toContain('worker execution');
  });

  it('worker 执行不受模块开关影响：/open/work_orders 200', async () => {
    h.role = 'worker';
    h.userId = 'w-1';
    h.moduleEnabled = false;
    const r = await fetch(`${base}/open/work_orders`);
    expect(r.status).toBe(200);
  });

  it('模块关闭：worker 仍可走 /open/me/summary（执行面不误伤）', async () => {
    h.role = 'worker';
    h.userId = 'w-1';
    h.moduleEnabled = false;
    const r = await fetch(`${base}/open/me/summary`);
    // 没有 worker profile 时 404 也说明已越过模块门禁/角色门禁；不能是 MODULE_DISABLED
    expect(r.status).not.toBe(403);
  });
});
