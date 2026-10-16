// roleDefCrud.http.test.ts —— 地基第二步补漏：自定义角色（role_def）CRUD 端到端锚定。
//
// 【为什么有这个文件】2026-10-16 审查发现：090 建了 role_def 表、但全仓 `INSERT INTO role_def`
// 命中数为 0（没有任何写入入口）→ 自定义角色**建不出来** → "角色可配置"只做了一半。
// 本文件锚定新补的 4 个端点（GET/POST/PATCH/DELETE /accounts/roles），把"能生成"钉死成回归护栏。
//
// 范式：真 express + 真 HTTP，mock 掉 DB 连接池（与 accountsPerm.http.test.ts 同款脚本化 client）。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] }>,
  scripted: [] as Array<{ match: RegExp; rows: any[]; rowCount?: number }>,
}));
vi.mock('../db/pool.js', () => ({
  default: {},
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tenantId: string, fn: (client: any) => Promise<any>) => {
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        h.calls.push({ sql, params });
        for (const s of h.scripted) {
          if (s.match.test(sql)) return { rows: s.rows, rowCount: s.rowCount ?? s.rows.length };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    return fn(client);
  },
}));

import accountsRouter from '../routes/accounts.js';

const T = 't-roledef';
let server: Server;
let base = '';

function makeAuthMiddleware(opts: { role?: string; authMode?: string } = {}) {
  return (_req: any, res: any, next: any) => {
    res.locals.auth = {
      tenantId: T,
      role: opts.role ?? 'admin',
      authMode: opts.authMode ?? 'prod',
      userId: 'u-1',
      username: 'admin-a',
      requestId: 'test',
    };
    next();
  };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(makeAuthMiddleware());
  app.use('/api/v1', accountsRouter);
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  h.calls.length = 0;
  h.scripted = [];
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  role = 'admin',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-role': role },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
}

/** 非 admin 身份需另起 app（auth 中间件内联在 server 上）。 */
async function callAs(role: string, method: string, path: string, body?: unknown) {
  const app = express();
  app.use(express.json());
  app.use(makeAuthMiddleware({ role }));
  app.use('/api/v1', accountsRouter);
  app.use(errorMiddleware);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => srv.once('listening', () => resolve()));
  const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/v1`;
  const r = await fetch(`${b}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { raw: text }; }
  await new Promise<void>((res) => srv.close(() => res()));
  return { status: r.status, body: parsed };
}

const INS = /INSERT INTO role_def/;
const SEL_LIST = /SELECT code, name, description, enabled, sort FROM role_def/;
const UPD = /UPDATE role_def SET/;
const DEL_DEF = /DELETE FROM role_def/;
const DEL_PERM = /DELETE FROM role_permission/;
const SEL_USED = /SELECT 1 FROM account_user/;

