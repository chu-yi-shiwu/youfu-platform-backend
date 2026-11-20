// 模板应用到不存在租户 → 404（2026-11-14 深度探针负控制）
//
// 修复前实测：POST /platform/templates/:id/apply {tenantId:"no-such-tenant"} → 409 DRAFT_STALE
// 「expected version 0 but no def exists」——把「租户 ID 写错」误报成「草稿版本冲突」。
// 修复：进入租户事务前先查 tenant_registry，不存在直接 404。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const h = vi.hoisted(() => ({
  tenantExists: false,
  tenantCalls: 0,
}));

vi.mock('../middleware/platformAuth.js', () => ({
  platformAdminAuth: (_req: any, res: any, next: any) => {
    res.locals.platformAdmin = { username: 'probe-platform' };
    next();
  },
}));
vi.mock('../db/pool.js', () => ({
  default: {
    query: async (text: string) => {
      if (text.includes('FROM tenant_registry')) {
        return { rows: h.tenantExists ? [{ '?column?': 1 }] : [], rowCount: h.tenantExists ? 1 : 0 };
      }
      if (text.includes('FROM platform_template')) {
        return { rows: [{ id: 'tpl-1', status: 'published', entity_type: 'work_order', playbook: { workflow_def: { initial: 'draft', states: ['draft'], transitions: [] } } }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  },
  withTenantClient: async (_t: string, fn: (c: unknown) => unknown) => {
    h.tenantCalls += 1;
    return fn({ query: async () => ({ rows: [], rowCount: 0 }) });
  },
}));

import templateMarketRouter from '../routes/templateMarket.js';
import { errorMiddleware } from '../middleware/error.js';

let server: Server;
let base = '';
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/platform', templateMarketRouter);
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/platform`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('模板应用 · 租户存在性', () => {
  it('不存在租户 → 404，且不进入租户事务', async () => {
    h.tenantExists = false;
    h.tenantCalls = 0;
    const r = await fetch(`${base}/templates/tpl-1/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: 'no-such-tenant' }),
    });
    expect(r.status).toBe(404);
    expect(h.tenantCalls).toBe(0);
  });
});
