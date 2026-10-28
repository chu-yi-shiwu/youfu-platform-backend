// serviceDesk.http.test.ts —— 服务台 + 服务台人员代报修 真·HTTP 层测试（补 #229 查证发现的测试盲区）。
//
// 覆盖五类行为：
//   ① 服务台 CRUD：admin/operator 可写（requireConfigRole）、worker 403、404 语义
//   ② **坐席端点已下线**（2026-10-28 决策：取消坐席）：GET/POST/DELETE /service-desks/:id/agents
//      均 404 —— 原「客服人员管理」2 个用例随端点删除，改为 3 条下线断言（用例数净 +1）
//   ③ 代报修建单（POST /tickets）：dto 映射断言（title/contact/businessType/priority）+
//      幂等键 svcdesk:{deskId}:{sessionId} 抢键先行（INSERT idempotency_key 先于 INSERT work_orders）
//   ④ 代报修双击防重：第二次抢键冲突 → 回查复用既有单（created=false 仍 201、id 一致）
//   ⑤ 权限点：intake.create 覆盖存在但不含该点 → 403（R35 接线：登录态建单纳入 intake.create）
//
// 断言纪律：一律断言真实 HTTP 状态码，禁止 try/catch 空过写法（对齐 acceptance.http.test.ts）。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

// ---- mock 掉 DB 连接池 ----
const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(h.client),
  assertSafeTenantId: (t: string) => t,
  default: { connect: async () => { throw new Error('[serviceDesk.http.test] 单测禁用真实 pool'); } },
}));

import serviceDeskRouter from '../routes/serviceDesk.js';

interface Handler {
  match: (text: string) => boolean;
  reply: (text: string, params: unknown[]) => { rows: unknown[]; rowCount?: number };
}

function makeClient(handlers: Handler[]) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const misses: string[] = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      for (const hd of handlers) {
        if (hd.match(text)) return hd.reply(text, params ?? []);
      }
      misses.push(text);
      return { rows: [], rowCount: 1 };
    },
  };
  return { client, calls, misses } as { client: unknown; calls: typeof calls; misses: string[] };
}

const T = 't-svcdesk-http';
const DESK = '11111111-1111-4111-8111-111111111111';
const DESK_ROW = { id: DESK, tenant_id: T, name: '一楼服务台', template: null, created_at: '2026-09-01T00:00:00Z' };

function deskHandlers(
  opts: { deskExists?: boolean; idemGrabbed?: boolean; existingWo?: Record<string, unknown> | null; permGrant?: string[] } = {},
): Handler[] {
  const deskExists = opts.deskExists ?? true;
  const idemGrabbed = opts.idemGrabbed ?? true;
  return [
    // 服务台列表 / 新建
    { match: (t) => t.includes('FROM service_desk WHERE tenant_id=$1 ORDER BY created_at'), reply: () => ({ rows: [DESK_ROW] }) },
    { match: (t) => t.startsWith('INSERT INTO service_desk'), reply: () => ({ rows: [DESK_ROW], rowCount: 1 }) },
    // PUT：先查当前行
    { match: (t) => t.includes('SELECT * FROM service_desk WHERE id=$1 AND tenant_id=$2'), reply: () => (deskExists ? { rows: [DESK_ROW], rowCount: 1 } : { rows: [], rowCount: 0 }) },
    { match: (t) => t.includes('UPDATE service_desk SET name=COALESCE'), reply: () => ({ rows: [{ ...DESK_ROW, name: '二楼服务台' }], rowCount: 1 }) },
    // 代报修 POST /tickets 的 desk 存在性校验（SELECT id FROM ...）
    { match: (t) => t.includes('SELECT id FROM service_desk WHERE id=$1 AND tenant_id=$2'), reply: () => (deskExists ? { rows: [{ id: DESK }], rowCount: 1 } : { rows: [], rowCount: 0 }) },
    // 幂等抢键（R1-001 零 DDL 串行化）
    { match: (t) => t.includes('INSERT INTO idempotency_key'), reply: () => ({ rows: [], rowCount: idemGrabbed ? 1 : 0 }) },
    { match: (t) => t.includes('SELECT work_order_id FROM idempotency_key WHERE key = $1'), reply: () => (opts.existingWo ? { rows: [{ work_order_id: opts.existingWo.id as string }] } : { rows: [] }) },
    // findOne 回查既有单（2026-09-07 决策 #7：findOne 改为 LEFT JOIN worker 下发 assignee_name，
    // SQL 形状变为 SELECT wo.* ... LEFT JOIN worker w ... WHERE wo.id=$1 AND wo.tenant_id=$2；
    // 正则同时兼容新旧两种形状，断言语义不变）
    { match: (t) => /FROM work_orders( wo)?\s+((LEFT JOIN worker[\s\S]*?)?WHERE\s+(wo\.)?id = \$1 AND (wo\.)?tenant_id = \$2)/.test(t), reply: () => ({ rows: opts.existingWo ? [opts.existingWo] : [] }) },
    // 建单 INSERT
    { match: (t) => t.startsWith('INSERT INTO work_orders'), reply: (_t, p) => ({ rows: [{ id: p[0], tenant_id: p[1], order_no: p[2], business_type: p[3], title: p[7], status: 'draft' }], rowCount: 1 }) },
    // hasPerm 覆盖查询（operator/service_desk 角色走查库路径）
    // T8 第十一批：传 permGrant 才返回 rowCount>0 的真覆盖行；不传维持原样（无 rowCount ⇒ hasPerm 走默认矩阵回退）
    { match: (t) => t.includes('SELECT perm FROM role_permission WHERE tenant_id = $1 AND role = $2'), reply: () => (opts.permGrant ? { rows: opts.permGrant.map((p) => ({ perm: p })), rowCount: opts.permGrant.length } : { rows: [{ perm: 'settlement.edit' }] }) },
  ];
}

