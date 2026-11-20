// workOrderFilterAssigneeFlag.http.test.ts —— 2026-09-07 三项决策的真·HTTP 层回归护栏。
//
//   任务一（决策 #8）：工单列表服务端筛选 department/priority/source/service_desk
//     —— 单独过滤生效 + 与 status 组合生效 + 不传时行为与旧版完全一致（回归）。
//   任务二（决策 #7）：列表/详情下发 assignee_name（LEFT JOIN worker，无承接人 → null）。
//   任务三（决策 #5）：租户开关 ticket_require_service_desk —— 默认关（建单不带服务台完全合法）；
//     开启后直接建单缺服务台 → 422 SERVICE_DESK_REQUIRED；翻转接口。
//     ⚠️ 原「来电弹屏代申告路径豁免」随该端点 2026-10-28 下线删除（现已无豁免分支）。
//
// 断言纪律：一律断言真实 HTTP 状态码（对齐 acceptance.http.test.ts），禁止 try/catch 空过。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';
import type { AuthLocals } from '../middleware/auth.js';

// ---- mock 掉 DB 连接池 ----
const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(h.client),
  assertSafeTenantId: (t: string) => t,
  default: { connect: async () => { throw new Error('[workOrderFilterAssigneeFlag.http.test] 单测禁用真实 pool'); } },
}));

import workOrderRouter from '../routes/workOrder.js';

interface Handler {
  match: (text: string) => boolean;
  reply: (text: string, params: unknown[]) => { rows: unknown[]; rowCount?: number };
}

function makeClient(handlers: Handler[], opts?: { strict?: boolean }) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      for (const hd of handlers) {
        if (hd.match(text)) return hd.reply(text, params ?? []);
      }
      if (opts?.strict) throw new Error(`[mock] 未命中 handler 的 SQL：${text}`);
      return { rows: [], rowCount: 1 };
    },
  };
  return { client, calls } as { client: unknown; calls: typeof calls };
}

const T = 't-wo-filter';
const WO_ID = '22222222-2222-4222-8222-222222222222';
const DEPT_UUID = '33333333-3333-4333-8333-333333333333';

/** 任务一：list() 的 SQL 形状断言辅助——COUNT 与 SELECT 两条 SQL 都要带上（或都不带）新条件。 */
function listHandlers(listRows: unknown[]): Handler[] {
  return [
    {
      match: (t) => t.includes('FROM work_orders wo') && (t.includes('COUNT(*)') || t.includes('ORDER BY wo.created_at')),
      reply: (t) => (t.includes('COUNT(*)') ? { rows: [{ c: String(listRows.length) }] } : { rows: listRows }),
    },
    { match: (t) => t.includes('FROM workflow_def'), reply: () => ({ rows: [] }) }, // getWorkflowDef → 引擎默认 def
  ];
}

