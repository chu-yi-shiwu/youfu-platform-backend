// tenantGuard.http.test.ts —— 八件 QA P3 修复：suspended/pending 租户「已签发 JWT」的在途拦截。
// 真·express + 真 authMiddleware（prod 模式 + 真 JWT 验签），mock 掉 DB 连接池（脚本化）。
// 覆盖：
//   ① active 租户 → 放行（200），且触发 registry 查询
//   ② suspended → 403 TENANT_SUSPENDED
//   ③ pending → 403 TENANT_PENDING
//   ④ registry 无记录 → 放行（与 login/redeem 同口径）
//   ⑤ 60s 缓存：同租户第二次请求不再查 registry（热路径零开销锁定）
//   ⑥ 公开 POST 路径豁免：POST /v1/auth/login 无 token → 到达路由（不 401 不 403）
//   ⑦ dev 模式守卫跳过（本地联调兼容）
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

// ---- mock 掉 DB 连接池：脚本化 SQL 响应 + 调用日志 ----
const h = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] }>,
  scripted: [] as Array<{ match: RegExp; rows: any[] }>,
  reset: () => {
    h.calls.length = 0;
    h.scripted.length = 0;
  },
  script: (match: RegExp, rows: any[]) => h.scripted.push({ match, rows }),
}));

vi.mock('../db/pool.js', () => ({
  default: {
    query: async (sql: string, params: unknown[] = []) => {
      h.calls.push({ sql, params });
      for (const s of h.scripted) {
        if (s.match.test(sql)) return { rows: s.rows, rowCount: s.rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  },
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tid: string, fn: (c: any) => Promise<any>) => fn({ query: async () => ({ rows: [], rowCount: 0 }) }),
}));

import { authMiddleware, signJwt, __setAuthModeForTest, __clearTenantStatusCacheForTest } from '../middleware/auth.js';

const T = 't-guard-test';
let server: Server;
let base = '';

function makeToken(): string {
  return signJwt({ tid: T, sub: 'u-1', username: 'root', role: 'admin', exp: Math.floor(Date.now() / 1000) + 600 }, 'test-guard-secret');
}

let app: express.Express;

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-guard-secret';
  app = express();
  app.use(express.json());
  app.use('/api', authMiddleware);
  app.get('/api/v1/ping', (_req, res) => res.json({ ok: true, pong: true }));
  app.post('/api/v1/auth/login', (_req, res) => res.json({ ok: true, login: true }));
  app.use(errorMiddleware);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  __setAuthModeForTest('prod');
  __clearTenantStatusCacheForTest();
  h.reset();
  h.script(/FROM tenant_registry/, [{ status: 'active' }]);
});

afterEach(() => {
  __setAuthModeForTest('dev');
});

describe('authMiddleware 租户状态守卫（八件 QA P3）', () => {
  it('① active 租户 → 放行 200，registry 校验真实发生', async () => {
    const r = await fetch(`${base}/api/v1/ping`, { headers: { Authorization: `Bearer ${makeToken()}` } });
    expect(r.status).toBe(200);
    const reg = h.calls.find((c) => /FROM tenant_registry/.test(c.sql));
    expect(reg).toBeTruthy();
    expect(reg!.params[0]).toBe(T);
  });

  it('② suspended 租户 → 403 TENANT_SUSPENDED', async () => {
    h.reset();
    h.script(/FROM tenant_registry/, [{ status: 'suspended' }]);
    const r = await fetch(`${base}/api/v1/ping`, { headers: { Authorization: `Bearer ${makeToken()}` } });
    expect(r.status).toBe(403);
    const j = (await r.json()) as any;
    expect(j.code).toBe('TENANT_SUSPENDED');
  });

  it('③ pending 租户 → 403 TENANT_PENDING（与 login 门同口径）', async () => {
    h.reset();
    h.script(/FROM tenant_registry/, [{ status: 'pending' }]);
    const r = await fetch(`${base}/api/v1/ping`, { headers: { Authorization: `Bearer ${makeToken()}` } });
    expect(r.status).toBe(403);
    const j = (await r.json()) as any;
    expect(j.code).toBe('TENANT_PENDING');
  });

  it('④ registry 无记录 → 放行（与 login/redeem 存量租户口径一致）', async () => {
    h.reset(); // 不设脚本 → 查无记录
    const r = await fetch(`${base}/api/v1/ping`, { headers: { Authorization: `Bearer ${makeToken()}` } });
    expect(r.status).toBe(200);
  });

  it('⑤ 60s 缓存：同租户第二次请求命中缓存，不再查 registry', async () => {
    await fetch(`${base}/api/v1/ping`, { headers: { Authorization: `Bearer ${makeToken()}` } }); // 首次：查 1 次
    h.reset();
    const r = await fetch(`${base}/api/v1/ping`, { headers: { Authorization: `Bearer ${makeToken()}` } }); // 二次：缓存
    expect(r.status).toBe(200);
    expect(h.calls.some((c) => /FROM tenant_registry/.test(c.sql))).toBe(false);
  });

  it('⑥ 公开 POST 路径豁免：POST /v1/auth/login 无 token → 到达路由', async () => {
    const r = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenant: T, username: 'x', password: 'y' }),
    });
    expect(r.status).toBe(200);
    expect((await r.json() as any).login).toBe(true);
  });

  it('⑦ dev 模式守卫跳过：Bearer dev 即放行（本地联调兼容不回归）', async () => {
    __setAuthModeForTest('dev');
    const r = await fetch(`${base}/api/v1/ping`, { headers: { Authorization: 'Bearer dev' } });
    expect(r.status).toBe(200);
    expect(h.calls.some((c) => /FROM tenant_registry/.test(c.sql))).toBe(false);
  });
});