// ---- 真实 express + 真 HTTP ----
let server: Server;
let baseUrl = '';
let currentRole = 'admin';
const baseAuth = {
  tenantId: T,
  requestId: 'req-svc',
  idempotencyKey: undefined,
  userId: 'u-1',
  username: 'tester',
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = { ...baseAuth, role: currentRole, authMode: 'prod' };
    next();
  });
  app.use('/api/v1', serviceDeskRouter);
  app.use(errorMiddleware);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const get = (path: string) => fetch(baseUrl + path);
const post = (path: string, body: unknown) =>
  fetch(baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const put = (path: string, body: unknown) =>
  fetch(baseUrl + path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const del = (path: string) => fetch(baseUrl + path, { method: 'DELETE' });

describe('服务台管理（requireConfigRole 门禁）', () => {
  it('GET 列表 200 且返回 items', async () => {
    h.client = makeClient(deskHandlers()).client;
    const res = await get('/service-desks');
    expect(res.status).toBe(200);
    // P2-3 typecheck：res.json() 返回 unknown，按响应形状显式收窄（下同）
    const body = (await res.json()) as { ok: boolean; items: Array<{ name: string }> };
    expect(body.ok).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].name).toBe('一楼服务台');
  });

  it('admin 建服务台 201 + INSERT 参数断言', async () => {
    const m = makeClient(deskHandlers());
    h.client = m.client;
    const res = await post('/service-desks', { name: '一楼服务台' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { item: { id: string } };
    expect(body.item.id).toBe(DESK);
    const ins = m.calls.find((c) => c.text.startsWith('INSERT INTO service_desk'))!;
    expect(ins.params).toEqual([T, '一楼服务台', null]); // template 缺省 → null
  });

  it('operator 可建（config 角色）201', async () => {
    currentRole = 'operator';
    h.client = makeClient(deskHandlers()).client;
    const res = await post('/service-desks', { name: '二号台', template: 'work_order' });
    expect(res.status).toBe(201);
    currentRole = 'admin';
  });

  it('worker 建服务台 403', async () => {
    currentRole = 'worker';
    h.client = makeClient(deskHandlers()).client;
    const res = await post('/service-desks', { name: '越权台' });
    expect(res.status).toBe(403);
    currentRole = 'admin';
  });

  it('PUT 更新 200；desk 不存在 404', async () => {
    h.client = makeClient(deskHandlers()).client;
    const ok = await put(`/service-desks/${DESK}`, { name: '二楼服务台' });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { item: { name: string } };
    expect(body.item.name).toBe('二楼服务台');

    h.client = makeClient(deskHandlers({ deskExists: false })).client;
    const nf = await put(`/service-desks/${DESK}`, { name: '幽灵台' });
    expect(nf.status).toBe(404);
  });

  it('schema 校验：name 空串 422（zod 错误统一映射）', async () => {
    h.client = makeClient(deskHandlers()).client;
    const res = await post('/service-desks', { name: '' });
    expect(res.status).toBe(422);
  });
});

describe('坐席端点已下线（2026-10-28 决策：取消坐席，只删坐席、服务台保留）', () => {
  // 🔴 这三个断言是「坐席真的没了」的钉子，不是新功能断言。
  //   E2 可验证：只删用例不补断言 ⇒ 删没删干净测不出来（会漏成"端点还在但没人管"）。
  //   只断言 status：本测试 app 未挂 apiGuard 与 /api 兜底 ⇒ 走 Express 默认 HTML 404；
  //   生产挂了 server.ts:255-257 的 JSON 兜底 ⇒ 返回 JSON 404。两侧状态码一致，
  //   因此**只断言 404**，不耦合响应体形态。
  //   ⚠️ 必须带合法 token（currentRole='admin' 由 beforeAll 注入 auth），
  //     否则会先被鉴权拦成 401，断言 404 会假红。
  it('GET /service-desks/:id/agents → 404', async () => {
    h.client = makeClient(deskHandlers()).client;
    const res = await get(`/service-desks/${DESK}/agents`);
    expect(res.status).toBe(404);
  });

  it('POST /service-desks/:id/agents → 404', async () => {
    h.client = makeClient(deskHandlers()).client;
    const res = await post(`/service-desks/${DESK}/agents`, { user_id: 'u-9', name: '坐席九' });
    expect(res.status).toBe(404);
  });

  it('DELETE /service-desks/:id/agents/:agentId → 404', async () => {
    h.client = makeClient(deskHandlers()).client;
    const res = await del(`/service-desks/${DESK}/agents/ag-1`);
    expect(res.status).toBe(404);
  });
});

// 原 describe('服务台人员代报修（POST /tickets）') 的 5 个用例随**代申告下线**一并删除
// （2026-10-28，初一改判）。端点已删，这些用例会 404 无意义。

describe('代报修端点已下线（2026-10-28 初一改判：代申告与坐席同批下线）', () => {
  // 🔴 这是「代申告真的没了」的钉子。只断言 status（本测试 app 未挂 /api 兜底，
  //    走 Express 默认 HTML 404；生产有 server.ts:255-257 的 JSON 兜底 ⇒ 两侧状态码一致）。
  it('POST /tickets → 404', async () => {
    h.client = makeClient(deskHandlers()).client;
    const res = await post('/tickets', {
      deskId: DESK,
      callerName: '张三',
      catalog: '维修',
      description: '空调不制冷',
    });
    expect(res.status).toBe(404);
  });
});

describe('T8 第十一批 · 服务台配置权限收敛', () => {
  // A 组：等价性。原 requireConfigRole 白名单 admin+operator ⇒ worker 必须继续 403。
  // 改前改后都应绿（这是"行为不变"的钉子，不是新功能断言）。
  // 🔴 2026-10-28 坐席下线：原 POST/DELETE agents 两条断言随端点删除移除，
  //    本组只剩 PUT /service-desks/:id（worker 仍须 403）。等价性判据不变。
  it('A 组：worker 对 PUT /service-desks/:id 仍 403', async () => {
    currentRole = 'worker';
    h.client = makeClient(deskHandlers()).client;
    expect((await put(`/service-desks/${DESK}`, { name: '越权台' })).status).toBe(403);
    currentRole = 'admin';
  });

  // B 组：这就是收敛的全部价值 —— requireConfigRole 只读角色白名单、根本不查权限表，
  // ⇒ 租户把 servicedesk.manage 授给 reviewer 也放不了行。改前这条必红（403），改后绿。
  // 🔴 2026-10-28 坐席下线：守卫面由 4 处缩为 2 处（POST/PUT /service-desks），
  //    故标题与断言同步收敛；若端点被误删，这两条会立刻变红。
  it('B 组（prod · reviewer）授 servicedesk.manage ⇒ 2 处配置端点全放行', async () => {
    currentRole = 'reviewer';
    const grant = ['servicedesk.manage'];
    h.client = makeClient(deskHandlers({ permGrant: grant })).client;
    expect((await post('/service-desks', { name: '三号台' })).status).toBe(201);
    expect((await put(`/service-desks/${DESK}`, { name: '四号台' })).status).toBe(200);
    currentRole = 'admin';
  });
});
