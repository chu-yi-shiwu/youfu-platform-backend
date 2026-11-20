// 仓库配置化契约：租户默认仓库来自 system_config.material_default_warehouse。
// 覆盖三件事：GET/PUT 配置口径、consume 使用配置仓库、未配置回退“中心库”。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ text: string; params?: unknown[] }>,
  config: null as string | null,
  configThrows: false,
  client: null as unknown,
}));

vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(h.client),
  assertSafeTenantId: (t: string) => t,
  default: { connect: async () => { throw new Error('[default-warehouse.test] 不得使用真实 pool'); } },
}));

// client 由 hoisted 容器持有，handler 固定读 h.*，便于每个用例只切换配置。
h.client = {
  query: async (text: string, params?: unknown[]) => {
    h.calls.push({ text, params });
    if (text.includes('FROM system_config')) {
      if (h.configThrows) throw new Error('system_config unavailable');
      return h.config === null
        ? { rows: [], rowCount: 0 }
        : { rows: [{ value: h.config }], rowCount: 1 };
    }
    if (text.includes('FROM work_orders')) {
      return { rows: [{ id: 'wo-1', order_no: 'WO001', status: 'processing' }], rowCount: 1 };
    }
    if (text.includes("status = 'confirmed'")) return { rows: [], rowCount: 0 };
    if (text.includes('SELECT def FROM workflow_def')) return { rows: [], rowCount: 0 };
    if (text.includes('SELECT id, name FROM material')) {
      return { rows: [{ id: '11111111-1111-4111-8111-111111111111', name: '手套' }], rowCount: 1 };
    }
    if (text.includes('SELECT qty FROM inventory')) return { rows: [{ qty: 100 }], rowCount: 1 };
    if (text.includes('FROM settlement s')) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  },
};

import materialRouter from '../routes/material.js';

const TENANT = 't-warehouse';
const MID = '11111111-1111-4111-8111-111111111111';
let server: Server;
let base = '';

function auth(role = 'admin', authMode: 'dev' | 'prod' = 'dev') {
  return { tenantId: TENANT, role, authMode, userId: 'u-1', username: 'tester', requestId: 'r-1' };
}

async function start(a: ReturnType<typeof auth>) {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = a;
    next();
  });
  app.use('/api/v1', materialRouter);
  app.use(errorMiddleware);
  const s = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => s.once('listening', () => r()));
  return {
    server: s,
    base: `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/v1`,
  };
}

beforeEach(() => {
  h.calls = [];
  h.config = null;
  h.configThrows = false;
});

beforeAll(async () => {
  const s = await start(auth());
  server = s.server;
  base = s.base;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('租户默认仓库', () => {
  it('GET 返回 system_config 中的配置值', async () => {
    h.config = '东区库';
    const r = await fetch(`${base}/inventory/default-warehouse`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, code: 0, warehouse: '东区库' });
  });

  it('未配置时回退“中心库”', async () => {
    const r = await fetch(`${base}/inventory/default-warehouse`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { warehouse: string }).warehouse).toBe('中心库');
  });

  it('配置表不可读时仍回退“中心库”，不让库存入口整体不可用', async () => {
    h.configThrows = true;
    const r = await fetch(`${base}/inventory/default-warehouse`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { warehouse: string }).warehouse).toBe('中心库');
  });

  it('PUT 去空格并写入租户配置', async () => {
    const r = await fetch(`${base}/inventory/default-warehouse`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ warehouse: '  东区库  ' }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, warehouse: '东区库' });
    const upsert = h.calls.find((c) => c.text.includes('INSERT INTO system_config'));
    expect(upsert).toBeTruthy();
    expect(upsert!.text).toContain('material_default_warehouse');
    expect(upsert!.params).toEqual([TENANT, '东区库', 'tester']);
  });

  it('PUT 空白仓库名 → 422，不落库', async () => {
    const r = await fetch(`${base}/inventory/default-warehouse`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ warehouse: '   ' }),
    });
    expect(r.status).toBe(422);
    expect(h.calls.some((c) => c.text.includes('INSERT INTO system_config'))).toBe(false);
  });

  it('PUT 无 material.manage → 403（prod 模式）', async () => {
    const s = await start(auth('operator', 'prod'));
    try {
      const r = await fetch(`${s.base}/inventory/default-warehouse`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ warehouse: '东区库' }),
      });
      expect(r.status).toBe(403);
      expect(h.calls.some((c) => c.text.includes('INSERT INTO system_config'))).toBe(false);
    } finally {
      await new Promise<void>((r) => s.server.close(() => r()));
    }
  });

  it('consume 使用租户配置仓库扣减与写流水', async () => {
    h.config = '东区库';
    const r = await fetch(`${base}/inventory/consume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ work_order_id: 'wo-1', items: [{ material_id: MID, qty: 2 }] }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, items: [{ material_id: MID, remaining_qty: 98 }] });

    const lock = h.calls.find((c) => c.text.includes('SELECT qty FROM inventory'));
    expect(lock?.params).toEqual([TENANT, MID, '东区库']);
    const update = h.calls.find((c) => c.text.includes('UPDATE inventory'));
    expect(update?.params).toEqual([TENANT, MID, 98, '东区库']);
    const log = h.calls.find((c) => c.text.includes('INSERT INTO inventory_log'));
    expect(log?.params?.[6]).toBe('wo-1');
  });

  it('consume 未配置仓库时回退“中心库”', async () => {
    const r = await fetch(`${base}/inventory/consume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ work_order_id: 'wo-1', items: [{ material_id: MID, qty: 1 }] }),
    });
    expect(r.status).toBe(200);
    const lock = h.calls.find((c) => c.text.includes('SELECT qty FROM inventory'));
    expect(lock?.params).toEqual([TENANT, MID, '中心库']);
  });
});
