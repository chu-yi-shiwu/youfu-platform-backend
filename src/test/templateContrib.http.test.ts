// templateContrib.http.test.ts —— UGC 模板贡献端点（`src/routes/templateContributions.ts:26`）的
// **权限行为**特征测试（T8 第十五批：`requireConfigRole` 的最后一处）
//
// 【为什么必须新建这个文件】
//   `POST /api/v1/template-contributions` 此前 **HTTP 层零覆盖**：全仓 grep 只有
//   `platformAudit.test.ts` 提到 templateContributions，但它测的是 `recordPlatformAudit`
//   这个 repo 函数的**行为对齐**（SQL/序列化/失败契约），从不 mount 路由。
//   ⇒ 属「权限行为零覆盖 ⇒ 新增测试文件」的必要例外（同 T8 第二批 configPerm、第十四批 webhookPerm）。
//
// 【为什么用 prod 不用 dev】
//   requirePermission 在 dev 恒放行（role.ts:396）⇒ dev 下 403 断言是恒绿的假绿。
//
// 【权限点为什么叫 `template.contribute`】
//   不是新造的词：本端点写给平台审计的 action 字符串**代码里本来就叫这个**
//   （`templateContributions.ts` 里 `recordPlatformAudit({ action: 'template.contribute' })`）。
//   ⇒ 沿用代码原文，保持「代码里叫什么就写什么」。
//
// 【为什么不复用 `workflow.edit` / `basicdata.edit`】
//   `workflow.edit` 的 defaults 是 `[]`（仅 admin）⇒ 复用会把 operator 从放行变 403（破坏等价）；
//   `basicdata.edit` 语义不符 —— 本端点不是改字典，而是**向平台模板市场提交内容**
//   （写 `platform_template`，status=draft 待平台审核），是租户对外的动作。

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const TENANT = 't-tpl';
let authRole = 'operator';
let authMode: 'dev' | 'prod' = 'prod';
let permRows: any[] = [];
let defExists = true;

const calls: string[] = [];
const fakeClient = {
  query: vi.fn(async (text: unknown, _params?: unknown[]) => {
    const sql = String(text);
    calls.push(sql);
    // —— 权限守卫：必须返回 rowCount = rows.length（无覆盖行时须为 0，否则角色恒 403）
    //    见骨架 §2.3 坑四：hasPerm(role.ts:457) 是按 **rowCount** 判定覆盖行的。
    if (sql.includes('SELECT perm FROM role_permission')) return { rows: permRows, rowCount: permRows.length };
    if (sql.includes('SELECT 1 FROM workflow_def')) return { rows: defExists ? [{ '?column?': 1 }] : [], rowCount: defExists ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  }),
};
const fakePool = {
  query: vi.fn(async (text: unknown, _params?: unknown[]) => {
    const sql = String(text);
    calls.push(sql);
    if (sql.includes('INSERT INTO platform_template')) {
      return { rows: [{ id: 'pt-1', name: '模板A', status: 'draft', source: 'ugc' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
};

vi.mock('../db/pool.js', () => ({
  default: { query: (...a: unknown[]) => (fakePool.query as any)(...a) },
  withTenantClient: async (_tid: string, fn: (c: unknown) => unknown) => fn(fakeClient),
  assertSafeTenantId: (t: string) => t,
}));
// 流程 def：给一个 states 非空的最小 def，让「流程规则有效性」这条支线不干扰权限判定。
vi.mock('../engine/workflowDef.js', () => ({
  getWorkflowDef: async () => ({ key: 'work_order', states: ['draft', 'done'], transitions: [], initial: 'draft' }),
}));
// 平台审计：append-only 旁路，不是本文件要测的东西（真实覆盖在 platformAudit.test.ts）。
vi.mock('../repo/platformAudit.js', () => ({
  recordPlatformAudit: async () => null,
}));

import templateContributionsRouter from '../routes/templateContributions.js';
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
app.use('/api/v1', templateContributionsRouter); // 与 server.ts:184 一致
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
  defExists = true;
  calls.length = 0;
  fakeClient.query.mockClear();
  fakePool.query.mockClear();
});

const BODY = { name: '模板A', entity_type: 'work_order' };
const post = (role: string, rows: any[], body: unknown = BODY) => {
  authRole = role;
  permRows = rows;
  return fetch(`${base}/api/v1/template-contributions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

// A 组「等价性」：钉住现有放行分布 ⇒ 改前改后都必须绿。
describe('templateContributions.ts · 贡献端点权限（A 组：等价性）', () => {
  it('①operator → 201；worker → 403；reviewer → 403', async () => {
    const ok = await post('operator', []);
    expect(ok.status).toBe(201);
    expect(calls.some((s) => s.includes('INSERT INTO platform_template'))).toBe(true);
    const w = await post('worker', []);
    expect(w.status).toBe(403);
    const rv = await post('reviewer', []);
    expect(rv.status).toBe(403);
  });

  it('②守卫优先于 body 校验：operator 传非法 name ⇒ 422；worker 同传 ⇒ 403（序不变）', async () => {
    // zod：name 至少 2 个字符 ⇒ 单字符非法。该项目 zod 失败返回 **422**（实测，非 400）。
    const bad = { name: 'A', entity_type: 'work_order' };
    expect((await post('operator', [], bad)).status).toBe(422);
    // 原 requireConfigRole 在 zod parse **之前** ⇒ 未授权 + 非法 body 时先报 403。
    expect((await post('worker', [], bad)).status).toBe(403);
  });

  it('③业务校验仍在守卫之后：operator + 未配置流程的业务类型 ⇒ 400（不是 403）', async () => {
    defExists = false;
    const r = await post('operator', []);
    expect(r.status).toBe(400);
  });
});

// B 组「可配置收益」：改前必红 —— requireConfigRole 只读角色白名单、**不查权限表** ⇒ 授了也不放行。
describe('templateContributions.ts · 贡献端点权限（B 组：改前必红）', () => {
  it('④授 template.contribute 给 reviewer ⇒ 201（改前必红）', async () => {
    const before = await post('reviewer', []);
    expect(before.status).toBe(403);
    const after = await post('reviewer', [{ perm: 'template.contribute' }]);
    expect(after.status).toBe(201);
  });

  it('⑤反例锚：授的是别家权限点 ⇒ 仍 403', async () => {
    expect((await post('reviewer', [{ perm: 'workflow.edit' }])).status).toBe(403);
    expect((await post('reviewer', [{ perm: 'basicdata.edit' }])).status).toBe(403);
  });
});
