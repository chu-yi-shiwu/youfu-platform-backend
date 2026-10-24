// dictPerm.http.test.ts —— 字典类主数据（catalog / faultCategory）6 处写端点的**权限行为**特征测试（T8 第八批）
//
// 【为什么补这份】
//   两个文件此前**没有任何专属测试**（全仓搜 catalog / fault-category 均无权限断言），
//   只有间接覆盖（报修建单等端到端用例里顺带读到目录数据）。换守卫前没有特征可依，盲改违反 E2。
//   本文件先把现状钉死，改完分布不变 = 零行为变更。
//
// 【为什么复用 basicdata.edit、不新增权限点】（与批 3 equipment「独立模块→独立点」并不矛盾）
//   产品目录 / 故障分类是**字典类主数据**，不是独立运维模块。同仓已有两个先例把它们归到
//   「基础数据」：config.ts 的术语/派单规则（批 2），以及 metaTenantLabel.ts:16-17 注释明写
//   「展示标签字典归属「基础数据」」。⇒ 本批沿用同一判据，零新增权限点。
//   basicdata.edit defaults = ['operator']，admin 全通配 ⇒ 与原 admin+operator 白名单天然等价。
//
// 【为什么这两个文件放在同一批】完全同构：同为字典 CRUD（POST/PUT/DELETE）、同为
//   requireConfigRole 3 处、风格互相对齐（faultCategory.ts:2 注释即写"风格对齐 catalog.ts"）、
//   同一个权限点、同一条判据 ⇒ 属**同一类变更**，分开做只是重复劳动。
//
// 【两组用例】
//   A 组「等价性」：worker/reviewer → 403，operator → 放行。**改前改后都必须绿**。
//   B 组「可配置收益」：给 reviewer 授 basicdata.edit 后应放行。**改前必红**。
//
// 【为什么用 prod 不用 dev】requirePermission 在 dev 恒放行（role.ts:396），dev 下断言等于恒绿。

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const TENANT = 't-dict';
let authRole = 'operator';
let authMode: 'dev' | 'prod' = 'prod';
let permRows: any[] = [];

const fakeClient = {
  query: vi.fn(async (text: unknown, _params?: unknown[]) => {
    const sql = String(text);
    if (sql.includes('SELECT perm FROM role_permission')) return { rows: permRows, rowCount: permRows.length };
    // PUT 会先 SELECT 存在性，rowCount=0 会走 404 ⇒ 必须返回命中，否则测的是 404 不是权限
    if (sql.includes('SELECT')) return { rows: [{ id: 'x-1' }], rowCount: 1 };
    if (sql.includes('INSERT INTO')) return { rows: [{ id: 'new-1' }], rowCount: 1 };
    if (sql.includes('UPDATE ')) return { rows: [{ id: 'x-1' }], rowCount: 1 };
    // DELETE 返回 rowCount 0 会被端点转成 404 ⇒ 给 1 才能测到"权限放行"本身
    if (sql.includes('DELETE FROM')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
};

vi.mock('../db/pool.js', () => ({
  default: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  withTenantClient: async (_tid: string, fn: (c: unknown) => unknown) => fn(fakeClient),
  assertSafeTenantId: (t: string) => t,
}));

import catalogRouter from '../routes/catalog.js';
import faultCategoryRouter from '../routes/faultCategory.js';
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
// 两个 router 都挂在 /api/v1（server.ts:202 / :203），各自带资源前缀
app.use('/api/v1', catalogRouter);
app.use('/api/v1', faultCategoryRouter);
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

/** 6 处写端点（catalog.ts 3 处 + faultCategory.ts 3 处，原 requireConfigRole 全部调用点）。
 *  body 按各端点 zod schema 给足——catalog 必填 code/name，faultCategory 必填 code/name。 */
const WRITE_ENDPOINTS: Array<{ name: string; method: string; path: string; body?: unknown }> = [
  {
    name: 'POST /product-catalog',
    method: 'POST',
    path: '/api/v1/product-catalog',
    body: { code: 'C001', name: '商品A' },
  },
  { name: 'PUT /product-catalog/:id', method: 'PUT', path: '/api/v1/product-catalog/x-1', body: { name: '商品A2' } },
  { name: 'DELETE /product-catalog/:id', method: 'DELETE', path: '/api/v1/product-catalog/x-1' },
  {
    name: 'POST /fault-categories',
    method: 'POST',
    path: '/api/v1/fault-categories',
    body: { code: 'F001', name: '故障A' },
  },
  { name: 'PUT /fault-categories/:id', method: 'PUT', path: '/api/v1/fault-categories/x-1', body: { name: '故障A2' } },
  { name: 'DELETE /fault-categories/:id', method: 'DELETE', path: '/api/v1/fault-categories/x-1' },
];

describe('字典类主数据 · 写端点权限（A 组：等价性，改前改后都必须绿）', () => {
  it('①6 处写端点：operator → 放行（2xx）；worker → 403', async () => {
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

  it('②6 处写端点：reviewer（非配置角色）→ 403', async () => {
    authRole = 'reviewer';
    for (const e of WRITE_ENDPOINTS) {
      const r = await req(e.method, e.path, e.body);
      expect(r.status, `${e.name} reviewer 应 403`).toBe(403);
    }
  });

  it('③只读端点不收口：两个列表 GET 对 worker 仍 200', async () => {
    authRole = 'worker';
    const a = await req('GET', '/api/v1/product-catalog');
    const b = await req('GET', '/api/v1/fault-categories');
    expect(a.status, 'GET /product-catalog 对 worker 应仍 200').toBe(200);
    expect(b.status, 'GET /fault-categories 对 worker 应仍 200').toBe(200);
  });
});

describe('字典类主数据 · 可配置收益（B 组：改前必红，改后转绿）', () => {
  it('④租户把 basicdata.edit 授予 reviewer 后，reviewer 应能维护字典（两个模块都放行）', async () => {
    authRole = 'reviewer';
    permRows = [{ perm: 'basicdata.edit' }];
    for (const e of WRITE_ENDPOINTS) {
      const r = await req(e.method, e.path, e.body);
      // 改前：requireConfigRole 是 admin/operator 角色白名单，**根本不查权限表** ⇒ 403（RED）；改后转绿。
      expect(r.status, `${e.name} 授权后应放行`).toBeLessThan(300);
    }
  });
});
