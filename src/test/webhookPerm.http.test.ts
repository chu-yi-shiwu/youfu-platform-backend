// webhookPerm.http.test.ts —— Webhook 订阅注册端点（`src/webhook/routes.ts:21`）的
// **权限行为**特征测试（T8 第十四批）
//
// 【为什么必须新建这个文件（而不是扩既有测试）】
//   `POST /api/v1/webhooks/subscriptions` 此前 **HTTP 层零覆盖**：既有 `webhook.test.ts`
//   是 dispatch 的**纯函数单测**（HMAC 签名 / 信封 / SSRF 判定），从不 mount 路由；
//   全仓 grep 实测：除 `server.ts:179` 外**没有任何测试文件挂载 webhookRouter**。
//   ⇒ 属于「权限行为零覆盖 ⇒ 新增测试文件」的必要例外（同 T8 第二批建 configPerm 的先例）。
//
// 【为什么用 prod 不用 dev】
//   requirePermission 在 dev 恒放行（role.ts:396）⇒ dev 下 403 断言是恒绿的假绿。
//
// 【为什么这个端点单独用 `webhook.manage`，不蹭 `basicdata.edit`】
//   订阅一旦注册，平台就会**主动向该 URL 发起出向请求**——这正是站内 SSRF 闸
//   （`assertSafeOutboundUrl`，F-E2）存在的原因。它是「对外开口」，风险等级与改字典
//   不是一回事；复用 basicdata.edit 会让每一个能改字典的人**自动获得**开一个对外回调
//   通道的能力 = 权限放大。⇒ 新增 webhook.manage，defaults ['operator']（为等价，非策略选择）。

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const TENANT = 't-webhook';
let authRole = 'operator';
let authMode: 'dev' | 'prod' = 'prod';
let permRows: any[] = [];

const calls: string[] = [];
const fakeClient = {
  query: vi.fn(async (text: unknown, _params?: unknown[]) => {
    const sql = String(text);
    calls.push(sql);
    // —— 权限守卫：必须返回 rowCount = rows.length（无覆盖行时须为 0，否则角色恒 403）
    //    见骨架 §2.3 坑四：hasPerm(role.ts:457) 是按 **rowCount** 判定覆盖行的。
    if (sql.includes('SELECT perm FROM role_permission')) return { rows: permRows, rowCount: permRows.length };
    if (sql.includes('INSERT INTO webhook_subscription')) {
      return { rows: [{ id: 'ws-1', url: 'https://example.com/hook', events: ['*'], active: true }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }),
};

vi.mock('../db/pool.js', () => ({
  default: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  withTenantClient: async (_tid: string, fn: (c: unknown) => unknown) => fn(fakeClient),
  assertSafeTenantId: (t: string) => t,
}));
// SSRF 闸与投递**不是本文件要测的东西**：放行 URL 校验，把注意力留给权限判定本身。
// （真正的 SSRF 判定覆盖面在 webhook.test.ts 的纯函数用例里。）
vi.mock('../webhook/dispatch.js', () => ({
  assertSafeOutboundUrl: async (_url: string) => undefined,
  probeWebhook: async () => ({ ok: true }),
}));

import webhookRouter from '../webhook/routes.js';
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
app.use('/api/v1', webhookRouter); // 与 server.ts:179 一致
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
  calls.length = 0;
  fakeClient.query.mockClear();
});

const post = (role: string, rows: any[], body: unknown = { url: 'https://example.com/hook' }) => {
  authRole = role;
  permRows = rows;
  return fetch(`${base}/api/v1/webhooks/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
};

// A 组「等价性」：钉住现有放行分布 ⇒ 改前改后都必须绿。
describe('webhook.ts · 订阅注册权限（A 组：等价性，改前改后都必须绿）', () => {
  it('①operator → 201；worker → 403；reviewer → 403', async () => {
    const ok = await post('operator', []);
    expect(ok.status).toBe(201);
    const w = await post('worker', []);
    expect(w.status).toBe(403);
    const rv = await post('reviewer', []);
    expect(rv.status).toBe(403);
  });

  it('②守卫优先于 body 校验：operator 传非法 url ⇒ 422；worker 同传 ⇒ 403（序不变）', async () => {
    const bad = { url: 'not-a-url' };
    // zod 校验失败在这个项目返回 **422**（非 400）——按实测写，不照别的文件抄。
    const operatorBad = await post('operator', [], bad);
    expect(operatorBad.status).toBe(422);
    const workerBad = await post('worker', [], bad);
    // 原 requireConfigRole 在 zod parse **之前** ⇒ 未授权 + 非法 body 时先报 403。
    // 收敛后守卫仍保持在事务首行（403 优先于 422）⇒ 这条钉住顺序没被改坏。
    expect(workerBad.status).toBe(403);
  });
});

// B 组「可配置收益」：改前必红（requireConfigRole 不查权限表 ⇒ 授了也不放行）。
describe('webhook.ts · 订阅注册权限（B 组：改前必红，改后转绿）', () => {
  it('③授 webhook.manage 给 reviewer ⇒ 201（改前必红）', async () => {
    const before = await post('reviewer', []);
    expect(before.status).toBe(403);
    const after = await post('reviewer', [{ perm: 'webhook.manage' }]);
    expect(after.status).toBe(201);
    expect(calls.some((s) => s.includes('INSERT INTO webhook_subscription'))).toBe(true);
  });

  it('④反例锚：授的是别家权限点（basicdata.edit）⇒ 仍 403', async () => {
    const r = await post('reviewer', [{ perm: 'basicdata.edit' }]);
    expect(r.status).toBe(403);
  });
});
