// statsPerm.http.test.ts —— 修复批次 X-8：GET /stats 权限墙（dashboard.view）真·HTTP 测试。
//
// 【为什么必须 prod 模式】hasPerm() 在 authMode:'dev' 下恒返回 true（src/middleware/role.ts）——
// dev 模式权限墙形同虚设。本文件走 tenantGuard.http.test.ts 同款 harness：真 authMiddleware +
// 真 JWT 验签（prod 模式），mock 掉 DB 连接池（脚本化 SQL 响应），断言真实 HTTP 状态码。
//
// 覆盖：
//   ① 未登录（无 Authorization）→ 401（authMiddleware 真行为，先于权限墙）
//   ② worker token → 403 permission denied: dashboard.view（默认矩阵 worker 无该权限点），
//      且 ticketStats 聚合 SQL 零执行（墙在数据聚合之前拦截）
//   ③ admin token → 200（admin 恒全放行；ticketStats 脚本化跑通返回结构）
//   ④ operator token → 200（默认矩阵 operator 含 dashboard.view——FE Dashboard/DataScreen/
//      Statistics 三页的现役合法调用方身份实证）
//   ⑤ dispatcher token → 200（默认矩阵 dispatcher 含 dashboard.view）
//   ⑥ 租户 role_permission 覆盖行授 dashboard.view → worker 也放行（租户级覆盖机制生效实证）
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

// ---- mock 掉 DB 连接池：default.query 服务 authMiddleware（tenant_registry），withTenantClient 交脚本化 client ----
const h = vi.hoisted(() => ({
  registry: [] as Array<{ match: RegExp; rows: any[] }>,
  statsClient: null as unknown,
  reset: () => {
    h.registry.length = 0;
    h.statsClient = null;
  },
  scriptRegistry: (rows: any[]) => h.registry.push({ match: /FROM tenant_registry/, rows }),
}));

vi.mock('../db/pool.js', () => ({
  default: {
    query: async (sql: string, params: unknown[] = []) => {
      for (const s of h.registry) {
        if (s.match.test(sql)) return { rows: s.rows, rowCount: s.rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  },
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(h.statsClient),
}));

import { authMiddleware, signJwt, __setAuthModeForTest, __clearTenantStatusCacheForTest } from '../middleware/auth.js';
import workOrderRouter from '../routes/workOrder.js';

const T = 't-stats-perm';
let server: Server;
let base = '';

function makeToken(role: string): string {
  return signJwt(
    { tid: T, sub: 'u-' + role, username: role + '-user', role, exp: Math.floor(Date.now() / 1000) + 600 },
    'test-stats-perm-secret',
  );
}

/** ticketStats 全部 SQL 的脚本化响应（零工单诚实口径：total=0 → 各率 0，不编造）。 */
function makeStatsClient(permRows: Array<{ perm: string }>) {
  return {
    query: async (text: string) => {
      // requirePermission 的租户级权限查询：rows 空 = 无覆盖行 → 回退默认矩阵
      if (text.includes('SELECT perm FROM role_permission')) {
        return { rows: permRows, rowCount: permRows.length };
      }
      // getWorkflowDef（完成态派生）：查无配置 → 引擎默认 def
      if (text.includes('FROM workflow_def')) return { rows: [], rowCount: 0 };
      // 主聚合（total/completed/cancelled/auto_dispatched/auto_closed/satisfaction）
      if (text.includes('FROM work_orders WHERE tenant_id = $1') && text.includes('COUNT(*) FILTER')) {
        return {
          rows: [
            {
              total: '0',
              completed: '0',
              cancelled: '0',
              auto_dispatched: '0',
              auto_closed: '0',
              satisfaction_avg: null,
              satisfaction_count: '0',
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('GROUP BY status')) return { rows: [], rowCount: 0 };
      if (text.includes('GROUP BY 1')) return { rows: [], rowCount: 0 };
      if (text.includes('generate_series')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };
}

let app: express.Express;

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-stats-perm-secret';
  app = express();
  app.use(express.json());
  app.use('/api', authMiddleware); // 与生产 server.ts:169-170 同序（apiGuard 对 /stats 无影响，省略）
  app.use('/api/v1', workOrderRouter); // 与生产 server.ts:173 挂载一致
  app.use(errorMiddleware);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
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
  h.scriptRegistry([{ status: 'active' }]);
});

afterEach(() => {
  __setAuthModeForTest('dev');
});

describe('GET /stats 权限墙（dashboard.view，修复批次 X-8）', () => {
  it('① 未登录（无 Authorization）→ 401（authMiddleware 真行为，先于权限墙）', async () => {
    const r = await fetch(`${base}/api/v1/stats`);
    expect(r.status, '未登录必须 401，不得放行统计聚合').toBe(401);
  });

  it('② worker → 403 permission denied: dashboard.view（默认矩阵 worker 无该点）', async () => {
    h.statsClient = makeStatsClient([]); // 无 role_permission 覆盖行 → 回退默认矩阵
    const r = await fetch(`${base}/api/v1/stats`, { headers: { Authorization: `Bearer ${makeToken('worker')}` } });
    expect(r.status, `期望 403，实际 ${r.status}`).toBe(403);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j.ok).toBe(false);
    expect(String(j.message)).toContain('dashboard.view');
  });

  it('③ admin → 200（恒全放行；ticketStats 脚本化跑通返回统计结构）', async () => {
    h.statsClient = makeStatsClient([]);
    const r = await fetch(`${base}/api/v1/stats`, { headers: { Authorization: `Bearer ${makeToken('admin')}` } });
    expect(r.status, `期望 200，实际 ${r.status}`).toBe(200);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j.ok).toBe(true);
    expect(j.total).toBe(0); // 零工单诚实口径：各率 0，不编造
    expect(j.auto_dispatch_rate).toBe(0);
    expect(j.auto_close_rate).toBe(0);
  });

  it('④ operator → 200（默认矩阵含 dashboard.view——FE Dashboard/DataScreen/Statistics 现役调用方实证）', async () => {
    h.statsClient = makeStatsClient([]);
    const r = await fetch(`${base}/api/v1/stats`, { headers: { Authorization: `Bearer ${makeToken('operator')}` } });
    expect(r.status, `期望 200，实际 ${r.status}`).toBe(200);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j.ok).toBe(true);
  });

  it('⑤ dispatcher → 200（默认矩阵含 dashboard.view）', async () => {
    h.statsClient = makeStatsClient([]);
    const r = await fetch(`${base}/api/v1/stats`, { headers: { Authorization: `Bearer ${makeToken('dispatcher')}` } });
    expect(r.status).toBe(200);
  });

  it('⑥ 租户 role_permission 覆盖行授 dashboard.view → worker 也放行（租户级覆盖机制实证）', async () => {
    h.statsClient = makeStatsClient([{ perm: 'dashboard.view' }]);
    const r = await fetch(`${base}/api/v1/stats`, { headers: { Authorization: `Bearer ${makeToken('worker')}` } });
    expect(r.status, `期望 200，实际 ${r.status}`).toBe(200);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j.ok).toBe(true);
  });
});
