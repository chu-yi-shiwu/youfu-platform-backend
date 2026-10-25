// configPerm.http.test.ts —— config.ts 8 处配置写端点的**权限行为**特征测试（T8 第二批）
//
// 【为什么补这份】
//   config.ts 的 8 处写端点此前**没有任何一条测试钉住权限行为**——
//   dispatchRuleEffectiveChain.test.ts 只正向调过 POST /config/dispatch-rules（业务链），
//   从没断言过「谁不能改」。没有特征测试就换守卫 = 盲改，违反 E2。
//   ⇒ 本文件先把现状钉死，再改实现；改完分布不变 = 零行为变更。
//
// 【两组用例，性质不同（别混读）】
//   A 组「等价性」：worker/reviewer → 403，operator → 放行。**改前改后都必须绿**，
//     红了就说明收敛破坏了既有行为。
//   B 组「可配置收益」：给 reviewer 显式授予 basicdata.edit 后应放行。
//     **改前必红**（requireConfigRole 是角色白名单，根本不看权限表，授了也没用）；
//     改后转绿 ⇒ 这红→绿就是本次收敛的**全部价值**：配置端点终于可由租户授权了。
//
// 【为什么用 prod 不用 dev】
//   requirePermission 在 dev 模式恒放行（role.ts:396），用 dev 跑权限断言等于恒绿。
//   同 inspection.http.test.ts 的做法，一律 authMode='prod'。

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const TENANT = 't-config';
let authRole = 'operator';
let authMode: 'dev' | 'prod' = 'prod';
let permRows: any[] = [];