describe('自定义角色 CRUD（地基第二步补漏）', () => {
  it('POST 新建自定义岗位 → 200 且确实写入 role_def（补上"生成"这一半）', async () => {
    h.scripted = [{ match: INS, rows: [{ id: 'r-1', code: 'repair_lead', name: '维修组长', description: null, enabled: true, sort: 100 }], rowCount: 1 }];
    const r = await call('POST', '/accounts/roles', { code: 'repair_lead', name: '维修组长' });
    expect(r.status, `期望 200，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(200);
    expect(r.body.ok).toBe(true);
    // 关键：INSERT 真的发生（这是此前全仓 0 命中的那条 SQL）
    expect(h.calls.some((c) => INS.test(c.sql))).toBe(true);
    const item = r.body.item as Record<string, unknown>;
    expect(item.code).toBe('repair_lead');
    expect(item.name).toBe('维修组长');
    expect(item.enabled).toBe(true);
  });

  it('POST 内置角色 code → 400（禁止租户覆盖内置语义）', async () => {
    for (const code of ['admin', 'operator', 'worker', 'reviewer', 'dispatcher', 'service_desk']) {
      const r = await call('POST', '/accounts/roles', { code, name: '冒名' });
      expect(r.status, `${code} 期望 400，实际 ${r.status}`).toBe(400);
    }
    expect(h.calls.some((c) => INS.test(c.sql))).toBe(false);
  });

  // 状态码口径：schema（zod）校验失败 → 422；业务规则拒绝（保留字/重复）→ 400/409。
  // 与项目既有约定一致（errorMiddleware 把 ZodError 映射为 422），此处不改写代码去迁就测试。
  it('POST 形状非法 code → 422（大写/空格/太短都不许，zod 层挡住）', async () => {
    for (const code of ['Repair', 'a', 'repair lead', '1lead', '']) {
      const r = await call('POST', '/accounts/roles', { code, name: 'x' });
      expect(r.status, `code="${code}" 期望 422，实际 ${r.status}`).toBe(422);
    }
    expect(h.calls.some((c) => INS.test(c.sql))).toBe(false);
  });

  it('POST 重复 code → 409（ON CONFLICT DO NOTHING → rowCount 0）', async () => {
    h.scripted = [{ match: INS, rows: [], rowCount: 0 }];
    const r = await call('POST', '/accounts/roles', { code: 'repair_lead', name: '维修组长' });
    expect(r.status, `期望 409，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(409);
  });

  // 【用户要求①】dispatcher/service_desk 退场 → 内置可选项由 6 降为 4（退场的两个不再出现在下拉里）。
  it('GET 列表 = 内置 4（已剔除退场）+ 本租户自建，builtin 标记正确', async () => {
    h.scripted = [
      { match: SEL_LIST, rows: [{ code: 'repair_lead', name: '维修组长', description: '带班', enabled: false, sort: 10 }] },
    ];
    const r = await call('GET', '/accounts/roles');
    expect(r.status).toBe(200);
    const items = r.body.items as Array<Record<string, unknown>>;
    expect(items.length).toBe(5); // 4 内置 + 1 自建
    expect(items.filter((i) => i.builtin).map((i) => i.code)).toEqual([
      'admin', 'operator', 'worker', 'reviewer',
    ]);
    // 退场角色必须彻底不出现在可选列表里（这是"拿掉"在接口层的体现）
    expect(items.map((i) => i.code)).not.toContain('dispatcher');
    expect(items.map((i) => i.code)).not.toContain('service_desk');
    const custom = items.find((i) => i.code === 'repair_lead') as Record<string, unknown>;
    expect(custom).toMatchObject({ name: '维修组长', enabled: false, builtin: false });
  });

  it('GET 列表带 retired 盘点：退场角色 + 存量账号数（供管理员决策改派，系统不动存量）', async () => {
    h.scripted = [
      { match: SEL_LIST, rows: [] },
      { match: /FROM account_user/, rows: [{ role: 'dispatcher', n: 3 }, { role: 'service_desk', n: 1 }] },
    ];
    const r = await call('GET', '/accounts/roles');
    expect(r.status).toBe(200);
    expect(r.body.retired).toEqual([
      { code: 'dispatcher', accounts: 3 },
      { code: 'service_desk', accounts: 1 },
    ]);
  });

  it('PATCH 停用自定义岗位 → 200（停用后不可再分配，见 roleDefRepo 用例）', async () => {
    h.scripted = [{ match: UPD, rows: [{ id: 'r-1', code: 'repair_lead', name: '维修组长', description: null, enabled: false, sort: 100 }], rowCount: 1 }];
    const r = await call('PATCH', '/accounts/roles/repair_lead', { enabled: false });
    expect(r.status, `期望 200，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(200);
    expect((r.body.item as Record<string, unknown>).enabled).toBe(false);
  });

  it('PATCH 内置角色 → 400', async () => {
    const r = await call('PATCH', '/accounts/roles/admin', { enabled: false });
    expect(r.status).toBe(400);
    expect(h.calls.some((c) => UPD.test(c.sql))).toBe(false);
  });

  it('DELETE 无账号在用 → 200，且级联清该角色的权限覆盖行（防僵尸行）', async () => {
    h.scripted = [
      { match: SEL_USED, rows: [], rowCount: 0 },
      { match: DEL_DEF, rows: [{ id: 'r-1' }], rowCount: 1 },
    ];
    const r = await call('DELETE', '/accounts/roles/repair_lead');
    expect(r.status, `期望 200，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(200);
    expect(h.calls.some((c) => DEL_PERM.test(c.sql))).toBe(true);
    expect(h.calls.some((c) => DEL_DEF.test(c.sql))).toBe(true);
  });

  it('DELETE 仍有账号在用 → 409 且不删（防留下无角色定义的孤儿账号）', async () => {
    h.scripted = [{ match: SEL_USED, rows: [{ '?column?': 1 }], rowCount: 1 }];
    const r = await call('DELETE', '/accounts/roles/repair_lead');
    expect(r.status, `期望 409，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(409);
    expect(h.calls.some((c) => DEL_DEF.test(c.sql))).toBe(false);
  });

  it('DELETE 不存在的自定义角色 → 404', async () => {
    h.scripted = [{ match: SEL_USED, rows: [], rowCount: 0 }];
    const r = await call('DELETE', '/accounts/roles/nobody');
    expect(r.status).toBe(404);
  });

  it('守卫：operator（默认矩阵无 role.manage）新建角色 → 403', async () => {
    const r = await callAs('operator', 'POST', '/accounts/roles', { code: 'repair_lead', name: '维修组长' });
    expect(r.status, `期望 403，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(403);
  });

  it('守卫：operator（默认矩阵无 role.manage）读角色列表 → 403', async () => {
    const r = await callAs('operator', 'GET', '/accounts/roles');
    expect(r.status, `期望 403，实际 ${r.status}`).toBe(403);
  });
});
