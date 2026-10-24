// emergencyPerm.http.test.ts —— emergency.ts 7 处写端点的**权限行为**特征测试（T8 第四批）
//
// 【为什么补这份】
//   emergency.ts 此前**零专属测试**（src/test/ 与 src/routes/ 两处都搜过，无 emergency*.test.ts），
//   7 处写端点的权限行为零覆盖。没有特征测试就换守卫 = 盲改，违反 E2。
//   ⇒ 本文件先把现状钉死，再改实现；改完分布不变 = 零行为变更。
//
// 【为什么拆两个权限点】7 处天然分两类，不是一回事：
//   emergency.manage = 应急预案库 CRUD（plans 3 处）——配置面，改的是「知识库/目录」
//   emergency.handle = 预警处置（alerts 创建 / 处置 / 关联预案 / 转工单 4 处）——执行面，做的是「处理一条预警」
//   拆开后租户可「只给处置权、不给改预案库权」。照 inspect.manage / inspect.execute 的既有先例。
//   ⚠️ 已知待决（不在本批夹带，E6）：worker 目前**不能处置预警**（等价迁移保留了原行为）。
//      收敛后租户可自行授予 emergency.handle —— 这正是本次收敛的价值所在。
//
// 【两组用例，性质不同（别混读）】
//   A 组「等价性」：worker/reviewer → 403，operator → 放行。**改前改后都必须绿**。
//   B 组「可配置收益」：显式授权后应放行。**改前必红**（requireConfigRole 根本不查权限表）。
//
// 【为什么用 prod 不用 dev】
//   requirePermission 在 dev 模式恒放行（role.ts:396），用 dev 跑权限断言等于恒绿。

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const TENANT = 't-emerg';
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
// 业务副作用桩：本文件只钉权限，不钉落库/事件/工单
vi.mock('../db/eventBus.js', () => ({ emitDomainEvent: vi.fn(async () => undefined) }));
vi.mock('../services/linkedWorkOrder.js', () => ({
  createLinkedWorkOrder: vi.fn(async () => ({ id: 'wo-1', code: 'WO-1' })),
}));

import emergencyRouter from '../routes/emergency.js';
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
app.use('/api/v1/emergency', emergencyRouter); // 与 server.ts:188 一致（前缀挂在 server 侧，router 内是 /plans /alerts）
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

const PLAN_ID = '11111111-1111-4111-8111-111111111111';

/** 7 处写端点（emergency.ts 原 requireConfigRole 全部调用点），入参按各端点 zod schema 给足。 */
const WRITE_ENDPOINTS: Array<{ name: string; method: string; path: string; body?: unknown }> = [
  { name: 'POST /plans', method: 'POST', path: '/api/v1/emergency/plans', body: { title: '预案A' } },
  { name: 'PUT /plans/:id', method: 'PUT', path: '/api/v1/emergency/plans/p-1', body: { title: '预案A2' } },
  { name: 'DELETE /plans/:id', method: 'DELETE', path: '/api/v1/emergency/plans/p-1' },
  {
    name: 'POST /alerts',
    method: 'POST',
    path: '/api/v1/emergency/alerts',
    body: { source_type: 'manual', level: 'L2', title: '预警A' },
  },
  { name: 'POST /alerts/:id/handle', method: 'POST', path: '/api/v1/emergency/alerts/a-1/handle', body: { status: 'handled' } },
  { name: 'POST /alerts/:id/link-plan', method: 'POST', path: '/api/v1/emergency/alerts/a-1/link-plan', body: { plan_id: PLAN_ID } },
  { name: 'POST /alerts/:id/convert', method: 'POST', path: '/api/v1/emergency/alerts/a-1/convert' },
];

describe('emergency.ts · 写端点权限（A 组：等价性，改前改后都必须绿）', () => {
  it('①7 处写端点：operator → 放行（2xx）；worker → 403', async () => {
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

  it('②7 处写端点：reviewer（非配置角色）→ 403', async () => {
    authRole = 'reviewer';
    for (const e of WRITE_ENDPOINTS) {
      const r = await req(e.method, e.path, e.body);
      expect(r.status, `${e.name} reviewer 应 403`).toBe(403);
    }
  });

  it('③只读端点不收口：GET /plans、/plans/:id、/alerts、/alerts/stats 对 worker 仍 200', async () => {
    authRole = 'worker';
    for (const p of ['/plans', '/plans/p-1', '/alerts', '/alerts/stats']) {
      const r = await req('GET', '/api/v1/emergency' + p);
      expect(r.status, `GET ${p} 应仍 200`).toBe(200);
    }
  });
});

describe('emergency.ts · 可配置收益（B 组：改前必红，改后转绿）', () => {
  it('④租户把 emergency.manage 授予 reviewer 后，reviewer 应能改应急预案库', async () => {
    authRole = 'reviewer';
    permRows = [{ perm: 'emergency.manage' }];
    const r = await req('POST', '/api/v1/emergency/plans', { title: '预案A' });
    // 改前：requireConfigRole 是 admin/operator 角色白名单，**根本不查权限表** ⇒ 403（RED）；改后转绿。
    expect(r.status).toBeLessThan(300);
  });

  it('⑤租户把 emergency.handle 授予 reviewer 后，reviewer 应能处置预警', async () => {
    authRole = 'reviewer';
    permRows = [{ perm: 'emergency.handle' }];
    const r = await req('POST', '/api/v1/emergency/alerts/a-1/handle', { status: 'handled' });
    expect(r.status).toBeLessThan(300);
  });

  it('⑥两个权限点互不串味：只授 emergency.manage 时，处置预警仍 403', async () => {
    authRole = 'reviewer';
    permRows = [{ perm: 'emergency.manage' }]; // 只给配置面，不给执行面
    const r = await req('POST', '/api/v1/emergency/alerts/a-1/handle', { status: 'handled' });
    // 这条改前也绿（改前一律 403），它的价值不是红转绿，而是**钉住拆分不串味**：
    // 若哪天有人把 7 处并回一个权限点，这条会立刻变红。
    expect(r.status).toBe(403);
  });
});
