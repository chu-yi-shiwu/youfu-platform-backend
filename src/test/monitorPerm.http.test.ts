// monitorPerm.http.test.ts —— monitor.ts 5 处写端点的**权限行为**特征测试（T8 第五批）
//
// 【为什么补这份】
//   monitor.ts 此前**零专属测试**（src/test/ 与 src/routes/ 两处都搜过，无 monitor*.test.ts），
//   5 处写端点的权限行为零覆盖。没有特征测试就换守卫 = 盲改，违反 E2。
//   ⇒ 本文件先把现状钉死，再改实现；改完分布不变 = 零行为变更。
//
// 【为什么拆两个权限点】5 处天然分两类，与 emergency 同构：
//   monitor.manage = 监控设备台账 CRUD（POST / PUT /devices 2 处）——配置面
//   monitor.handle = 告警处置（设备告警上报 / resolve / convert 3 处）——执行面
//   照 inspect.manage / inspect.execute、emergency.manage / emergency.handle 的既有先例。
//
// 【两组用例，性质不同（别混读）】
//   A 组「等价性」：worker/reviewer → 403，operator → 放行。**改前改后都必须绿**。
//   B 组「可配置收益」：显式授权后应放行。**改前必红**（requireConfigRole 根本不查权限表）；
//     其中⑥是「两点不串味」的结构性断言——改前也绿，价值在于钉住拆分，有人并回一点会立刻红。
//
// 【为什么用 prod 不用 dev】requirePermission 在 dev 模式恒放行（role.ts:396），dev 下断言等于恒绿。

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const TENANT = 't-mon';
let authRole = 'operator';
let authMode: 'dev' | 'prod' = 'prod';
let permRows: any[] = [];

const fakeClient = {
  query: vi.fn(async (text: unknown, _params?: unknown[]) => {
    const sql = String(text);
    if (sql.includes('SELECT perm FROM role_permission')) return { rows: permRows, rowCount: permRows.length };
    // —— 写操作通用桩：只钉权限，不钉业务 ——
    if (sql.includes('INSERT INTO')) return { rows: [{ id: 'new-1' }], rowCount: 1 };
    if (sql.includes('UPDATE ')) return { rows: [{ id: 'x-1' }], rowCount: 1 };
    if (sql.includes('DELETE FROM')) return { rows: [], rowCount: 1 };
    if (sql.includes('SELECT')) return { rows: [{ id: 'x-1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
};

vi.mock('../db/pool.js', () => ({
  default: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  withTenantClient: async (_tid: string, fn: (c: unknown) => unknown) => fn(fakeClient),
  assertSafeTenantId: (t: string) => t,
}));
// 业务副作用桩：本文件只钉权限，不钉事件 / 工单
vi.mock('../db/eventBus.js', () => ({ emitDomainEvent: vi.fn(async () => undefined) }));
vi.mock('../services/linkedWorkOrder.js', () => ({
  createLinkedWorkOrder: vi.fn(async () => ({ id: 'wo-1', code: 'WO-1' })),
}));

import monitorRouter from '../routes/monitor.js';
import { errorMiddleware } from '../middleware/error.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((_req, res, next) => {
  res.locals.auth = {
    tenantId: TENANT,
    role: authRole,
    userId: 'acct-1',
    username: 'u1',
    requestId: 'r-1',
    authMode,
  };
  next();
});
app.use('/api/v1/monitor', monitorRouter); // 与 server.ts:192 一致（前缀挂在 server 侧）
app.use(errorMiddleware);

let server: Server;
let base = '';
beforeAll(async () => {
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  authRole = 'operator';
  authMode = 'prod';
  permRows = [];
  fakeClient.query.mockClear();
});

const req = (method: string, p: string, body?: unknown) =>
  fetch(base + p, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

/** 5 处写端点（monitor.ts 原 requireConfigRole 全部调用点），入参按各端点 zod schema 给足。 */
const WRITE_ENDPOINTS: Array<{ name: string; method: string; path: string; body?: unknown }> = [
  { name: 'POST /devices', method: 'POST', path: '/api/v1/monitor/devices', body: { name: '设备A' } },
  { name: 'PUT /devices/:id', method: 'PUT', path: '/api/v1/monitor/devices/d-1', body: { status: 'offline' } },
  { name: 'POST /devices/:id/alert', method: 'POST', path: '/api/v1/monitor/devices/d-1/alert', body: { message: '告警A' } },
  { name: 'POST /alerts/:id/resolve', method: 'POST', path: '/api/v1/monitor/alerts/a-1/resolve' },
  { name: 'POST /alerts/:id/convert', method: 'POST', path: '/api/v1/monitor/alerts/a-1/convert' },
];

describe('monitor.ts · 写端点权限（A 组：等价性，改前改后都必须绿）', () => {
  it('①5 处写端点：operator → 放行（2xx）；worker → 403', async () => {
    for (const e of WRITE_ENDPOINTS) {
      authRole = 'operator';
      const ok = await req(e.method, e.path, e.body);
      expect(ok.status, `${e.name} operator 应放行`).toBeGreaterThanOrEqual(200);
      expect(ok.status, `${e.name} operator 应放行`).toBeLessThan(300);

      authRole = 'worker';
      const denied = await req(e.method, e.path, e.body);
      expect(denied.status, `${e.name} worker 应 403`).toBe(403);
    }
  });

  it('②5 处写端点：reviewer（非配置角色）→ 403', async () => {
    authRole = 'reviewer';
    for (const e of WRITE_ENDPOINTS) {
      const r = await req(e.method, e.path, e.body);
      expect(r.status, `${e.name} reviewer 应 403`).toBe(403);
    }
  });

  it('③只读端点不收口：GET /devices 与 GET /alerts 对 worker 仍 200', async () => {
    authRole = 'worker';
    const a = await req('GET', '/api/v1/monitor/devices');
    const b = await req('GET', '/api/v1/monitor/alerts');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

describe('monitor.ts · 可配置收益（B 组：改前必红，改后转绿）', () => {
  it('④租户把 monitor.manage 授予 reviewer 后，reviewer 应能改监控设备台账', async () => {
    authRole = 'reviewer';
    permRows = [{ perm: 'monitor.manage' }];
    const r = await req('POST', '/api/v1/monitor/devices', { name: '设备A' });
    // 改前：requireConfigRole 是 admin/operator 角色白名单，**根本不查权限表** ⇒ 403（RED）；改后转绿。
    expect(r.status).toBeLessThan(300);
  });

  it('⑤租户把 monitor.handle 授予 reviewer 后，reviewer 应能处置告警', async () => {
    authRole = 'reviewer';
    permRows = [{ perm: 'monitor.handle' }];
    const r = await req('POST', '/api/v1/monitor/alerts/a-1/resolve');
    expect(r.status).toBeLessThan(300);
  });

  it('⑥两个权限点互不串味：只授 monitor.manage 时，处置告警仍 403', async () => {
    authRole = 'reviewer';
    permRows = [{ perm: 'monitor.manage' }]; // 只给配置面，不给执行面
    const r = await req('POST', '/api/v1/monitor/alerts/a-1/resolve');
    // 这条改前也绿（改前一律 403）——它的价值不是红转绿，而是**钉住拆分不串味**：
    // 若哪天有人把 5 处并回一个权限点，这条会立刻变红。
    expect(r.status).toBe(403);
  });
});
