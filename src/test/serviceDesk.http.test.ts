// serviceDesk.http.test.ts —— 服务台 + 来电弹屏代申告 真·HTTP 层测试（补 #229 查证发现的测试盲区）。
//
// 覆盖五类行为：
//   ① 服务台 CRUD：admin/operator 可写（requireConfigRole）、worker 403、404 语义
//   ② 客服人员管理：desk 存在性校验、ON CONFLICT DO UPDATE（重复添加即改名）、删除 404
//   ③ 代申告建单（POST /tickets）：dto 映射断言（title/contact/businessType/priority）+
//      幂等键 svcdesk:{deskId}:{sessionId} 抢键先行（INSERT idempotency_key 先于 INSERT work_orders）
//   ④ 代申告双击防重：第二次抢键冲突 → 回查复用既有单（created=false 仍 201、id 一致）
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
const AGENT_ROW = { id: 'ag-1', tenant_id: T, desk_id: DESK, user_id: 'u-9', name: '坐席九' };
const DESK_ROW = { id: DESK, tenant_id: T, name: '一楼服务台', template: null, created_at: '2026-09-01T00:00:00Z' };

function deskHandlers(opts: { deskExists?: boolean; idemGrabbed?: boolean; existingWo?: Record<string, unknown> | null } = {}): Handler[] {
  const deskExists = opts.deskExists ?? true;
  const idemGrabbed = opts.idemGrabbed ?? true;
  return [
    // 服务台列表 / 新建
    { match: (t) => t.includes('FROM service_desk WHERE tenant_id=$1 ORDER BY created_at'), reply: () => ({ rows: [DESK_ROW] }) },
    { match: (t) => t.startsWith('INSERT INTO service_desk'), reply: () => ({ rows: [DESK_ROW], rowCount: 1 }) },
    // PUT：先查当前行
    { match: (t) => t.includes('SELECT * FROM service_desk WHERE id=$1 AND tenant_id=$2'), reply: () => (deskExists ? { rows: [DESK_ROW], rowCount: 1 } : { rows: [], rowCount: 0 }) },
    { match: (t) => t.includes('UPDATE service_desk SET name=COALESCE'), reply: () => ({ rows: [{ ...DESK_ROW, name: '二楼服务台' }], rowCount: 1 }) },
    // 代申告 / agents POST 的 desk 存在性校验（SELECT id FROM ...）
    { match: (t) => t.includes('SELECT id FROM service_desk WHERE id=$1 AND tenant_id=$2'), reply: () => (deskExists ? { rows: [{ id: DESK }], rowCount: 1 } : { rows: [], rowCount: 0 }) },
    // 客服人员
    { match: (t) => t.includes('FROM service_desk_agent WHERE tenant_id=$1 AND desk_id=$2 ORDER BY created_at'), reply: () => ({ rows: [AGENT_ROW] }) },
    { match: (t) => t.includes('INSERT INTO service_desk_agent'), reply: () => ({ rows: [AGENT_ROW], rowCount: 1 }) },
    { match: (t) => t.startsWith('DELETE FROM service_desk_agent'), reply: () => ({ rows: [], rowCount: 1 }) },
    // 幂等抢键（R1-001 零 DDL 串行化）
    { match: (t) => t.includes('INSERT INTO idempotency_key'), reply: () => ({ rows: [], rowCount: idemGrabbed ? 1 : 0 }) },
    { match: (t) => t.includes('SELECT work_order_id FROM idempotency_key WHERE key = $1'), reply: () => (opts.existingWo ? { rows: [{ work_order_id: opts.existingWo.id as string }] } : { rows: [] }) },
    // findOne 回查既有单
    { match: (t) => t.includes('SELECT * FROM work_orders WHERE id = $1 AND tenant_id = $2'), reply: () => ({ rows: opts.existingWo ? [opts.existingWo] : [] }) },
    // 建单 INSERT
    { match: (t) => t.startsWith('INSERT INTO work_orders'), reply: (_t, p) => ({ rows: [{ id: p[0], tenant_id: p[1], order_no: p[2], business_type: p[3], title: p[7], status: 'draft' }], rowCount: 1 }) },
    // hasPerm 覆盖查询（operator/service_desk 角色走查库路径）
    { match: (t) => t.includes('SELECT perm FROM role_permission WHERE tenant_id = $1 AND role = $2'), reply: () => ({ rows: [{ perm: 'settlement.edit' }] }) },
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
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].name).toBe('一楼服务台');
  });

  it('admin 建服务台 201 + INSERT 参数断言', async () => {
    const m = makeClient(deskHandlers());
    h.client = m.client;
    const res = await post('/service-desks', { name: '一楼服务台' });
    expect(res.status).toBe(201);
    const body = await res.json();
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
    const body = await ok.json();
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

describe('客服人员管理', () => {
  it('添加坐席 201；desk 不存在 404', async () => {
    h.client = makeClient(deskHandlers()).client;
    const ok = await post(`/service-desks/${DESK}/agents`, { user_id: 'u-9', name: '坐席九' });
    expect(ok.status).toBe(201);

    h.client = makeClient(deskHandlers({ deskExists: false })).client;
    const nf = await post(`/service-desks/${DESK}/agents`, { user_id: 'u-9', name: '坐席九' });
    expect(nf.status).toBe(404);
  });

  it('删除坐席 200；不存在 404', async () => {
    h.client = makeClient(deskHandlers()).client;
    const ok = await del(`/service-desks/${DESK}/agents/ag-1`);
    expect(ok.status).toBe(200);

    const m2 = makeClient([
      { match: (t) => t.startsWith('DELETE FROM service_desk_agent'), reply: () => ({ rows: [], rowCount: 0 }) },
    ]);
    h.client = m2.client;
    const nf = await del(`/service-desks/${DESK}/agents/ag-x`);
    expect(nf.status).toBe(404);
  });
});

describe('来电弹屏代申告（POST /tickets）', () => {
  const payload = {
    deskId: DESK,
    callerName: '张三',
    catalog: '维修',
    description: '空调不制冷',
    location: '门诊三楼',
    sessionId: 'sess-001',
  };

  it('建单 201 + dto 映射断言（title/contact/businessType/幂等键抢键先行）', async () => {
    const m = makeClient(deskHandlers());
    h.client = m.client;
    const res = await post('/tickets', payload);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.item.title).toBe('服务台代申告·张三');
    expect(body.item.business_type).toBe('维修');

    // SQL 序列：抢幂等键必须先于 INSERT work_orders（R1-001 零 DDL 串行化）
    const grabIdx = m.calls.findIndex((c) => c.text.includes('INSERT INTO idempotency_key'));
    const insIdx = m.calls.findIndex((c) => c.text.startsWith('INSERT INTO work_orders'));
    expect(grabIdx).toBeGreaterThanOrEqual(0);
    expect(insIdx).toBeGreaterThan(grabIdx);

    // 幂等键形态：svcdesk:{deskId}:{sessionId}
    const grab = m.calls[grabIdx];
    expect(grab.params![0]).toBe(`svcdesk:${DESK}:sess-001`);
    expect(grab.params![1]).toBe(T);

    // INSERT work_orders 映射：businessType=catalog、contact=callerName、priority=normal、title 前缀
    const ins = m.calls[insIdx];
    expect(ins.params![3]).toBe('维修'); // business_type
    expect(ins.params![4]).toBe('维修'); // catalog
    expect(ins.params![5]).toBe('normal'); // priority
    expect(ins.params![6]).toBe('门诊三楼'); // location
    expect(ins.params![7]).toBe('服务台代申告·张三'); // title
    expect(ins.params![9]).toBe('张三'); // contact
    expect(ins.params![12]).toBe('backend'); // source
  });

  it('无 sessionId 时不写幂等键直接建单', async () => {
    const m = makeClient(deskHandlers());
    h.client = m.client;
    const res = await post('/tickets', { ...payload, sessionId: undefined });
    expect(res.status).toBe(201);
    expect(m.calls.some((c) => c.text.includes('INSERT INTO idempotency_key'))).toBe(false);
  });

  it('双击防重：第二次抢键冲突 → 回查复用既有单，仍 201 且 id 一致', async () => {
    const existing = { id: 'wo-existing-1', tenant_id: T, order_no: 'WO_1', status: 'draft' };
    h.client = makeClient(deskHandlers({ idemGrabbed: false, existingWo: existing })).client;
    const res = await post('/tickets', payload);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.item.id).toBe('wo-existing-1'); // 复用既有单而非新建
    expect(body.item.order_no).toBe('WO_1');
  });

  it('deskId 非 uuid → 422；desk 不存在 → 404', async () => {
    h.client = makeClient(deskHandlers()).client;
    const bad = await post('/tickets', { ...payload, deskId: 'not-a-uuid' });
    expect(bad.status).toBe(422);

    h.client = makeClient(deskHandlers({ deskExists: false })).client;
    const nf = await post('/tickets', payload);
    expect(nf.status).toBe(404);
  });

  it('角色权限覆盖存在但不含 intake.create → 403（R35 接线）', async () => {
    currentRole = 'service_desk'; // 非 admin → 走 role_permission 查库路径
    h.client = makeClient(deskHandlers()).client; // mock 返回覆盖集 {settlement.edit}，不含 intake.create
    const res = await post('/tickets', payload);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.message).toContain('intake.create');
    currentRole = 'admin';
  });
});
