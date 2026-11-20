/**
 * claimAssigneeServerWins.http.test.ts —— 抢单的 assignee 必须由服务端最终决定（P0）。
 *
 * 【为什么必须在路由层测，不能只测 service】
 *   漏洞由两处拼成：
 *     ① services/claimWorkOrder.ts 里 `fields: { assignee: realWorkerId, ...(p.fields ?? {}) }`
 *        ——客户端字段在后，展开即覆盖服务端的真实认领人；
 *     ② routes/workOrder.ts 的 body 是 `.passthrough()`——`{"assignee":"别人的workerId"}`
 *        能原样进 fields。
 *   只测 service 会漏掉 ②（路由把 assignee 当普通透传字段），只测路由会漏掉 ① 的展开顺序。
 *   所以本文件走**真 express + 真路由**，断言最终写进 UPDATE 的 assignee。
 *
 * 【为什么用 W-EVIL 而不是一个不存在的 id】
 *   若用不存在的 worker id，transition() 的 assignee 存在性校验会先报 422，
 *   测试在"修复前"也是红的，但红的原因不对（测成了"幽灵工人校验"）。这里两个 id
 *   都是合法工人 ⇒ 修复前会真的把单写到别人名下，断言才具备鉴别力。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

const T = 't-claim-assignee';
const WO = '55555555-5555-4555-8555-555555555555';
const MY_WORKER = 'W-MINE';
const OTHER_WORKER = 'W-EVIL';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] }>,
  client: null as unknown,
}));

vi.mock('../db/pool.js', () => ({
  default: { connect: async () => { throw new Error('[claimAssignee] 单测禁用真实 pool'); } },
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(h.client),
}));

import workOrderRouter from '../routes/workOrder.js';

interface Handler {
  match: (sql: string) => boolean;
  reply: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number };
}

function makeClient(handlers: Handler[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  h.calls = calls;
  h.client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      for (const hd of handlers) if (hd.match(sql)) return hd.reply(sql, params);
      return { rows: [], rowCount: 1 };
    },
  };
  return calls;
}

/** 池态单子（claim_hall）：claim 边来自默认 def（claim_hall --claim--> assigned，allowedRoles 含 worker）。 */
const orderRow: Handler = {
  match: (s) => s.includes('SELECT * FROM work_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE'),
  reply: () => ({
    rows: [{
      id: WO, tenant_id: T, order_no: 'WO-CLAIM-1', status: 'claim_hall',
      assignee_id: null, department: null, def_version: 0,
    }],
    rowCount: 1,
  }),
};

const noTenantDef: Handler = { match: (s) => s.includes('FROM workflow_def'), reply: () => ({ rows: [], rowCount: 0 }) };

/** token 身份 → 真实 worker.id（account_id 反查）。 */
const myWorkerProfile: Handler = {
  match: (s) => s.includes('FROM worker WHERE tenant_id=$2 AND (account_id=$1 OR id=$1)'),
  reply: () => ({ rows: [{ id: MY_WORKER, department: null }], rowCount: 1 }),
};

/** assignee 存在性校验：两个 id 都合法（否则修复前会 422 而不是错派，测试失去鉴别力）。 */
const bothWorkersExist: Handler = {
  match: (s) => s.includes('FROM worker WHERE id = $1 AND tenant_id = $2 AND active = true'),
  reply: () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }),
};

const updateOrder: Handler = {
  match: (s) => s.includes('UPDATE work_orders SET status'),
  reply: (_s, p) => ({
    rows: [{
      id: WO, tenant_id: T, order_no: 'WO-CLAIM-1', status: 'assigned',
      assignee_id: p[3], department: null, def_version: 0, auto_flow: false,
    }],
    rowCount: 1,
  }),
};

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = { tenantId: T, userId: 'acc-me', role: 'worker', username: 'me', authMode: 'prod', requestId: 'test' };
    next();
  });
  app.use('/api/v1', workOrderRouter); // 与生产 server.ts 挂载一致
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
  h.calls = [];
});

async function claim(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, any> }> {
  const r = await fetch(`${base}/open/work_order/${WO}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: Record<string, any> = {};
  try { parsed = JSON.parse(text) as Record<string, any>; } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
}

describe('抢单 assignee 由服务端决定（body 覆盖不掉）', () => {
  it('C1 body 带 assignee=别人的 workerId → 200，落库 assignee 仍是真实认领人', async () => {
    makeClient([orderRow, noTenantDef, myWorkerProfile, bothWorkersExist, updateOrder]);
    const r = await claim({ assignee: OTHER_WORKER, claim_note: '我来了' });
    expect(r.status).toBe(200);

    const upd = h.calls.find((c) => c.sql.includes('UPDATE work_orders SET status'));
    expect(upd).toBeDefined();
    // assignee_id = $4 ⇒ params[3]。修复前这里是 W-EVIL（= 把单塞给别人）
    expect(upd!.params[3]).toBe(MY_WORKER);
    expect(upd!.params[3]).not.toBe(OTHER_WORKER);
  });

  it('C2 客户端其他字段仍原样透传（claim_note 不被连带丢掉）', async () => {
    makeClient([orderRow, noTenantDef, myWorkerProfile, bothWorkersExist, updateOrder]);
    const r = await claim({ assignee: OTHER_WORKER, claim_note: '接单备注' });
    expect(r.status).toBe(200);

    const ev = h.calls.find((c) => c.sql.includes('INSERT INTO ticket_event'));
    expect(ev).toBeDefined();
    const payload = JSON.parse(String(ev!.params[5])) as { fields: Record<string, unknown> };
    expect(payload.fields.assignee).toBe(MY_WORKER);
    expect(payload.fields.claim_note).toBe('接单备注');
  });

  it('C3 不带 assignee 的正常抢单行为不变（零字段透传，不误伤存量客户端）', async () => {
    makeClient([orderRow, noTenantDef, myWorkerProfile, bothWorkersExist, updateOrder]);
    const r = await claim({});
    expect(r.status).toBe(200);
    const upd = h.calls.find((c) => c.sql.includes('UPDATE work_orders SET status'));
    expect(upd!.params[3]).toBe(MY_WORKER);
  });
});
