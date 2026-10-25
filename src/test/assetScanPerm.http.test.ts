// assetScanPerm.http.test.ts —— `asset.scan` 权限点的**行为**特征测试（T8 回归审查 D 批）
//
// 【为什么必须新建这个文件】
//   T8 回归审查（2026-10-25）实测：`asset.scan` 唯一调用点（`routes/workOrder.ts:1017`
//   POST /scan）**无任何 403 断言**。既有的 `scan.test.ts` 是 `resolveScan` 的**纯函数单测**，
//   从不 mount 路由 ⇒ 守卫删掉、defaults 改掉，全量套件照样全绿。
//   属「权限分支零覆盖 ⇒ 新增测试文件」的必要例外。
//
// 【为什么不能扩在 workOrderMasterVisibility.http.test.ts 里】
//   那个文件的 mock 兜底是 `{ rows: [], rowCount: 1 }`，而 `hasPerm` 是按 **rowCount**
//   判定"有没有覆盖行"（骨架 §2.3 坑四）⇒ 任何非 admin 角色都会被判成"有覆盖行但没这一条"
//   ⇒ 恒 403，测不出真实默认矩阵。本文件单独按 `rowCount = rows.length` 兜底。
//
// 【为什么用 prod 不用 dev】
//   requirePermission 在 dev 恒放行（role.ts:509）⇒ dev 下写 403 断言是恒绿的假绿。
//
// 【这个点的放行面】defaults = ['operator','dispatcher','worker'] ⇒ 一线都能扫码，
//   reviewer / service_desk 默认不行（他们是审核/接线岗，不下一线）。

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const TENANT = 't-assetscan';
let authRole = 'worker';
let authMode: 'dev' | 'prod' = 'prod';
let permRows: any[] = [];

const calls: string[] = [];
const fakeClient = {
  query: vi.fn(async (text: unknown, _params?: unknown[]) => {
    const sql = String(text);
    calls.push(sql);
    if (sql.includes('SELECT perm FROM role_permission')) return { rows: permRows, rowCount: permRows.length };
    return { rows: [], rowCount: 0 };
  }),
};

vi.mock('../db/pool.js', () => ({
  default: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  withTenantClient: async (_tid: string, fn: (c: unknown) => unknown) => fn(fakeClient),
  assertSafeTenantId: (t: string) => t,
}));

import workOrderRouter from '../routes/workOrder.js';
import { errorMiddleware } from '../middleware/error.js';

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((_req, res, next) => {
    res.locals.auth = { tenantId: TENANT, role: authRole, userId: 'acct-1', username: 'u1', requestId: 'r-1', authMode };
    next();
  });
  app.use('/api/v1', workOrderRouter); // 与 server.ts 挂载一致
  app.use(errorMiddleware);
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  authRole = 'worker';
  authMode = 'prod';
  permRows = [];
  calls.length = 0;
  fakeClient.query.mockClear();
});

const scan = (role: string, rows: any[], body: unknown = { raw: 'AST-3F-AIRCON-01' }) => {
  authRole = role;
  permRows = rows;
  return fetch(`${base}/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

// A 组「等价性」：钉住 defaults=['operator','dispatcher','worker'] 的放行面。
describe('asset.scan · A 组：等价性（一线可扫，审核/接线岗默认不可）', () => {
  it('①worker / operator / dispatcher → 放行；reviewer / service_desk → 403', async () => {
    expect((await scan('worker', [])).status).toBe(200);
    expect((await scan('operator', [])).status).toBe(200);
    expect((await scan('dispatcher', [])).status).toBe(200);
    expect((await scan('reviewer', [])).status).toBe(403);
    expect((await scan('service_desk', [])).status).toBe(403);
  });

  it('②403 确实来自权限表比对：reviewer 被拦时也走了 SELECT perm FROM role_permission', async () => {
    const r = await scan('reviewer', []);
    expect(r.status).toBe(403);
    expect(calls.some((s) => s.includes('SELECT perm FROM role_permission'))).toBe(true);
  });
});

// B 组「可配置收益」：租户显式授予后应放行（证明不是写死角色）。
describe('asset.scan · B 组：可配置收益（授了权就得放行）', () => {
  it('③授 asset.scan 给 reviewer ⇒ 放行', async () => {
    const before = await scan('reviewer', []);
    expect(before.status).toBe(403);
    const after = await scan('reviewer', [{ perm: 'asset.scan' }]);
    expect(after.status).toBe(200);
  });

  it('④反例锚：授的是别家权限点（asset.manage）⇒ 仍 403', async () => {
    const r = await scan('reviewer', [{ perm: 'asset.manage' }]);
    expect(r.status).toBe(403);
  });
});

// C 组「顺序」：zod 校验在守卫之前 —— 钉住顺序不被后续改造改坏。
describe('asset.scan · C 组：守卫与相邻校验的先后顺序', () => {
  it('⑤zod body 校验先于守卫：reviewer 传空 raw ⇒ 422（不是 403）', async () => {
    const r = await scan('reviewer', [], { raw: '' });
    expect(r.status).toBe(422);
  });
});
