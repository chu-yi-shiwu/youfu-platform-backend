// transportGuard.http.test.ts —— P1（B2 接 allowedRoles + 补 SLA 字段）。
// 真·express + 真 HTTP（对齐 volunteerGuard.http.test.ts 范式），mock 掉 DB 连接池（脚本化 client）。
// 覆盖（审查报告 20260908 🟡"运送线声明式角色门禁未强制"）：
//   ① 在身承运人 worker receive（allowedRoles 含 worker）→ 200
//   ② 在身承运人 worker cancel（allowedRoles 仅 admin/operator）→ 403（P1 缺口锁定回归）
//   ③ admin cancel → 200（放行口径不变）
//   ④ 建单带 sla_due_at → INSERT 落参（B2 补 SLA：期望完成时间入列，供 SLA cron 扫描）
//   ⑤ 建单不带 sla_due_at → INSERT 落 null（诚实：不替租户估时）
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

// ---- mock 掉 DB 连接池：脚本化 SQL 响应 + 调用日志 ----
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

import transportRouter from '../routes/transport.js';

const T = 't-transport-guard';
let server: Server;
let base = '';

// 注入指定角色 + prod 模式（requireAssigneeOrConfig 真校验归属，allowedRoles 门禁真生效）
function injectAuth(role: string) {
  return (_req: any, res: any, next: any) => {
    res.locals.auth = { tenantId: T, role, authMode: 'prod', userId: 'w-1', requestId: 'test' };
    next();
  };
}

function scriptTransportOrder(status: string) {
  h.scripted.length = 0;
  h.calls.length = 0;
  // workflow_def 查不到 → 走 TRANSPORT_DEF 内置默认（门禁口径即内置声明）
  h.scripted.push({ match: /FROM workflow_def/, rows: [] });
  // 归属守卫探测（SELECT id, carrier）与 transitionOrder 全量读（SELECT *）都命中
  h.scripted.push({
    match: /FROM transport_order WHERE id/,
    rows: [{ id: 'to-1', tenant_id: T, status, carrier: 'w-1', item_name: '标本' }],
  });
  h.scripted.push({ match: /FROM worker WHERE tenant_id/, rows: [{ id: 'w-1' }] });
  h.scripted.push({ match: /UPDATE transport_order/, rows: [{ id: 'to-1', status: 'next' }] });
  h.scripted.push({ match: /INSERT INTO transport_track_point/, rows: [] });
  h.scripted.push({ match: /INSERT INTO domain_event/, rows: [] });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/transport', injectAuth('worker'), transportRouter);
  app.use('/api/v1/admin-sim', injectAuth('admin'), transportRouter);
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

describe('transport transition allowedRoles 门禁（P1）', () => {
  it('① 在身承运人 worker receive → 200（allowedRoles 含 worker）', async () => {
    scriptTransportOrder('assigned');
    const r = await fetch(`${base}/api/v1/transport/orders/to-1/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'receive' }),
    });
    expect(r.status).toBe(200);
  });

  it('② 在身承运人 worker cancel → 403（P1 缺口锁定：此前可越权取消）', async () => {
    scriptTransportOrder('transporting');
    const r = await fetch(`${base}/api/v1/transport/orders/to-1/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'cancel' }),
    });
    expect(r.status).toBe(403);
  });

  it('③ admin cancel → 200（放行口径不变）', async () => {
    scriptTransportOrder('transporting');
    const r = await fetch(`${base}/api/v1/admin-sim/orders/to-1/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'cancel' }),
    });
    expect(r.status).toBe(200);
  });
});

describe('transport 建单 sla_due_at 落参（P1 B2 补 SLA）', () => {
  function scriptCreate() {
    h.scripted.length = 0;
    h.calls.length = 0;
    h.scripted.push({ match: /INSERT INTO transport_order/, rows: [{ id: 'to-new' }] });
    h.scripted.push({ match: /INSERT INTO domain_event/, rows: [] });
  }

  it('④ 带 sla_due_at → INSERT 参数含该值', async () => {
    scriptCreate();
    const r = await fetch(`${base}/api/v1/admin-sim/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item_name: '标本', sla_due_at: '2026-09-09T18:00:00+08:00' }),
    });
    expect(r.status).toBe(201);
    const ins = h.calls.find((c) => /INSERT INTO transport_order/.test(c.sql));
    expect(ins?.sql).toContain('sla_due_at');
    expect(ins?.params).toContain('2026-09-09T18:00:00+08:00');
  });

  it('⑤ 不带 sla_due_at → INSERT 落 null（不纳入 SLA 扫描）', async () => {
    scriptCreate();
    const r = await fetch(`${base}/api/v1/admin-sim/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item_name: '文件' }),
    });
    expect(r.status).toBe(201);
    const ins = h.calls.find((c) => /INSERT INTO transport_order/.test(c.sql));
    expect(ins?.sql).toContain('sla_due_at');
    // sla_due_at 是第 12 个参数（$12），插值位置落 null
    expect(ins?.params[11]).toBeNull();
  });
});
