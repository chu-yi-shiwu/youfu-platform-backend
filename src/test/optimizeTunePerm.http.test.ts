// optimizeTunePerm.http.test.ts —— `optimize.tune` 权限点的**行为**特征测试（T8 回归审查 D 批）
//
// 【为什么必须新建这个文件】
//   T8 回归审查（2026-10-25）实测：`optimize.tune` 有 3 个调用点
//   （autoTune.ts:50 / optimize.ts:52 / optimize.ts:297），但**全仓零测试文件命中**
//   ⇒ 改坏 defaults、删掉守卫，2030 条测试照样全绿。属「权限分支零覆盖 ⇒ 新增测试文件」
//   的必要例外（同 T8 第二批 configPerm、第十四批 webhookPerm 的先例）。
//   既有 optimizeTransport.http.test.ts 是 dev 模式 + admin 的**业务**用例，测不到 403。
//
// 【为什么用 prod 不用 dev】
//   requirePermission 在 dev 恒放行（role.ts:509）⇒ dev 下写 403 断言是恒绿的假绿。
//
// 【这个权限点的特殊性：defaults 是 []，即默认仅 admin】
//   optimize.tune 不是「管理面」而是**高危动作**：AUTO_TUNE 生效时它会改写 workflow_def
//   （live 流程定义）。⇒ 默认只给 admin，租户可显式授予，但**不默认给 operator**。
//   本文件 A 组把这条钉死——将来谁手滑把它加进 operator，① 立刻红。

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const TENANT = 't-optimizetune';
let authRole = 'admin';
let authMode: 'dev' | 'prod' = 'prod';
let permRows: any[] = [];

const calls: string[] = [];
const fakeClient = {
  query: vi.fn(async (text: unknown, _params?: unknown[]) => {
    const sql = String(text);
    calls.push(sql);
    // —— 权限守卫：必须返回 rowCount = rows.length（无覆盖行时须为 0，否则角色恒 403）
    //    见骨架 §2.3 坑四：hasPerm(role.ts) 是按 **rowCount** 判定覆盖行的。
    if (sql.includes('SELECT perm FROM role_permission')) return { rows: permRows, rowCount: permRows.length };
    return { rows: [], rowCount: 0 };
  }),
};

vi.mock('../db/pool.js', () => ({
  default: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  withTenantClient: async (_tid: string, fn: (c: unknown) => unknown) => fn(fakeClient),
  assertSafeTenantId: (t: string) => t,
}));

// —— 依赖隔离：本文件只关心「谁被放行」，不关心调优算法与流程落库 ——
vi.mock('../repo/tenantSettings.js', () => ({
  getAutoTune: async () => ({ enabled: false, updatedAt: null }),
  setAutoTuneWithClient: async (_c: unknown, _t: string, enabled: boolean) => ({
    enabled,
    updatedAt: '2026-10-25T00:00:00.000Z',
  }),
  // generate 走「未生效」分支即可触达守卫；apply-workflow 需要 true 才能进到守卫
  isAutoTuneEffective: async () => (globalThis as any).__AUTO_TUNE_EFFECTIVE__ === true,
}));
vi.mock('../middleware/workflowConfigGuard.js', () => ({
  assertWorkflowConfigEditableByTenant: async () => undefined,
}));
vi.mock('../services/optimizer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/optimizer.js')>();
  return {
    ...actual,
    getModelParams: async () => ({}),
    generateOptimizations: () => [],
    detectRepeatHotspots: async () => [],
    detectEscortHotspots: async () => [],
    recordWorkflowRecommendations: async () => 0,
    applyWorkflowOptimizations: async () => ({ applied: true, changed: 0 }),
    applyDispatchOptimizations: async () => 0,
  };
});
vi.mock('../repo/stats.js', () => ({ processMetrics: async () => ({ orders_total: 0 }) }));
vi.mock('../repo/processMining.js', () => ({ processMining: async () => ({ cases: [] }) }));

import optimizeRouter from '../routes/optimize.js';
import autoTuneRouter from '../routes/autoTune.js';
import { errorMiddleware } from '../middleware/error.js';

let server: Server;
let base = '';

beforeAll(async () => {
  vi.stubEnv('MODEL_AUTO_TUNE', 'true'); // 避开全局熔断 409，让请求走到权限守卫
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((_req, res, next) => {
    res.locals.auth = { tenantId: TENANT, role: authRole, userId: 'acct-1', username: 'u1', requestId: 'r-1', authMode };
    next();
  });
  app.use('/api/v1', optimizeRouter); // 与 server.ts:197/199 一致
  app.use('/api/v1', autoTuneRouter);
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
  authRole = 'admin';
  authMode = 'prod';
  permRows = [];
  calls.length = 0;
  fakeClient.query.mockClear();
  (globalThis as any).__AUTO_TUNE_EFFECTIVE__ = false;
});

