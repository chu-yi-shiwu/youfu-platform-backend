// workOrderTransitionWorkerScope.http.test.ts —— P0-4 路由层接线护栏。
//
// 内核守卫已在 ticketAssigneeGuard.test.ts 钉死；本文件只验「路由层是否真的把
// role==='worker' 的 worker 档案集合传进了 transition()」。
// 这是典型的两层分离漏洞：内核写对了，但路由没接线 ⇒ 线上仍然越权。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

const h = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(h.client),
  assertSafeTenantId: (t: string) => t,
  default: { connect: async () => { throw new Error('[transitionWorkerScope] 单测禁用真实 pool'); } },
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

const T = 't-transition-scope';
const WO = '44444444-4444-4444-8444-444444444444';

const workerProfileHandler = (profiles: string[]): Handler => ({
  match: (t) => t.includes('FROM worker WHERE tenant_id=$2 AND (account_id=$1 OR id=$1)'),
  reply: () => ({ rows: profiles.map((id) => ({ id })), rowCount: profiles.length }),
});

const workOrderRow = (assignee: string | null): Handler => ({
  match: (t) => t.includes('SELECT * FROM work_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE'),
  reply: () => ({
    rows: [{
      id: WO, tenant_id: T, order_no: 'WO-P04-1', status: 'assigned',
      assignee_id: assignee, def_version: 0,
    }],
    rowCount: 1,
  }),
});

const defHandler: Handler = {
  match: (t) => t.includes('FROM workflow_def'),
  reply: () => ({ rows: [], rowCount: 0 }),
};

