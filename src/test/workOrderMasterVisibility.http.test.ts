// workOrderMasterVisibility.http.test.ts —— P2-2（初一拍板：派了才可见）回归护栏。
//
//   师傅角色（worker / operator）×（分派/未分派）可见性矩阵：
//     - 列表：worker 与 operator 一律 scope 到 assignee=本人（未分派单列表不可见）；
//       显式传 assignee=他人 被覆盖（防越权）；
//     - 详情：本人单 200；他人单/未分派单 403（未分派唯一可见面=抢单大厅）；
//     - 降级纪律：档案查不到 → 放行全量（一线可用性优先，既有口径回归；
//       列表侧 M4 + 详情侧 M10 双覆盖）；
//     - 防越权覆盖：显式传 assignee=他人被覆盖，worker（M1）与 operator（M11）双覆盖；
//     - 8 operator 试点兼容：抢单大厅 /open/claim-hall 未分派单照常可见（不受影响）；
//     - 非师傅角色（admin/dispatcher）行为零变化（列表不过滤）。
//
// 断言纪律：一律断言真实 HTTP 状态码，禁止 try/catch 空过。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(h.client),
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
const ME = 'W0001';
const OTHER = 'W0002';

let server: Server;
let baseUrl = '';
const auth = { tenantId: T, requestId: 'req-p2-2', userId: 'u-1', username: 'master', role: 'worker', authMode: 'prod' as const };

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
  // resolveWorkerId：token userId → worker.id=ME
  { match: (t) => t.includes('FROM worker WHERE tenant_id=$2 AND (account_id=$1 OR id=$1)'), reply: () => ({ rows: [{ id: ME }] }) },
  // list()：把收到的 SQL/参数原样放行（断言在 calls 上做）
  { match: (t) => t.includes('FROM work_orders wo') && (t.includes('COUNT(*)') || t.includes('ORDER BY wo.created_at')), reply: (t, p) => (t.includes('COUNT(*)') ? { rows: [{ c: '1' }] } : { rows: [{ id: 'wo-1', order_no: 'WO_1', status: 'assigned', assignee_id: ME }] }) },
  { match: (t) => t.includes('FROM workflow_def'), reply: () => ({ rows: [] }) },
];

const findOneHandlers = (assigneeId: string | null): Handler[] => [
  { match: (t) => t.includes('FROM worker WHERE tenant_id=$2 AND (account_id=$1 OR id=$1)'), reply: () => ({ rows: [{ id: ME }] }) },
  { match: (t) => t.includes('FROM work_orders') && t.includes('WHERE'), reply: () => ({ rows: [{ id: 'wo-x', order_no: 'WO_X', status: 'assigned', assignee_id: assigneeId }] }) },
  { match: (t) => t.includes('FROM workflow_def'), reply: () => ({ rows: [] }) },
  { match: (t) => t.includes('FROM ticket_event'), reply: () => ({ rows: [] }) },
];

const get = async (path: string, role = 'worker') => {
  auth.role = role;
  const r = await fetch(baseUrl + path);
  auth.role = 'worker';
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
};

