// equipmentPerm.http.test.ts —— equipment.ts 8 处写端点的**权限行为**特征测试（T8 第三批）
//
// 【为什么补这份】
//   equipment.ts 的 8 处写端点**权限行为零覆盖**。注意：仓库里确实已有
//   src/routes/equipment.test.ts，但它只测纯函数 resolveInsertColumns（F1/F2 回归），
//   无一条 403 / 角色断言 ⇒ 换守卫前无可依据的特征，盲改违反 E2。
//   ⚠️ 教训：本仓测试文件**不全在 src/test/ 下**，src/routes/*.test.ts 同样存在
//     （本次排查先只搜了 src/test/ 就误判为「零专属测试」）⇒ 查覆盖度两处都要搜。
//   ⇒ 本文件先把现状钉死，再改实现；改完分布不变 = 零行为变更。
//
// 【两组用例，性质不同（别混读）】
//   A 组「等价性」：worker/reviewer → 403，operator → 放行。**改前改后都必须绿**，
//     红了就说明收敛破坏了既有行为。
//   B 组「可配置收益」：给 reviewer 显式授予 equipment.manage 后应放行。
//     **改前必红**（requireConfigRole 是角色白名单，根本不看权限表，授了也没用）；
//     改后转绿 ⇒ 这红→绿就是本次收敛的**全部价值**：设备端点终于可由租户授权了。
//
// 【为什么用 prod 不用 dev】
//   requirePermission 在 dev 模式恒放行（role.ts:396），用 dev 跑权限断言等于恒绿。
//   同 inspection.http.test.ts / configPerm.http.test.ts 的做法，一律 authMode='prod'。

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const TENANT = 't-equip';
let authRole = 'operator';
let authMode: 'dev' | 'prod' = 'prod';
let permRows: any[] = [];

const fakeClient = {
  query: vi.fn(async (text: unknown, _params?: unknown[]) => {
    const sql = String(text);
    // —— 权限守卫：role_permission 覆盖行（默认空 ⇒ 回退默认矩阵）——
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

import equipmentRouter from '../routes/equipment.js';
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
app.use('/api/v1', equipmentRouter); // 与 server.ts:214 一致（equipmentRouter 自带 /equipment 前缀）
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

/** 8 处写端点（equipment.ts 原 requireConfigRole 全部调用点），入参按各端点 zod schema 给足。 */
const WRITE_ENDPOINTS: Array<{ name: string; method: string; path: string; body?: unknown }> = [
  { name: 'POST /equipment/:eqId/maintenances', method: 'POST', path: '/api/v1/equipment/eq-1/maintenances', body: { mtype: 'maintain' } },
  { name: 'PUT /equipment/maintenances/:id', method: 'PUT', path: '/api/v1/equipment/maintenances/m-1', body: { note: '备注' } },
  { name: 'DELETE /equipment/maintenances/:id', method: 'DELETE', path: '/api/v1/equipment/maintenances/m-1' },
  { name: 'POST /equipment/equipment', method: 'POST', path: '/api/v1/equipment/equipment', body: { name: '设备A' } },
  { name: 'PUT /equipment/equipment/:id', method: 'PUT', path: '/api/v1/equipment/equipment/e-1', body: { name: '设备A2' } },
  { name: 'DELETE /equipment/equipment/:id', method: 'DELETE', path: '/api/v1/equipment/equipment/e-1' },
  { name: 'GET /equipment/equipment/export', method: 'GET', path: '/api/v1/equipment/equipment/export' },
  { name: 'POST /equipment/equipment/import', method: 'POST', path: '/api/v1/equipment/equipment/import', body: { csv: 'name\n设备A\n' } },
];

describe('equipment.ts · 写端点权限（A 组：等价性，改前改后都必须绿）', () => {
  it('①8 处写端点：operator → 放行（2xx）；worker → 403', async () => {
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

  it('②8 处写端点：reviewer（非配置角色）→ 403', async () => {
    authRole = 'reviewer';
    for (const e of WRITE_ENDPOINTS) {
      const r = await req(e.method, e.path, e.body);
      expect(r.status, `${e.name} reviewer 应 403`).toBe(403);
    }
  });

  it('③只读端点不收口：GET /equipment/:type 与 GET /equipment/:eqId/maintenances 对 worker 仍 200', async () => {
    authRole = 'worker';
    const a = await req('GET', '/api/v1/equipment/equipment');
    const b = await req('GET', '/api/v1/equipment/eq-1/maintenances');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

describe('equipment.ts · 可配置收益（B 组：改前必红，改后转绿）', () => {
  it('④租户把 equipment.manage 授予 reviewer 后，reviewer 应能改设备', async () => {
    authRole = 'reviewer';
    permRows = [{ perm: 'equipment.manage' }]; // 租户显式授权（role_permission 覆盖行）
    const r = await req('POST', '/api/v1/equipment/equipment', { name: '设备A' });
    // 改前：requireConfigRole 是 admin/operator 角色白名单，**根本不查权限表**
    //       ⇒ 授了也没用，这里会是 403（RED）。改后走 requirePermission ⇒ 转绿。
    expect(r.status).toBeLessThan(300);
  });
});
