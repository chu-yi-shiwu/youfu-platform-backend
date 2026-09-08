// workOrderDrillDownFilter.http.test.ts —— 工作台下钻（#949 续）纯加法三参的真·HTTP 层回归护栏。
//
//   GET /open/work_orders 新增三个可选筛选（全不传 = 旧版行为零变化）：
//     auto_flow=1 → 只回自动流转单（wo.auto_flow = true，工作台"自动派单"卡下钻）；
//     today=1     → 只回当日创建单（wo.created_at::date = CURRENT_DATE，与统计卡 today_new 同口径）；
//     timeout=1   → 只回超时且未闭环单（sla_due_at 已过且未进终态；终态排除集复用 SLA 扫描
//                   口径 doneStates(def)+terminalStates(def)，def 驱动不写死——DEFAULT 4 态
//                   兜底下 = ['completed']，RICH 模板租户运行时自动扩为全终态集）。
//
// 断言纪律：一律断言真实 HTTP 状态码（对齐 workOrderFilterAssigneeFlag.http.test.ts），禁止 try/catch 空过。
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
  default: { connect: async () => { throw new Error('[workOrderDrillDownFilter.http.test] 单测禁用真实 pool'); } },
}));

import workOrderRouter from '../routes/workOrder.js';
import { DEFAULT_WORK_ORDER_DEF, doneStates, terminalStates } from '../engine/stateMachine.js';

// 期望排除集与 repo list() 同式现算（复用 SLA 扫描口径 doneStates+terminalStates）：
// mock getWorkflowDef 回退 DEFAULT def（4 态）→ 排除集 = ['completed']；
// RICH 模板租户运行时会自动扩展为 completed/closed/evaluated/cancelled（def 驱动，不写死）。
const EXPECTED_EXCLUDE = Array.from(
  new Set([...doneStates(DEFAULT_WORK_ORDER_DEF), ...terminalStates(DEFAULT_WORK_ORDER_DEF)]),
).sort();

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

const T = 't-wo-drill';
const WO_ID = '33333333-3333-4333-8333-333333333333';

/** list() 的 SQL 形状断言辅助——COUNT 与 SELECT 两条 SQL 都要带上（或都不带）新条件。 */
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
  requestId: 'req-wo-drill',
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

const findListCall = (calls: Array<{ text: string; params?: unknown[] }>) => calls.find((c) => c.text.includes('ORDER BY wo.created_at'));

