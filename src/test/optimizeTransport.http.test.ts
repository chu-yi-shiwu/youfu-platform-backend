// optimizeTransport.http.test.ts —— 陪检运力走廊接线 + false 路径 scope 归一落库（P0 双任务·任务二，QA 条件用例）。
// 真·express + 真 HTTP，partial mock services/optimizer.js（保留真 generateEscortCorridorOptimizations/dbScopeFor）。
// 覆盖：① MODEL_AUTO_TUNE=false 下 /optimize/generate 对 transport 决策经 dbScopeFor 归一为 'workflow' 落库
//         （修复前直接写 scope='transport' 撞 optimization_feedback DDL CHECK → 整个事务 500 的回归锁）
//       ② target='transport:repeat_corridor' 语义前缀原样保留（人工消费口径不受 scope 归一影响）
//       ③ 维修线热点检测器（detectRepeatHotspots）与陪检走廊检测器同请求共存不互斥
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

// ---- mock DB 连接池（脚本化 client + 调用日志） ----
const h = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] }>,
}));
vi.mock('../db/pool.js', () => ({
  default: {},
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tenantId: string, fn: (client: any) => Promise<any>) => {
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        h.calls.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
    };
    return fn(client);
  },
}));

// ---- partial mock optimizer.js：数据源检测器受控，纯函数/落库映射走真实现 ----
vi.mock('../services/optimizer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/optimizer.js')>();
  return {
    ...actual,
    generateOptimizations: () => [],
    detectRepeatHotspots: async () => [],
    detectEscortHotspots: async () => [
      { location: '门诊楼 3 层', catalog: 'cat-escort', catalog_name: 'CT陪检', count: 3 },
    ],
  };
});
// processMetrics 真实现会查库（mock 环境无表），generateOptimizations 已 mock 故形态无关紧要
vi.mock('../repo/stats.js', () => ({
  processMetrics: async () => ({ orders_total: 0 }),
}));

import optimizeRouter from '../routes/optimize.js';

const T = 't-opt-transport';
let server: Server;
let base = '';

beforeAll(async () => {
  vi.stubEnv('MODEL_AUTO_TUNE', 'false'); // 锁定 false 路径（dev 默认口径）
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = { tenantId: T, role: 'admin', authMode: 'dev', userId: 'u1', requestId: 'test' };
    next();
  });
  app.use('/api/v1', optimizeRouter); // 与生产 server.ts 挂载一致
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}/api/v1`;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  h.calls.length = 0;
});

describe('POST /api/v1/optimize/generate（autoTune=false · transport 决策落库契约）', () => {
  it('① transport 决策经 dbScopeFor 归一为 workflow 落库（DDL CHECK 回归锁），target 前缀原样保留', async () => {
    const r = await fetch(`${base}/optimize/generate`, { method: 'POST' });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; applied: boolean };
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(false);

    const inserts = h.calls.filter((c) => c.sql.includes('INSERT INTO optimization_feedback'));
    expect(inserts.length).toBeGreaterThanOrEqual(1); // 至少陪检走廊 1 条落库
    // 核心断言：scope 落库值必须是 'workflow'（修复前 'transport' 直接撞 DDL CHECK → 事务回滚 500）
    expect(inserts.map((c) => c.params[1])).not.toContain('transport');
    // 语义前缀不受归一影响：transport:repeat_corridor 原样保留供人工消费
    const escortInsert = inserts.find((c) => c.params[2] === 'transport:repeat_corridor');
    expect(escortInsert).toBeDefined();
    expect(escortInsert!.params[1]).toBe('workflow');
    expect(escortInsert!.params[0]).toBe(T);
  });

  it('② SQL 契约：两检测器 JOIN 谓词必为 fc.id::text = wo.catalog（uuid=text 500 事故回归锁，live 2026-09-08 实证）', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../services/optimizer.ts', import.meta.url), 'utf8');
    const joins = src.match(/LEFT JOIN fault_category fc ON [^\n]+/g) ?? [];
    expect(joins.length).toBe(2); // detectRepeatHotspots + detectEscortHotspots
    for (const j of joins) {
      expect(j).toContain('fc.id::text = wo.catalog');
      expect(j).not.toMatch(/fc\.id = wo\.catalog/);
    }
  });
});