const fakeClient = {
  query: vi.fn(async (text: unknown, _params?: unknown[]) => {
    const sql = String(text);
    // —— 权限守卫：role_permission 覆盖行（默认空 ⇒ 回退默认矩阵）——
    if (sql.includes('SELECT perm FROM role_permission')) return { rows: permRows, rowCount: permRows.length };
    // —— dispatch_rule ——
    if (sql.includes('INSERT INTO dispatch_rule')) return { rows: [{ id: 'r-1', name: '规则A' }], rowCount: 1 };
    if (sql.includes('SELECT * FROM dispatch_rule WHERE id')) return { rows: [{ id: 'r-1' }], rowCount: 1 };
    if (sql.includes('UPDATE dispatch_rule SET')) return { rows: [{ id: 'r-1' }], rowCount: 1 };
    if (sql.includes('DELETE FROM dispatch_rule')) return { rows: [], rowCount: 1 };
    // —— term（术语）——
    if (sql.includes('INSERT INTO term')) return { rows: [{ id: 't-1', code: 'status' }], rowCount: 1 };
    if (sql.includes('SELECT * FROM term WHERE id')) return { rows: [{ id: 't-1' }], rowCount: 1 };
    if (sql.includes('UPDATE term SET')) return { rows: [{ id: 't-1' }], rowCount: 1 };
    if (sql.includes('DELETE FROM term')) return { rows: [], rowCount: 1 };
    // —— system_config ——
    if (sql.includes('INSERT INTO system_config')) return { rows: [{ id: 's-1', key: 'k', value: 'v' }], rowCount: 1 };
    if (sql.includes('FROM system_config')) return { rows: [{ id: 's-1', key: 'k', value: 'v' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
};

vi.mock('../db/pool.js', () => ({
  default: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  withTenantClient: async (_tid: string, fn: (c: unknown) => unknown) => fn(fakeClient),
  assertSafeTenantId: (t: string) => t,
}));

import configRouter from '../routes/config.js';
import tenantInfoRouter from '../routes/tenantInfo.js';
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
app.use('/api/v1', configRouter); // 与 server.ts:183 一致（configRouter 自带 /config 前缀）
app.use('/api/v1', tenantInfoRouter); // T8 第十四批：与 server.ts:205 一致（自带 /tenant-info 前缀）
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

/** 8 处配置写端点（config.ts 原 requireConfigRole 全部调用点），入参按各端点 zod schema 给足。 */
const WRITE_ENDPOINTS: Array<{ name: string; method: string; path: string; body?: unknown }> = [
  {
    name: 'POST /config/dispatch-rules',
    method: 'POST',
    path: '/api/v1/config/dispatch-rules',
    body: { name: '规则A', match_json: {}, strategy_json: { type: 'least_load' } },
  },
  { name: 'PUT /config/dispatch-rules/:id', method: 'PUT', path: '/api/v1/config/dispatch-rules/r-1', body: { name: '规则A2' } },
  { name: 'DELETE /config/dispatch-rules/:id', method: 'DELETE', path: '/api/v1/config/dispatch-rules/r-1' },
  {
    name: 'POST /config/terms',
    method: 'POST',
    path: '/api/v1/config/terms',
    body: { module: 'workorder', code: 'status', default_label: '状态', custom_label: '进度' },
  },
  { name: 'PUT /config/terms/:id', method: 'PUT', path: '/api/v1/config/terms/t-1', body: { custom_label: '进度2' } },
  { name: 'DELETE /config/terms/:id', method: 'DELETE', path: '/api/v1/config/terms/t-1' },
  { name: 'PUT /config/system', method: 'PUT', path: '/api/v1/config/system', body: { items: [{ key: 'brand', value: '优服家' }] } },
  { name: 'PUT /config/ticket-require-service-desk', method: 'PUT', path: '/api/v1/config/ticket-require-service-desk', body: { enabled: true } },
];

describe('config.ts · 配置写端点权限（A 组：等价性，改前改后都必须绿）', () => {
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

  it('③只读端点不收口：GET /config/dispatch-rules 与 GET /config/terms 对 worker 仍 200', async () => {
    authRole = 'worker';
    const a = await req('GET', '/api/v1/config/dispatch-rules');
    const b = await req('GET', '/api/v1/config/terms');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
  });
});

describe('config.ts · 可配置收益（B 组：改前必红，改后转绿）', () => {
  it('④租户把 basicdata.edit 授予 reviewer 后，reviewer 应能改配置', async () => {
    authRole = 'reviewer';
    permRows = [{ perm: 'basicdata.edit' }]; // 租户显式授权（role_permission 覆盖行）
    const r = await req('POST', '/api/v1/config/terms', {
      module: 'workorder',
      code: 'status',
      default_label: '状态',
      custom_label: '进度',
    });
    // 改前：requireConfigRole 是 admin/operator 角色白名单，**根本不查权限表**
    //       ⇒ 授了也没用，这里会是 403（RED）。改后走 requirePermission ⇒ 转绿。
    expect(r.status).toBeLessThan(300);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T8 第十四批：PUT /api/v1/tenant-info（tenantInfo.ts:50）
//
// 【为什么这两处的测试写在**同一个文件**里】
//   tenant-info 写的就是 `system_config` 表（brand_name / hotline），与 config.ts 的
//   system_config 段（`PUT /config/system`，本文件 WRITE_ENDPOINTS 第 7 项）是**同一张表**。
//   T8 第二批已确立「系统配置段 ⇒ basicdata.edit」的映射 ⇒ tenant-info 必须**沿用同一个权限点**，
//   否则就变成「同一张表、两个入口、两个答案」—— 正是 T8 要消灭的病。
//   并且本文件已有 system_config 的 SQL 桩（fakeClient 第 46-47 行）⇒ 零新增 mock 即可覆盖。
// ═══════════════════════════════════════════════════════════════════════════
describe('tenantInfo.ts · PUT /tenant-info 权限（T8 第十四批）', () => {
  const BODY = { name: '优服家', hotline: '400-000-1234' };

  // A 组「等价性」：钉住现有放行分布 ⇒ 改前改后都必须绿，红了就是收敛破坏了既有行为。
  it('A 组：operator → 200；worker / reviewer → 403', async () => {
    authRole = 'operator';
    expect((await req('PUT', '/api/v1/tenant-info', BODY)).status).toBe(200);
    authRole = 'worker';
    expect((await req('PUT', '/api/v1/tenant-info', BODY)).status).toBe(403);
    authRole = 'reviewer';
    expect((await req('PUT', '/api/v1/tenant-info', BODY)).status).toBe(403);
  });

  // B 组「可配置收益」：改前必红 —— requireConfigRole 只读 admin/operator 角色白名单、
  // **根本不查 role_permission 表** ⇒ 授了也没用，这里会是 403。改后转绿。
  it('B 组：授 basicdata.edit 给 reviewer ⇒ 200（改前必红）', async () => {
    authRole = 'reviewer';
    permRows = [{ perm: 'basicdata.edit' }];
    const r = await req('PUT', '/api/v1/tenant-info', BODY);
    expect(r.status).toBe(200);
  });

  // C 组「反例锚」：钉住「没授权就是不放行」，并与 config.ts 的口径对齐（同 basicdata.edit）。
  it('C 组：授的不是 basicdata.edit ⇒ 仍 403', async () => {
    authRole = 'reviewer';
    permRows = [{ perm: 'ticket.manage' }];
    expect((await req('PUT', '/api/v1/tenant-info', BODY)).status).toBe(403);
  });
});
