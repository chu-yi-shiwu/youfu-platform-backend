// settlement.http.test.ts —— 真·HTTP 层结算权限与冲突语义测试（**prod 鉴权模式**）。
//
// 【为什么必须另起一个文件用真 HTTP】
//   hasPerm() 在 authMode:'dev' 下恒返回 true（src/middleware/role.ts:87）——
//   既有全部 HTTP 层测试都注入 dev 模式，因此 **403 分支从来没有被真正走到过**：
//   权限矩阵写错、requirePermission 漏调，测试全绿，线上直接越权。
//   本文件固定注入 authMode:'prod'，跑真实 express 路由 + errorMiddleware，
//   断言的是**真实 HTTP 状态码**（403/409/400），不是「有没有抛异常」。
//
// 断言纪律（QA 明确要求）：禁止 try{...}catch(e){expect(e.status)...} 这种「不抛错就空过」的写法。
//   本文件一律用 `expect(res.status).toBe(403)` —— 接口要是返回 200，断言立刻红。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';
import type { AuthLocals } from '../middleware/auth.js';

// ---- mock 掉 DB 连接池：withTenantClient 直接把脚本化 client 交给回调（不连真库）----
const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(h.client),
  assertSafeTenantId: (t: string) => t,
  default: { connect: async () => { throw new Error('[settlement.http.test] 单测禁用真实 pool'); } },
}));

import settlementRouter from '../routes/settlement.js';

// ---- 脚本化 mock client：按 SQL 片段命中 handler；strict 模式下未命中直接炸（防新增 SQL 无感知）----
interface Handler {
  match: (text: string) => boolean;
  reply: (text: string, params: unknown[]) => { rows: unknown[]; rowCount?: number };
}

function makeClient(handlers: Handler[], opts?: { strict?: boolean }) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const misses: string[] = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      for (const hd of handlers) {
        if (hd.match(text)) return hd.reply(text, params ?? []);
      }
      misses.push(text);
      if (opts?.strict) throw new Error(`[mock] 未命中 handler 的 SQL：${text}`);
      return { rows: [], rowCount: 1 };
    },
  };
  return { client, calls, misses } as { client: unknown; calls: typeof calls; misses: string[] };
}

const T = 't-settle-http';

/** 无租户覆盖行 → hasPerm 走默认矩阵（这才是生产默认形态）。 */
const BASE: Handler[] = [
  {
    match: (t) => t.includes('SELECT perm FROM role_permission'),
    reply: () => ({ rows: [], rowCount: 0 }),
  },
];

// ---- 真实 express + 真 HTTP 服务器（prod 鉴权上下文）----
let server: Server;
let baseUrl = '';
const auth: AuthLocals & { role: string } = {
  tenantId: T,
  requestId: 'req-http',
  idempotencyKey: undefined,
  userId: 'u-1',
  username: 'admin',
  role: 'admin',
  authMode: 'prod',
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // 替代 authMiddleware：直接注入 prod 模式的鉴权上下文
  app.use((_req, res, next) => {
    res.locals.auth = auth;
    next();
  });
  app.use('/api/v1', settlementRouter);
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

interface Res {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts?: { body?: unknown; role?: string | null; authMode?: 'prod' | 'dev' },
): Promise<Res> {
  // role 显式传 null = 「请求里没有角色」；未传（undefined）才回落到 admin。
  auth.role = (opts?.role === undefined ? 'admin' : opts.role) as string;
  auth.username = auth.role;
  auth.authMode = opts?.authMode ?? 'prod';
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (opts?.body !== undefined) init.body = JSON.stringify(opts.body);
  const r = await fetch(`${baseUrl}${path}`, init);
  const text = await r.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: r.status, body };
}

// ==================== 一、settlement.read 权限（真实 HTTP 403）====================
const READ_HANDLERS: Handler[] = [
  ...BASE,
  { match: (t) => t.includes('COUNT(*)::int AS c FROM settlement WHERE'), reply: () => ({ rows: [{ c: 0 }] }) },
  { match: (t) => t.includes('SELECT * FROM settlement WHERE'), reply: () => ({ rows: [], rowCount: 0 }) },
];