describe('P2-2 派了才可见：师傅角色列表按分派关系过滤', () => {
  it('M1 worker 列表：assignee 强制=本人（显式传他人被覆盖，未分派单天然不可见）', async () => {
    const calls = makeClient(listHandlers());
    const r = await get('/open/work_orders?assignee=W9999', 'worker');
    expect(r.status).toBe(200);
    const listCall = calls.find((c) => c.text.includes('FROM work_orders wo') && c.text.includes('ORDER BY'));
    expect(listCall).toBeTruthy();
    // scoped assignee 必须是本人 W0001，而不是显式传入的 W9999
    expect(listCall!.params).toContain(ME);
    expect(listCall!.params).not.toContain('W9999');
  });

  it('M2 operator 列表：同口径 scope 到本人（P2-2 新行为，未分派单列表不可见）', async () => {
    const calls = makeClient(listHandlers());
    const r = await get('/open/work_orders', 'operator');
    expect(r.status).toBe(200);
    const listCall = calls.find((c) => c.text.includes('FROM work_orders wo') && c.text.includes('ORDER BY'));
    expect(listCall!.params).toContain(ME);
  });

  it('M3 admin 列表：行为零变化（不注入 assignee 过滤）', async () => {
    const calls = makeClient(listHandlers());
    const r = await get('/open/work_orders', 'admin');
    expect(r.status).toBe(200);
    const listCall = calls.find((c) => c.text.includes('FROM work_orders wo') && c.text.includes('ORDER BY'));
    expect(listCall!.params).not.toContain(ME);
  });

  it('M4 降级纪律：师傅档案查不到 → 放行全量（warn，不阻断一线）', async () => {
    const calls = makeClient([
      { match: (t) => t.includes('FROM worker WHERE'), reply: () => ({ rows: [], rowCount: 0 }) },
      ...listHandlers().slice(1),
    ]);
    const r = await get('/open/work_orders', 'operator');
    expect(r.status).toBe(200);
    const listCall = calls.find((c) => c.text.includes('FROM work_orders wo') && c.text.includes('ORDER BY'));
    expect(listCall!.params).not.toContain(ME); // 未注入 scope = 降级放行
  });
  it('M11 operator 列表：显式传 assignee=他人同样被覆盖（QA 复验缺口②：operator 侧防越权对齐 worker）', async () => {
    const calls = makeClient(listHandlers());
    const r = await get('/open/work_orders?assignee=W9999', 'operator');
    expect(r.status).toBe(200);
    const listCall = calls.find((c) => c.text.includes('FROM work_orders wo') && c.text.includes('ORDER BY'));
    expect(listCall).toBeTruthy();
    expect(listCall!.params).toContain(ME);
    expect(listCall!.params).not.toContain('W9999');
  });
});

describe('P2-2 派了才可见：详情同口径', () => {
  it('M5 worker 详情：本人单 200', async () => {
    makeClient(findOneHandlers(ME));
    const r = await get('/open/work_order/wo-x', 'worker');
    expect(r.status).toBe(200);
  });

  it('M6 worker 详情：他人单 403（既有行为回归）', async () => {
    makeClient(findOneHandlers(OTHER));
    const r = await get('/open/work_order/wo-x', 'worker');
    expect(r.status).toBe(403);
  });

  it('M7 operator 详情：未分派单（assignee_id NULL）→ 403（派了才可见，唯一可见面=抢单大厅）', async () => {
    makeClient(findOneHandlers(null));
    const r = await get('/open/work_order/wo-x', 'operator');
    expect(r.status).toBe(403);
  });

  it('M8 operator 详情：分派给本人 → 200（试点师傅正常作业）', async () => {
    makeClient(findOneHandlers(ME));
    const r = await get('/open/work_order/wo-x', 'operator');
    expect(r.status).toBe(200);
  });

  it('M10 详情降级纪律：operator 档案查不到 → 放行（QA 复验缺口①：详情侧降级同列表，不 500 不误 403）', async () => {
    makeClient([
      { match: (t) => t.includes('FROM worker WHERE'), reply: () => ({ rows: [], rowCount: 0 }) },
      ...findOneHandlers(OTHER).slice(1),
    ]);
    const r = await get('/open/work_order/wo-x', 'operator');
    expect(r.status).toBe(200);
  });
});

describe('P2-2 兼容性：抢单大厅不受影响（8 operator 试点行为保留）', () => {
  it('M9 claim-hall 未分派单照常可见（operator 视角回归）', async () => {
    const calls = makeClient([
      { match: (t) => t.includes("status IN ('claim_hall','pending_dispatch')"), reply: () => ({ rows: [{ id: 'wo-hall', order_no: 'WO_H', status: 'claim_hall', assignee_id: null }] }) },
      { match: (t) => t.includes('FROM workflow_def'), reply: () => ({ rows: [] }) },
    ]);
    const r = await get('/open/claim-hall', 'operator');
    expect(r.status).toBe(200);
    expect((r.body as any).items.length).toBe(1);
    const hallCall = calls.find((c) => c.text.includes('claim_hall'));
    expect(hallCall).toBeTruthy();
  });
});