// ---- 真实 express + 真 HTTP ----
let server: Server;
let baseUrl = '';
const auth: AuthLocals & { role: string } = {
  tenantId: T,
  requestId: 'req-wo-filter',
  idempotencyKey: undefined,
  userId: 'u-1',
  username: 'admin',
  role: 'admin',
  authMode: 'prod',
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = auth;
    next();
  });
  app.use('/api/v1', workOrderRouter);
  app.use((_req, res) => res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'not found' }));
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const get = async (path: string) => {
  const r = await fetch(baseUrl + path);
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
// ==================== 任务一（决策 #8）：列表服务端筛选 ====================
describe('任务一：GET /open/work_orders 服务端筛选四参', () => {
  it('department 单独过滤生效（SQL 条件 + 参数）', async () => {
    const { client, calls } = makeClient(listHandlers([{ id: WO_ID, order_no: 'WO_1', status: 'open', department_id: DEPT_UUID, department_name: '护理部', assignee_name: null }]));
    h.client = client;
    const r = await get('/open/work_orders?department_id=' + DEPT_UUID);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const listCall = calls.find((c) => c.text.includes('ORDER BY wo.created_at'));
    expect(listCall).toBeTruthy();
    expect(listCall!.text).toContain('wo.department_id = $');
    expect(listCall!.params).toContain(DEPT_UUID);
    expect(r.body.items[0].department_name).toBe('护理部');
  });

  it('priority / source 各自单独过滤生效', async () => {
    for (const [qs, cond, val] of [
      ['priority=urgent', 'wo.priority = $', 'urgent'],
      ['source=phone', 'wo.source = $', 'phone'],
    ] as const) {
      const { client, calls } = makeClient(listHandlers([]));
      h.client = client;
      const r = await get(`/open/work_orders?${qs}`);
      expect(r.status).toBe(200);
      const listCall = calls.find((c) => c.text.includes('ORDER BY wo.created_at'));
      expect(listCall!.text).toContain(cond);
      expect(listCall!.params).toContain(val);
    }
  });

  it('四参与 status 组合生效（同一条 SQL 同时携带全部条件）', async () => {
    const { client, calls } = makeClient(listHandlers([]));
    h.client = client;
    const r = await get('/open/work_orders?status=open&department_id=' + DEPT_UUID + '&priority=urgent&source=phone');
    expect(r.status).toBe(200);
    const listCall = calls.find((c) => c.text.includes('ORDER BY wo.created_at'));
    expect(listCall!.text).toContain('wo.status = ANY(');
    expect(listCall!.text).toContain('wo.department_id = $');
    expect(listCall!.text).toContain('wo.priority = $');
    expect(listCall!.text).toContain('wo.source = $');
    // status 为 text[] 参数（数组），其余为标量 → 扁平化后逐值断言
    const flat = (listCall!.params as unknown[]).flat();
    for (const v of ['open', DEPT_UUID, 'urgent', 'phone']) expect(flat).toContain(v);
  });

  it('回归：四参全不传时 SQL 不出现新条件，行为与旧版一致', async () => {
    const { client, calls } = makeClient(listHandlers([]));
    h.client = client;
    const r = await get('/open/work_orders?limit=5');
    expect(r.status).toBe(200);
    const listCall = calls.find((c) => c.text.includes('ORDER BY wo.created_at'));
    expect(listCall).toBeTruthy();
    expect(listCall!.text).not.toContain('wo.department =');
    expect(listCall!.text).not.toContain('wo.priority =');
    expect(listCall!.text).not.toContain('wo.source =');
    expect(listCall!.text).not.toContain('wo.service_desk =');
    // 旧口径仍在：租户隔离 + LIMIT 上限
    expect(listCall!.text).toContain('wo.tenant_id = $1');
    expect(listCall!.text).toContain('LIMIT 5');
  });
});

// ==================== 任务二（决策 #7）：assignee_name 下发 ====================
describe('任务二：列表/详情下发 assignee_name', () => {
  it('列表项透传 assignee_name（LEFT JOIN worker）', async () => {
    const { client } = makeClient(listHandlers([{ id: WO_ID, order_no: 'WO_1', status: 'assigned', assignee_id: 'w-1', assignee_name: '张三' }]));
    h.client = client;
    const r = await get('/open/work_orders');
    expect(r.status).toBe(200);
    expect(r.body.items[0].assignee_name).toBe('张三');
  });

  it('详情返回承接人姓名；SQL 为 LEFT JOIN worker 形状（JOIN 带 tenant_id 防跨租户串名）', async () => {
    const { client, calls } = makeClient([
      // findOne 新形状：SELECT wo.* ... LEFT JOIN worker w ON w.id = wo.assignee_id AND w.tenant_id = wo.tenant_id
      { match: (t) => t.includes('FROM work_orders wo') && t.includes('LEFT JOIN worker w'), reply: () => ({ rows: [{ id: WO_ID, order_no: 'WO_1', status: 'assigned', assignee_id: 'w-1', assignee_name: '李四' }] }) },
      { match: (t) => t.includes('FROM workflow_def'), reply: () => ({ rows: [] }) },
      { match: (t) => t.includes('FROM ticket_event'), reply: () => ({ rows: [] }) },
    ]);
    h.client = client;
    const r = await get(`/open/work_order/${WO_ID}`);
    expect(r.status).toBe(200);
    expect(r.body.ticket.assignee_name).toBe('李四');
    expect(r.body.ticket.code).toBe('WO_1'); // DEF-2 口径未被破坏
    const findCall = calls.find((c) => c.text.includes('LEFT JOIN worker w'));
    expect(findCall).toBeTruthy();
    expect(findCall!.text).toContain('w.name AS assignee_name');
    expect(findCall!.text).toContain('w.tenant_id = wo.tenant_id');
  });

  it('详情无承接人 → assignee_name 为 null（不丢行）', async () => {
    const { client } = makeClient([
      { match: (t) => t.includes('FROM work_orders wo') && t.includes('LEFT JOIN worker w'), reply: () => ({ rows: [{ id: WO_ID, order_no: 'WO_1', status: 'draft', assignee_id: null, assignee_name: null }] }) },
      { match: (t) => t.includes('FROM workflow_def'), reply: () => ({ rows: [] }) },
      { match: (t) => t.includes('FROM ticket_event'), reply: () => ({ rows: [] }) },
    ]);
    h.client = client;
    const r = await get(`/open/work_order/${WO_ID}`);
    expect(r.status).toBe(200);
    expect(r.body.ticket.assignee_name).toBeNull();
  });
});

// ==================== 任务三（决策 #5）：服务台租户开关 ====================