let server: Server;
let baseUrl = '';
let currentAuth: Record<string, unknown> = {};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((_req: any, res: any, next: any) => {
    res.locals.auth = { tenantId: T, requestId: 'req-p04', authMode: 'prod', ...currentAuth };
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

async function transition(to = 'processing'): Promise<{ status: number; body: Record<string, any> }> {
  const r = await fetch(`${baseUrl}/open/work_order/${WO}/transition`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to }),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}

describe('P0-4 · 路由层把 worker 档案集合接入 transition()', () => {
  it('worker 流转他人名下工单 → 403，且不执行 UPDATE', async () => {
    currentAuth = { userId: 'u-worker', role: 'worker', username: 'worker-a' };
    const calls = makeClient([
      workerProfileHandler(['W1']),
      workOrderRow('W-OTHER'),
      defHandler,
    ]);
    const r = await transition();
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FORBIDDEN');
    expect(calls.some((c) => c.text.includes('UPDATE work_orders SET status'))).toBe(false);
  });

  it('worker 未解析出任何档案 → 403（路由必须传空集合，而不是省略参数）', async () => {
    currentAuth = { userId: 'u-worker', role: 'worker', username: 'worker-a' };
    const calls = makeClient([
      workerProfileHandler([]),
      workOrderRow('W1'),
      defHandler,
    ]);
    const r = await transition();
    expect(r.status).toBe(403);
    expect(calls.some((c) => c.text.includes('UPDATE work_orders SET status'))).toBe(false);
  });

  it('worker 流转本人名下工单 → 通过守卫（继续走状态机，不再 403）', async () => {
    currentAuth = { userId: 'u-worker', role: 'worker', username: 'worker-a' };
    const calls = makeClient([
      workerProfileHandler(['W1']),
      workOrderRow('W1'),
      defHandler,
      {
        match: (t) => t.includes('UPDATE work_orders SET status'),
        reply: () => ({
          rows: [{
            id: WO, tenant_id: T, order_no: 'WO-P04-1', status: 'processing',
            assignee_id: 'W1', def_version: 0, auto_flow: false,
          }],
          rowCount: 1,
        }),
      },
    ]);
    const r = await transition();
    expect(r.status).toBe(200);
    expect(calls.some((c) => c.text.includes('UPDATE work_orders SET status'))).toBe(true);
  });
});

// P1-6：评价只能由报修人本人发起（created_by 唯一稳定账号身份）
describe('评价主体守卫', () => {
  it('管理员评价他人报修单 → 403 REPORTER_ONLY，且不执行 UPDATE', async () => {
    currentAuth = { userId: 'u-admin', role: 'admin', username: 'admin' };
    const calls = makeClient([
      {
        match: (t) => t.includes('SELECT * FROM work_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE'),
        reply: () => ({
          rows: [{
            id: WO, tenant_id: T, order_no: 'WO-EVAL-1', status: 'closed',
            assignee_id: 'W1', created_by: 'u-creator', def_version: 0,
          }],
          rowCount: 1,
        }),
      },
      defHandler,
    ]);
    const r = await fetch(`${baseUrl}/open/work_order/${WO}/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'evaluated', score: 5 }),
    });
    const body = (await r.json()) as any;
    expect(r.status).toBe(403);
    expect(body.code).toBe('REPORTER_ONLY');
    expect(calls.some((c) => c.text.includes('UPDATE work_orders SET status'))).toBe(false);
  });
});

// 2026-11-14 方向 C：催办（报修人/管理员；30 分钟限一次；终态不可催）。
describe('工单催办', () => {
  const orderRow = (over: Record<string, unknown> = {}): Handler => ({
    match: (t) => t.includes('SELECT id, order_no, status, assignee_id, created_by, title FROM work_orders'),
    reply: () => ({
      rows: [{
        id: WO, order_no: 'WO-URGE-1', status: 'processing', assignee_id: 'W1',
        created_by: 'u-creator', title: '空调不制冷', ...over,
      }],
      rowCount: 1,
    }),
  });
  const urge = () => fetch(`${baseUrl}/open/work_order/${WO}/urge`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> }));

  it('建单人催办 → 200 + urge 事件 + 通知处理人', async () => {
    currentAuth = { role: 'worker', userId: 'u-creator', username: 'creator' };
    const calls = makeClient([
      orderRow(),
      defHandler,
      { match: (t) => t.includes("type='urge' AND actor=$3"), reply: () => ({ rows: [], rowCount: 0 }) },
    ]);
    const r = await urge();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(calls.some((c) => c.text.includes("'urge'"))).toBe(true);
    expect(calls.some((c) => c.text.includes('INSERT INTO notification'))).toBe(true);
  });

  it('负控制：30 分钟内重复催办 → 429', async () => {
    currentAuth = { role: 'worker', userId: 'u-creator', username: 'creator' };
    makeClient([
      orderRow(),
      defHandler,
      { match: (t) => t.includes("type='urge' AND actor=$3"), reply: () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }) },
    ]);
    const r = await urge();
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('URGE_TOO_FREQUENT');
  });

  it('负控制：终态工单 → 409；非建单人且无 ticket.manage → 403', async () => {
    currentAuth = { role: 'admin', username: 'admin' };
    makeClient([orderRow({ status: 'completed' }), defHandler]);
    expect((await urge()).status).toBe(409);

    currentAuth = { role: 'worker', userId: 'u-other', username: 'other' };
    makeClient([orderRow(), defHandler]);
    expect((await urge()).status).toBe(403);
  });
});
// 根因：/assets/:id/fault 把资产置 repairing，工单完成后没有任何反向联动。
describe('资产维修状态回写', () => {
  const rowAt = (status: string): Handler => ({
    match: (t) => t.includes('SELECT * FROM work_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE'),
    reply: () => ({
      rows: [{ id: WO, tenant_id: T, order_no: 'WO-P04-1', status, assignee_id: 'W1', def_version: 0 }],
      rowCount: 1,
    }),
  });
  const updateHandler: Handler = {
    match: (t) => t.includes('UPDATE work_orders SET status'),
    reply: (_t, p) => ({
      rows: [{ id: WO, tenant_id: T, order_no: 'WO-P04-1', status: String(p?.[2] ?? 'completed'), assignee_id: 'W1', def_version: 0, auto_flow: false }],
      rowCount: 1,
    }),
  };

  it('流转到完成态 → 关联维修中资产恢复在用（且带 tenant_id + 工单 id）', async () => {
    currentAuth = { role: 'admin', username: 'admin' };
    const calls = makeClient([rowAt('processing'), defHandler, updateHandler]);
    const r = await transition('completed');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const assetUpdate = calls.find((c) => c.text.includes("UPDATE asset SET status='in_use'"));
    expect(assetUpdate).toBeTruthy();
    expect(assetUpdate!.text).toContain('tenant_id=$1');
    expect(assetUpdate!.params).toContain(WO);
  });

  it('负控制：未完成流转（assigned → processing）不得改动资产状态', async () => {
    currentAuth = { role: 'admin', username: 'admin' };
    const calls = makeClient([
      rowAt('assigned'),
      defHandler,
      { match: (t) => t.includes('UPDATE work_orders SET status'), reply: () => ({ rows: [{ id: WO, status: 'processing', assignee_id: 'W1', def_version: 0 }], rowCount: 1 }) },
    ]);
    const r = await transition('processing');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(calls.some((c) => c.text.includes("UPDATE asset SET status='in_use'"))).toBe(false);
  });
});