// ==================== 工作台下钻（#949 续）：列表三参筛选 ====================
describe('工作台下钻：GET /open/work_orders 三参筛选（纯加法）', () => {
  it('auto_flow=1：SQL 只拼 wo.auto_flow = true（无参数，硬编码布尔）', async () => {
    const { client, calls } = makeClient(listHandlers([{ id: WO_ID, order_no: 'WO_1', status: 'processing', auto_flow: true, assignee_name: null }]));
    h.client = client;
    const r = await get('/open/work_orders?auto_flow=1');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const listCall = findListCall(calls);
    expect(listCall).toBeTruthy();
    expect(listCall!.text).toContain('wo.auto_flow = true');
    // 该条件是硬编码布尔，不带占位参数（tenant_id = $1 之外无新增参数）
    expect(listCall!.params).toEqual([T]);
    expect(r.body.items[0].auto_flow).toBe(true);
  });

  it("auto_flow='true' 与 '1' 等价（qstr 风格布尔归一）", async () => {
    const { client, calls } = makeClient(listHandlers([]));
    h.client = client;
    const r = await get('/open/work_orders?auto_flow=true');
    expect(r.status).toBe(200);
    expect(findListCall(calls)!.text).toContain('wo.auto_flow = true');
  });

  it('today=1：SQL 拼 wo.created_at::date = CURRENT_DATE（与 /stats today_new 同口径）', async () => {
    const { client, calls } = makeClient(listHandlers([]));
    h.client = client;
    const r = await get('/open/work_orders?today=1');
    expect(r.status).toBe(200);
    const listCall = findListCall(calls);
    expect(listCall!.text).toContain('wo.created_at::date = CURRENT_DATE');
    expect(listCall!.params).toEqual([T]);
  });

  it("today='true' 与 '1' 等价", async () => {
    const { client, calls } = makeClient(listHandlers([]));
    h.client = client;
    const r = await get('/open/work_orders?today=true');
    expect(r.status).toBe(200);
    expect(findListCall(calls)!.text).toContain('wo.created_at::date = CURRENT_DATE');
  });

  it("timeout=1：SQL 拼超时三段条件，排除集=def 派生终态并集（DEFAULT def 下为 ['completed']）", async () => {
    const { client, calls } = makeClient(listHandlers([]));
    h.client = client;
    const r = await get('/open/work_orders?timeout=1');
    expect(r.status).toBe(200);
    const listCall = findListCall(calls);
    expect(listCall).toBeTruthy();
    expect(listCall!.text).toContain('wo.sla_due_at IS NOT NULL');
    expect(listCall!.text).toContain('wo.sla_due_at < now()');
    expect(listCall!.text).toContain('wo.status <> ALL($');
    // 排除集参数 = doneStates(DEFAULT)+terminalStates(DEFAULT) 去重并集（复用 SLA 扫描口径）
    const excludeParam = (listCall!.params as unknown[]).find(
      (p) => Array.isArray(p) && (p as string[]).includes('completed'),
    ) as string[] | undefined;
    expect(excludeParam).toBeTruthy();
    expect([...excludeParam!].sort()).toEqual(EXPECTED_EXCLUDE);
  });

  it('timeout=1 与 status 组合：两条件同时出现在同一条 SQL', async () => {
    const { client, calls } = makeClient(listHandlers([]));
    h.client = client;
    const r = await get('/open/work_orders?timeout=1&status=processing');
    expect(r.status).toBe(200);
    const listCall = findListCall(calls);
    expect(listCall!.text).toContain('wo.status = ANY(');
    expect(listCall!.text).toContain('wo.sla_due_at IS NOT NULL');
  });

  it('三参组合（auto_flow=1&today=1&timeout=1）：三条件同条 SQL 齐发', async () => {
    const { client, calls } = makeClient(listHandlers([]));
    h.client = client;
    const r = await get('/open/work_orders?auto_flow=1&today=1&timeout=1');
    expect(r.status).toBe(200);
    const listCall = findListCall(calls);
    expect(listCall!.text).toContain('wo.auto_flow = true');
    expect(listCall!.text).toContain('wo.created_at::date = CURRENT_DATE');
    expect(listCall!.text).toContain('wo.sla_due_at < now()');
  });

  it('回归：三参全不传时 SQL 不出现新条件，行为与旧版一致', async () => {
    const { client, calls } = makeClient(listHandlers([{ id: WO_ID, order_no: 'WO_1', status: 'draft', auto_flow: false, assignee_name: null }]));
    h.client = client;
    const r = await get('/open/work_orders?limit=5');
    expect(r.status).toBe(200);
    const listCall = findListCall(calls);
    expect(listCall).toBeTruthy();
    expect(listCall!.text).not.toContain('wo.auto_flow =');
    expect(listCall!.text).not.toContain('wo.created_at::date');
    expect(listCall!.text).not.toContain('wo.sla_due_at');
    // 旧口径仍在：租户隔离 + LIMIT 上限
    expect(listCall!.text).toContain('wo.tenant_id = $1');
    expect(listCall!.text).toContain('LIMIT 5');
  });

  it("回归：传非布尔值（如 auto_flow=0 / timeout=yes）不触发过滤（与 unsettled 同风格）", async () => {
    const { client, calls } = makeClient(listHandlers([]));
    h.client = client;
    const r = await get('/open/work_orders?auto_flow=0&today=0&timeout=yes');
    expect(r.status).toBe(200);
    const listCall = findListCall(calls);
    expect(listCall!.text).not.toContain('wo.auto_flow =');
    expect(listCall!.text).not.toContain('wo.created_at::date');
    expect(listCall!.text).not.toContain('wo.sla_due_at');
  });
});
