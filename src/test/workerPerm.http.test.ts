// workerPerm.http.test.ts —— worker.ts 4 处写端点的**权限行为**特征测试（T8 第六批）
//
// 【为什么补这份】
//   worker.ts 虽已有 workerWithAccount.test.ts / workerLoadDrift.test.ts，但它们**不覆盖权限**：
//   workerWithAccount.test.ts 用的是 `authMode:'dev'` + `role:'admin'`（dev 下 requirePermission
//   恒放行），断言的是业务消息（"该租户下用户名已存在"/"该工号已存在"），**没有一条 403 断言**。
//   ⇒ 换守卫前没有特征可依，盲改违反 E2。本文件先把现状钉死，改完分布不变 = 零行为变更。
//
// 【为什么只用一个权限点】4 处全是「人员主数据维护」：档案 CRUD 3 处 + 一键入驻（建账号+档案）1 处。
//   没有配置面/执行面之分（不像 inspection / emergency / monitor 那样要拆 manage + handle），
//   故不拆 —— 避免过度拆分。命名 `worker.manage`（label 人员档案）避免被误读成「worker 角色的权限」。
//
// 【两组用例】
//   A 组「等价性」：worker/reviewer → 403，operator → 放行。**改前改后都必须绿**。
//   B 组「可配置收益」：给 reviewer 授 worker.manage 后应放行。**改前必红**。
//
// 【canAssignRole 那层不用管】POST /workers/with-account 在守卫之后还有一层
//   canAssignRole(auth.role,'worker')（事务外同步）。worker.ts:180 的注释自己写明
//   「当前矩阵恒真」（ROLE_RANK.worker=1 最低，所有角色 rank 均 ≥1）⇒ 它不会真的 403，
//   守卫移入事务内造成的顺序反转不会改变实际行为。本文件不断言它。
//
// 【为什么用 prod 不用 dev】requirePermission 在 dev 恒放行（role.ts:396），dev 下断言等于恒绿。

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const TENANT = 't-worker';
let authRole = 'operator';
let authMode: 'dev' | 'prod' = 'prod';
let permRows: any[] = [];

const fakeClient = {
  query: vi.fn(async (text: unknown, _params?: unknown[]) => {
    const sql = String(text);
    if (sql.includes('SELECT perm FROM role_permission')) return { rows: permRows, rowCount: permRows.length };
    // 查重 / 在途工单检查：`SELECT 1 FROM ...` 必须返回空 ⇒ 否则走不到权限判定后的业务逻辑
    if (sql.includes('SELECT 1 FROM')) return { rows: [], rowCount: 0 };
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
// DELETE /workers/:id 会取流程定义算「在途态」，给个空 states 让它不炸（本文件不钉这层业务）
// 批 5：删人守卫改走「各版本名单」⇒ 桩必须补上新导出，否则模块里取不到会 500。
//   这里只有一份 def（单版本桩）⇒ 并集/交集结果都等于它自己，与改造前逐字节等价。
vi.mock('../engine/workflowDef.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const stubDef = { id: 'd1', entityType: 'work_order', states: [], transitions: [] };
  return {
    ...actual,
    getWorkflowDef: vi.fn(async () => stubDef),
    getDefsAcrossAllVersions: vi.fn(async () => [stubDef]),
  };
});
vi.mock('../db/eventBus.js', () => ({ emitDomainEvent: vi.fn(async () => undefined) }));

import workerRouter from '../routes/worker.js';
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
app.use('/api/v1', workerRouter); // 与 server.ts:201 一致（workerRouter 自带 /workers 前缀）
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

/** 4 处写端点（worker.ts 原 requireConfigRole 全部调用点），入参按各端点 zod schema 给足。 */
const WRITE_ENDPOINTS: Array<{ name: string; method: string; path: string; body?: unknown }> = [
  { name: 'POST /workers', method: 'POST', path: '/api/v1/workers', body: { id: 'W001', name: '张三' } },
  { name: 'PUT /workers/:id', method: 'PUT', path: '/api/v1/workers/W001', body: { name: '张三2' } },
  { name: 'DELETE /workers/:id', method: 'DELETE', path: '/api/v1/workers/W001' },
  {
    name: 'POST /workers/with-account',
    method: 'POST',
    path: '/api/v1/workers/with-account',
    body: { username: 'zhangsan', display_name: '张三' },
  },
];

describe('worker.ts · 写端点权限（A 组：等价性，改前改后都必须绿）', () => {
  it('①4 处写端点：operator → 放行（2xx）；worker → 403', async () => {
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

  it('②4 处写端点：reviewer（非配置角色）→ 403', async () => {
    authRole = 'reviewer';
    for (const e of WRITE_ENDPOINTS) {
      const r = await req(e.method, e.path, e.body);
      expect(r.status, `${e.name} reviewer 应 403`).toBe(403);
    }
  });

  it('③只读端点不收口：GET /workers 与 GET /workers/:id 对 worker 仍 200', async () => {
    authRole = 'worker';
    const a = await req('GET', '/api/v1/workers');
    const b = await req('GET', '/api/v1/workers/W001');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

describe('worker.ts · 可配置收益（B 组：改前必红，改后转绿）', () => {
  it('④租户把 worker.manage 授予 reviewer 后，reviewer 应能建人员档案', async () => {
    authRole = 'reviewer';
    permRows = [{ perm: 'worker.manage' }];
    const r = await req('POST', '/api/v1/workers', { id: 'W001', name: '张三' });
    // 改前：requireConfigRole 是 admin/operator 角色白名单，**根本不查权限表** ⇒ 403（RED）；改后转绿。
    expect(r.status).toBeLessThan(300);
  });
});