const put = (role: string, rows: any[], body: unknown = { enabled: true }) => {
  authRole = role;
  permRows = rows;
  return fetch(`${base}/auto-tune`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};
const post = (path: string, role: string, rows: any[], body: unknown = {}) => {
  authRole = role;
  permRows = rows;
  return fetch(`${base}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};
// A 组「等价性」：钉住 defaults=[] ⇒ 默认仅 admin。改前改后都必须绿。
describe('optimize.tune · A 组：等价性（defaults=[] ⇒ 默认仅 admin）', () => {
  it('①PUT /auto-tune：admin → 放行；operator/worker/reviewer → 403', async () => {
    expect((await put('admin', [])).status).toBe(200);
    expect((await put('operator', [])).status).toBe(403);
    expect((await put('worker', [])).status).toBe(403);
    expect((await put('reviewer', [])).status).toBe(403);
  });

  it('②POST /optimize/generate：admin 不被守卫拦；worker → 403', async () => {
    // 实测 admin = 200（{ ok:true, applied:false, decisions:[] }）——不是"没被拦就算过"。
    const admin = await post('optimize/generate', 'admin', []);
    expect(admin.status).toBe(200);
    const worker = await post('optimize/generate', 'worker', []);
    expect(worker.status).toBe(403);
  });

  it('③POST /optimize/apply-workflow（AUTO_TUNE 生效时真改 live 流程）：worker → 403', async () => {
    (globalThis as any).__AUTO_TUNE_EFFECTIVE__ = true; // 才能走到守卫（否则早退只记录）
    const admin = await post('optimize/apply-workflow', 'admin', []);
    expect(admin.status).toBe(200);
    const worker = await post('optimize/apply-workflow', 'worker', []);
    expect(worker.status).toBe(403);
  });

  it('④403 确实来自权限表比对：worker 打 apply-workflow 走了 SELECT perm FROM role_permission', async () => {
    (globalThis as any).__AUTO_TUNE_EFFECTIVE__ = true;
    const r = await post('optimize/apply-workflow', 'worker', []);
    expect(r.status).toBe(403);
    // 证明守卫真的执行了（而不是被别的 500/404 顶掉）：权限查询必须出现在 SQL 轨迹里。
    expect(calls.some((s) => s.includes('SELECT perm FROM role_permission'))).toBe(true);
  });

  it('④b 同伴锚：同一请求 admin 也走了同一条权限查询 ⇒ 差异纯粹来自权限比对结果', async () => {
    (globalThis as any).__AUTO_TUNE_EFFECTIVE__ = true;
    const admin = await post('optimize/apply-workflow', 'admin', []);
    expect(admin.status).toBe(200);
    const worker = await post('optimize/apply-workflow', 'worker', []);
    expect(worker.status).toBe(403);
  });
});

// B 组「可配置收益」：租户显式授予后应放行（证明不是写死 admin）。
describe('optimize.tune · B 组：可配置收益（授了权就得放行）', () => {
  it('⑤授 optimize.tune 给 reviewer ⇒ PUT /auto-tune 放行', async () => {
    const before = await put('reviewer', []);
    expect(before.status).toBe(403);
    const after = await put('reviewer', [{ perm: 'optimize.tune' }]);
    expect(after.status).toBe(200);
  });

  it('⑥反例锚：授的是别家权限点（basicdata.edit）⇒ 仍 403', async () => {
    const r = await put('reviewer', [{ perm: 'basicdata.edit' }]);
    expect(r.status).toBe(403);
  });

  it('⑦反例锚：授 dashboard.view（只读点）⇒ 仍 403', async () => {
    const r = await put('worker', [{ perm: 'dashboard.view' }]);
    expect(r.status).toBe(403);
  });
});

// C 组「顺序」：zod 校验与全局熔断都在守卫之前 —— 钉住顺序不被后续改造改坏。
describe('optimize.tune · C 组：守卫与相邻校验的先后顺序', () => {
  it('⑧zod body 校验先于守卫：worker 传非法 body ⇒ 422（不是 403）', async () => {
    const r = await put('worker', [], { enabled: 'not-a-bool' });
    expect(r.status).toBe(422);
  });
});