describe('settlement.read（prod 模式 · 真 HTTP 状态码）', () => {
  it('admin / operator → 200（默认矩阵含 settlement.read）', async () => {
    h.client = makeClient(READ_HANDLERS, { strict: true }).client;
    const a = await call('GET', '/settlements', { role: 'admin' });
    expect(a.status).toBe(200);
    expect(a.body.ok).toBe(true);
    const o = await call('GET', '/settlements', { role: 'operator' });
    expect(o.status).toBe(200);
  });

  it('worker / reviewer / dispatcher / service_desk → 403（默认矩阵无结算权限点）', async () => {
    h.client = makeClient(READ_HANDLERS, { strict: true }).client;
    for (const role of ['worker', 'reviewer', 'dispatcher', 'service_desk']) {
      const r = await call('GET', '/settlements', { role });
      expect(r.status, `role=${role} 期望 403，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(403);
      expect(r.body.ok).toBe(false);
      expect(String(r.body.message)).toContain('settlement.read');
    }
  });

  it('角色缺失（role 为空）→ 403（防「无角色即放行」）', async () => {
    h.client = makeClient(READ_HANDLERS, { strict: true }).client;
    const r = await call('GET', '/settlements', { role: null });
    expect(r.status, `期望 403，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(403);
  });

  it('诚实边界：dev 模式下 worker 也能读（hasPerm 短路放行——正因如此旧测试从未走到 403）', async () => {
    h.client = makeClient(READ_HANDLERS, { strict: true }).client;
    const r = await call('GET', '/settlements', { role: 'worker', authMode: 'dev' });
    expect(r.status).toBe(200); // 记录现状：dev 放行是设计如此，但生产绝不能落到这个分支
  });
});

// ==================== 二、settlement.edit 权限（真实 HTTP 403）====================
function draftHandlers(opts?: { settled?: unknown[]; orderRows?: unknown[] }): Handler[] {
  const orders = opts?.orderRows ?? [
    { id: 'WO_20260905_0001', order_no: 'WO_1', status: 'completed', category: '空调维修' },
  ];
  return [
    ...BASE,
    {
      match: (t) => t.includes('FROM work_orders') && t.includes('ANY($2'),
      reply: () => ({ rows: orders }),
    },
    {
      match: (t) => t.includes('FROM settlement_item si') && t.includes('JOIN work_orders'),
      reply: () => ({ rows: opts?.settled ?? [] }),
    },
    { match: (t) => t.includes('COUNT(*)::int AS c FROM settlement WHERE'), reply: () => ({ rows: [{ c: 0 }] }) },
    // 单号唯一冲突重试路径（QA 修复③）：SAVEPOINT / RELEASE / ROLLBACK TO 都是真 SQL 往返
    {
      match: (t) => /^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(t),
      reply: () => ({ rows: [], rowCount: 0 }),
    },
    { match: (t) => t.includes('INSERT INTO settlement ('), reply: () => ({ rows: [{ id: 'st-1' }] }) },
    {
      match: (t) => t.includes('FROM product_catalog'),
      reply: (_t, p) => ({ rows: p[1] && (p[1] as string[]).includes('空调维修') ? [{ code: 'AC', name: '空调维修', price: '120.00' }] : [] }),
    },
    { match: (t) => t.includes('INSERT INTO settlement_item'), reply: () => ({ rows: [], rowCount: 1 }) },
    { match: (t) => t.includes('UPDATE settlement SET total'), reply: () => ({ rows: [], rowCount: 1 }) },
    {
      match: (t) => t.includes('SELECT * FROM settlement WHERE id'),
      reply: () => ({ rows: [{ id: 'st-1', settlement_no: 'ST202609050001', status: 'draft', total: '120.00', item_count: 1 }] }),
    },
  ];
}

describe('settlement.edit（prod 模式 · 真 HTTP 状态码）', () => {
  it('admin → 201（建草稿成功）', async () => {
    h.client = makeClient(draftHandlers(), { strict: true }).client;
    const r = await call('POST', '/settlements', { role: 'admin', body: { work_order_ids: ['WO_20260905_0001'] } });
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
  });

  it('operator → 403（settlement.edit 仅 admin；operator 只有 read）', async () => {
    h.client = makeClient(draftHandlers(), { strict: true }).client;
    const r = await call('POST', '/settlements', { role: 'operator', body: { work_order_ids: ['WO_20260905_0001'] } });
    expect(r.status, `期望 403，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(403);
    expect(String(r.body.message)).toContain('settlement.edit');
  });

  it('operator 改价 → 403', async () => {
    h.client = makeClient(draftHandlers(), { strict: true }).client;
    const r = await call('PUT', '/settlements/st-1/items/si-1', { role: 'operator', body: { price: 1 } });
    expect(r.status).toBe(403);
  });

  it('operator 删除 → 403', async () => {
    h.client = makeClient(draftHandlers(), { strict: true }).client;
    const r = await call('DELETE', '/settlements/st-1', { role: 'operator' });
    expect(r.status).toBe(403);
  });

  it('operator 确认 → 403', async () => {
    h.client = makeClient(draftHandlers(), { strict: true }).client;
    const r = await call('POST', '/settlements/st-1/confirm', { role: 'operator', body: {} });
    expect(r.status).toBe(403);
  });

  it('worker / reviewer / dispatcher / service_desk 建草稿 → 403', async () => {
    h.client = makeClient(draftHandlers(), { strict: true }).client;
    for (const role of ['worker', 'reviewer', 'dispatcher', 'service_desk']) {
      const r = await call('POST', '/settlements', { role, body: { work_order_ids: ['WO_20260905_0001'] } });
      expect(r.status, `role=${role} 期望 403`).toBe(403);
    }
  });
});

// ==================== 三、409 冲突语义（4 类）====================
function itemHandlers(header: Record<string, unknown>, item: Record<string, unknown>, agg = { total: '100.00', c: 1 }): Handler[] {
  return [
    ...BASE,
    { match: (t) => t.includes('FOR UPDATE'), reply: () => ({ rows: [header] }) },
    { match: (t) => t.includes('FROM settlement_item WHERE id = $1 AND settlement_id'), reply: () => ({ rows: [item] }) },
    { match: (t) => t.includes('COUNT(*)::int AS c FROM settlement_item WHERE settlement_id'), reply: () => ({ rows: [{ c: agg.c }] }) },
    { match: (t) => t.includes('SUM(amount)'), reply: () => ({ rows: [agg] }) },
    { match: (t) => t.includes('UPDATE settlement_item SET price'), reply: () => ({ rows: [], rowCount: 1 }) },
    { match: (t) => t.includes("SET status = 'confirmed'"), reply: () => ({ rows: [], rowCount: 1 }) },
    { match: (t) => t.startsWith('DELETE FROM settlement WHERE'), reply: () => ({ rows: [], rowCount: 1 }) },
    { match: (t) => t.includes('SELECT * FROM settlement WHERE id'), reply: () => ({ rows: [header] }) },
  ];
}

const DRAFT_HEADER = { id: 'st-1', tenant_id: T, settlement_no: 'ST202609050001', status: 'draft', total: '100.00', item_count: 1 };
const CONFIRMED_HEADER = { ...DRAFT_HEADER, status: 'confirmed' };
const ITEM = { id: 'si-1', settlement_id: 'st-1', tenant_id: T, work_order_id: 'WO_20260905_0001', price: '100', qty: '1', amount: '100', note: null };

describe('结算 409 冲突语义（prod 模式 · 真 HTTP 状态码）', () => {
  it('① confirmed 后改价 → 409', async () => {
    h.client = makeClient(itemHandlers(CONFIRMED_HEADER, ITEM), { strict: true }).client;
    const r = await call('PUT', '/settlements/st-1/items/si-1', { role: 'admin', body: { price: 1 } });
    expect(r.status, `期望 409，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(409);
    expect(String(r.body.message)).toContain('已确认');
  });

  it('② confirmed 后删除 → 409', async () => {
    h.client = makeClient(itemHandlers(CONFIRMED_HEADER, ITEM), { strict: true }).client;
    const r = await call('DELETE', '/settlements/st-1', { role: 'admin' });
    expect(r.status, `期望 409，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(409);
    expect(String(r.body.message)).toContain('已确认');
  });

  it('③ 0 明细确认 → 409', async () => {
    h.client = makeClient(itemHandlers(DRAFT_HEADER, ITEM, { total: '0.00', c: 0 }), { strict: true }).client;
    const r = await call('POST', '/settlements/st-1/confirm', { role: 'admin', body: {} });
    expect(r.status, `期望 409，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(409);
    expect(String(r.body.message)).toContain('无明细');
  });

  it('④ 已结算单重复入单 → 409，且 conflicts 列明 order_no 与 reason', async () => {
    h.client = makeClient(
      draftHandlers({ settled: [{ work_order_id: 'WO_20260905_0001', order_no: 'WO_1' }] }),
      { strict: true },
    ).client;
    const r = await call('POST', '/settlements', { role: 'admin', body: { work_order_ids: ['WO_20260905_0001'] } });
    expect(r.status, `期望 409，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(409);
    expect(r.body.ok).toBe(false);
    const conflicts = r.body.conflicts as Array<Record<string, unknown>>;
    expect(Array.isArray(conflicts)).toBe(true);
    expect(conflicts).toEqual([
      { work_order_id: 'WO_20260905_0001', order_no: 'WO_1', reason: 'already_settled' },
    ]);
    // conflicts 必须同时带上单号与原因（前端要靠它逐行提示）
    expect(conflicts[0].order_no).toBeTruthy();
    expect(conflicts[0].reason).toBe('already_settled');
  });

  it('④b 冲突时不得建单（无 INSERT settlement）', async () => {
    const mk = makeClient(draftHandlers({ settled: [{ work_order_id: 'WO_20260905_0001', order_no: 'WO_1' }] }), { strict: true });
    h.client = mk.client;
    await call('POST', '/settlements', { role: 'admin', body: { work_order_ids: ['WO_20260905_0001'] } });
    expect(mk.calls.some((c) => c.text.includes('INSERT INTO settlement ('))).toBe(false);
  });
});

// ==================== 四、入参校验（400）====================
describe('结算入参校验（prod 模式）', () => {
  it('同一 work_order_id 传两次 → 400（自撞 UNIQUE 的明确拒绝，而非 500）', async () => {
    h.client = makeClient(draftHandlers(), { strict: true }).client;
    const r = await call('POST', '/settlements', {
      role: 'admin',
      body: { work_order_ids: ['WO_20260905_0001', 'WO_20260905_0001'] },
    });
    expect(r.status, `期望 400，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(400);
    expect(String(r.body.message)).toContain('重复');
  });

  it('work_order_ids 空数组 → 400（zod 校验）', async () => {
    h.client = makeClient(draftHandlers(), { strict: true }).client;
    const r = await call('POST', '/settlements', { role: 'admin', body: { work_order_ids: [] } });
    expect(r.status).toBe(400);
  });

  it('缺 work_order_ids 字段 → 400', async () => {
    h.client = makeClient(draftHandlers(), { strict: true }).client;
    const r = await call('POST', '/settlements', { role: 'admin', body: {} });
    expect(r.status).toBe(400);
  });

  it('改价传负数 → 400（price 必须非负）', async () => {
    h.client = makeClient(itemHandlers(DRAFT_HEADER, ITEM), { strict: true }).client;
    const r = await call('PUT', '/settlements/st-1/items/si-1', { role: 'admin', body: { price: -1 } });
    expect(r.status).toBe(400);
  });
});
