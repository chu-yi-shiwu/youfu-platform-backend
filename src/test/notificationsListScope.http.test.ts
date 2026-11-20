// notificationsListScope.http.test.ts —— P0-3 通知列表越权收口（HTTP 入口级）。
//
// 【修复前的真实洞】
//   `GET /open/notifications` 缺省不带 ?recipient= 时，SQL 只按 tenant_id 过滤，
//   返回**全租户**所有 in_app 通知。任意登录账号（含最低权限 worker）都能读到
//   他人的派单消息、工单标题与 payload —— 这是跨用户的 PII/业务信息泄露。
//
// 【修复后的口径】
//   与 `/open/notifications/read` 完全一致：
//     当前身份集合 = auth.userId ∪ resolveWorkerIds(auth.userId)
//     ?recipient= 只允许命中集合内身份，否则 403；
//     身份集合为空 → 422（绝不降级为全租户）。
//
// 本文件钉死：默认只查本人、伪造 recipient 403、空身份 422、合法 worker 身份可过滤。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

const h = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(h.client),
  assertSafeTenantId: (t: string) => t,
  default: { connect: async () => { throw new Error('[notificationsListScope] 单测禁用真实 pool'); } },
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

const T = 't-notif-scope';

const workerProfileHandler = (profiles: string[]): Handler => ({
  match: (t) => t.includes('FROM worker WHERE tenant_id=$2 AND (account_id=$1 OR id=$1)'),
  reply: () => ({ rows: profiles.map((id) => ({ id })), rowCount: profiles.length }),
});

const notificationHandler = (rows: unknown[]): Handler => ({
  match: (t) => t.startsWith('SELECT n.id, n.recipient'),
  reply: () => ({ rows, rowCount: rows.length }),
});

let server: Server;
let baseUrl = '';
let currentAuth: Record<string, unknown> = {};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((_req: any, res: any, next: any) => {
    res.locals.auth = { tenantId: T, requestId: 'req-notif', authMode: 'prod', ...currentAuth };
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

async function get(path: string): Promise<{ status: number; body: Record<string, any> }> {
  const r = await fetch(baseUrl + path);
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}

async function post(path: string, body: unknown = {}): Promise<{ status: number; body: Record<string, any> }> {
  const r = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}

describe('P0-3 · GET /open/notifications 默认只返回本人身份', () => {
  it('缺省路径：SQL 必须限定 recipient = ANY，身份集合 = userId ∪ worker.id', async () => {
    currentAuth = { userId: 'u-1', role: 'worker', username: 'worker-a' };
    const calls = makeClient([
      workerProfileHandler(['W0001', 'W0009']),
      notificationHandler([{ id: 'n-self' }]),
    ]);
    const r = await get('/open/notifications');
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    const q = calls.find((c) => c.text.startsWith('SELECT n.id, n.recipient'));
    expect(q).toBeTruthy();
    // 收口实锤：缺省也必须带 recipient 集合，不得只按 tenant_id
    expect(q!.text).toContain('n.recipient = ANY($2::text[])');
    expect(q!.text).not.toMatch(/WHERE n\.tenant_id = \$1 AND n\.channel = 'in_app' AND EXISTS/);
    expect(q!.params).toEqual([T, ['u-1', 'W0001', 'W0009']]);
  });

  it('?recipient= 本人 worker 身份 → 200，且 SQL 追加精确 recipient 条件', async () => {
    currentAuth = { userId: 'u-1', role: 'worker', username: 'worker-a' };
    const calls = makeClient([
      workerProfileHandler(['W0001']),
      notificationHandler([{ id: 'n-worker' }]),
    ]);
    const r = await get('/open/notifications?recipient=W0001');
    expect(r.status).toBe(200);
    const q = calls.find((c) => c.text.startsWith('SELECT n.id, n.recipient'));
    expect(q).toBeTruthy();
    expect(q!.text).toContain('n.recipient = $3');
    expect(q!.params).toEqual([T, ['u-1', 'W0001'], 'W0001']);
  });

  it('?recipient= 他人身份 → 403，且不执行通知查询（不泄露任何行）', async () => {
    currentAuth = { userId: 'u-1', role: 'worker', username: 'worker-a' };
    const calls = makeClient([
      workerProfileHandler(['W0001']),
      notificationHandler([{ id: 'n-other' }]),
    ]);
    const r = await get('/open/notifications?recipient=W-OTHER');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FORBIDDEN');
    expect(calls.some((c) => c.text.startsWith('SELECT n.id, n.recipient'))).toBe(false);
  });

  it('身份集合为空（无 userId 且无 worker 档案）→ 422，绝不降级为全租户', async () => {
    currentAuth = { userId: '', role: 'worker', username: 'worker-a' };
    const calls = makeClient([
      workerProfileHandler([]),
      notificationHandler([{ id: 'n-any' }]),
    ]);
    const r = await get('/open/notifications');
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('IDENTITY_UNRESOLVED');
    expect(calls.some((c) => c.text.startsWith('SELECT n.id, n.recipient'))).toBe(false);
  });

  it('仅账号身份（无 worker 档案）→ 200，集合为 [userId]', async () => {
    currentAuth = { userId: 'u-admin', role: 'admin', username: 'admin' };
    const calls = makeClient([
      workerProfileHandler([]),
      notificationHandler([{ id: 'n-account' }]),
    ]);
    const r = await get('/open/notifications');
    expect(r.status).toBe(200);
    const q = calls.find((c) => c.text.startsWith('SELECT n.id, n.recipient'));
    expect(q!.params).toEqual([T, ['u-admin']]);
  });

  it('P0-6 · 孤儿过滤按 entity_type 分流：运送通知查 transport_order，两分支都对齐租户', async () => {
    // 背景：notification.work_order_id 借位存运输单 id，旧过滤只 EXISTS work_orders
    // 会把整类运送通知误判为孤儿。这里钉死 SQL 形状，语义由 PGlite 测试补证。
    currentAuth = { userId: 'W0001', role: 'worker', username: 'worker-a' };
    const calls = makeClient([
      workerProfileHandler(['W0001']),
      notificationHandler([{ id: 'n-transport' }]),
    ]);
    const r = await get('/open/notifications');
    expect(r.status).toBe(200);
    const q = calls.find((c) => c.text.startsWith('SELECT n.id, n.recipient'));
    expect(q).toBeTruthy();
    expect(q!.text).toContain("n.payload->>'entity_type' = 'transport_order'");
    expect(q!.text).toContain(
      'FROM transport_order t WHERE t.id::text = n.work_order_id AND t.tenant_id = n.tenant_id',
    );
    expect(q!.text).toContain("n.payload->>'entity_type' IS DISTINCT FROM 'transport_order'");
    expect(q!.text).toContain(
      'FROM work_orders wo WHERE wo.id = n.work_order_id AND wo.tenant_id = n.tenant_id',
    );
  });
});

describe('微信通知自检 · worker 可用', () => {
  it('worker 调用 /open/notify/selftest → 200（未配置微信时诚实返回 configured:false）', async () => {
    currentAuth = { userId: 'u-1', role: 'worker', username: 'worker-a' };
    makeClient([
      {
        match: (t) => t.includes('SELECT w.id FROM worker w'),
        reply: () => ({ rows: [{ id: 'DEMO-W001' }], rowCount: 1 }),
      },
    ]);
    const r = await post('/open/notify/selftest', {});
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.result?.configured).toBe(false);
  });
});
