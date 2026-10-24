// aiFeaturesPerm.http.test.ts —— aiPreview.ts I4 灰度总开关（GET/PUT /ai/features）**权限行为**特征测试（T8 第七批）
//
// 【为什么补这份】
//   aiPreview.ts 已有 aiPreview.test.ts，但它覆盖的是 /preview /similar /feedback /agent-stats
//   /gen-config 的**业务逻辑**与「I4 关 → 诚实降级」；对 /features 端点本身**没有任何权限断言**
//   ⇒ 换守卫前没有特征可依，盲改违反 E2。本文件先把现状钉死，改完分布不变 = 零行为变更。
//
// 【这对端点的特殊之处（与前面几批都不同）】
//   **GET /ai/features 是读端点，但原实现带了 requireConfigRole 守卫** —— 因为它是「租户级 AI 能力
//   总开关」的读取，属**管理面配置读取**，不是业务数据读取。小程序侧印证：只有
//   `pages/admin/agents/` 调它（admin 面）。⇒ 本批**等价迁移保留读守卫**，不摘。
//   ⚠️ 因此本文件没有「只读端点不收口」那条断言（前几批 worker/equipment 都有），别照抄。
//
// 【为什么新增 ai.manage 而不复用 basicdata.edit】
//   AI 能力总开关是**独立功能域**（I4 灰度，控制全部新 AI 能力的生杀），与「基础数据」不是一回事；
//   `role.ts:69` 已把"蹭 basicdata.edit"定为淘汰做法。判据沿用批 3（equipment）：
//   独立运维模块 → 独立权限点。
//
// 【两组用例】
//   A 组「等价性」：worker/reviewer → 403，operator → 放行。**改前改后都必须绿**。
//   B 组「可配置收益」：给 reviewer 授 ai.manage 后应放行。**改前必红**。
//
// 【为什么用 prod 不用 dev】requirePermission 在 dev 恒放行（role.ts:396），dev 下断言等于恒绿。

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const TENANT = 't-ai';
let authRole = 'operator';
let authMode: 'dev' | 'prod' = 'prod';
let permRows: any[] = [];
/** 模拟 tenant_settings.settings->>'ai_features_enabled' 的当前值（可被 PUT 改写）。 */
let flag = 'false';

const fakeClient = {
  query: vi.fn(async (text: unknown, params?: unknown[]) => {
    const sql = String(text);
    if (sql.includes('SELECT perm FROM role_permission')) return { rows: permRows, rowCount: permRows.length };
    if (sql.includes("settings->>'ai_features_enabled'")) return { rows: [{ flag }], rowCount: 1 };
    // PUT 的 UPSERT 用 $2::boolean 传目标值 ⇒ 如实按入参改写，别写死 true
    if (sql.includes('INSERT INTO tenant_settings')) {
      flag = String((params ?? [])[1]);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
};

vi.mock('../db/pool.js', () => ({
  default: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  withTenantClient: async (_tid: string, fn: (c: unknown) => unknown) => fn(fakeClient),
  assertSafeTenantId: (t: string) => t,
}));

import aiPreviewRouter from '../routes/aiPreview.js';
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
app.use('/api/v1/ai', aiPreviewRouter); // 与 server.ts:216 一致（router 自带 /features 等）
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
  flag = 'false';
  fakeClient.query.mockClear();
});

const req = (method: string, p: string, body?: unknown) =>
  fetch(base + p, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

/** 2 处受控端点（aiPreview.ts 原 requireConfigRole 全部调用点）。PUT 的 body 按端点 zod 给足。 */
const ENDPOINTS: Array<{ name: string; method: string; path: string; body?: unknown }> = [
  { name: 'GET /ai/features', method: 'GET', path: '/api/v1/ai/features' },
  { name: 'PUT /ai/features', method: 'PUT', path: '/api/v1/ai/features', body: { enabled: true } },
];

describe('aiPreview.ts · I4 开关端点权限（A 组：等价性，改前改后都必须绿）', () => {
  it('①2 处端点：operator → 放行（2xx）；worker → 403', async () => {
    for (const e of ENDPOINTS) {
      authRole = 'operator';
      const ok = await req(e.method, e.path, e.body);
      expect(ok.status, `${e.name} operator 应放行`).toBeGreaterThanOrEqual(200);
      expect(ok.status, `${e.name} operator 应放行`).toBeLessThan(300);

      authRole = 'worker';
      const denied = await req(e.method, e.path, e.body);
      expect(denied.status, `${e.name} worker 应 403`).toBe(403);
    }
  });

  it('②2 处端点：reviewer（非配置角色）→ 403', async () => {
    authRole = 'reviewer';
    for (const e of ENDPOINTS) {
      const r = await req(e.method, e.path, e.body);
      expect(r.status, `${e.name} reviewer 应 403`).toBe(403);
    }
  });

  it('③守卫拦在写之前：worker 的 PUT 被 403 且开关值未被改写（不是"放行后写失败"）', async () => {
    authRole = 'worker';
    flag = 'false';
    const r = await req('PUT', '/api/v1/ai/features', { enabled: true });
    expect(r.status).toBe(403);
    expect(flag, '403 后开关值必须仍是 false —— 证明守卫先拦、写操作根本没执行').toBe('false');
  });
});

describe('aiPreview.ts · 可配置收益（B 组：改前必红，改后转绿）', () => {
  it('④租户把 ai.manage 授予 reviewer 后，reviewer 能读也能翻转开关，且翻转真的生效', async () => {
    authRole = 'reviewer';
    permRows = [{ perm: 'ai.manage' }];

    // 改前：requireConfigRole 是 admin/operator 角色白名单，**根本不查权限表** ⇒ 403（RED）；改后转绿。
    const read = await req('GET', '/api/v1/ai/features');
    expect(read.status).toBe(200);
    await read.json();

    const write = await req('PUT', '/api/v1/ai/features', { enabled: true });
    expect(write.status).toBe(200);

    // 钉住本批改动的**实现正确性**：client 复用同连接后，写进去的值能被读出来
    // （repo 加了可选 client 参数分支，读写各走一条 SQL，必须验证不是各写各的）
    const after = await req('GET', '/api/v1/ai/features');
    const body = (await after.json()) as { ok: boolean; enabled: boolean };
    expect(body.enabled, 'PUT enabled:true 后再读应为 true（client 复用路径读写一致）').toBe(true);
  });
});
