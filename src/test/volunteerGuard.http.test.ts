// volunteerGuard.http.test.ts —— 志愿者报名/审批业务守卫（P0 双任务·任务一）。
// 真·express + 真 HTTP（对齐 intakeOptions.http.test.ts 范式），mock 掉 DB 连接池（脚本化 client）。
// 覆盖：① closed 活动 signup → 409（活动已关闭）
//       ② 名额满 signup → 409（count >= slots 拒绝）
//       ③ slots=0 活动报名 → 409（0 容量=不可报名，锁定新语义）
//       ④ registered 未签退直 approve → 409（状态机守卫）
//       ⑤ 全链 signup→checkin→checkout→approve 全 200（正向回归）
//       ⑥ signup 守卫 SQL 契约：act SELECT 必带 FOR UPDATE（行锁防并发超卖）
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

import volunteerRouter from '../routes/volunteer.js';

// ---- 真实 express + 真 HTTP（鉴权上下文直注入：admin + dev 恒放行 requireConfigRole） ----
const T = 't-volunteer-guard';
let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = { tenantId: T, role: 'admin', authMode: 'dev', userId: 'u1', requestId: 'test' };
    next();
  });
  app.use('/api/v1/volunteer', volunteerRouter); // 与生产 server.ts 挂载一致
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

async function post(path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
}

describe('报名守卫（signup 业务三重校验）', () => {
  it('① closed 活动 signup → 409 活动已关闭，且不产生 INSERT', async () => {
    h.scripted = [
      { match: /FROM volunteer_activity/, rows: [{ id: 'act-1', status: 'closed', slots: 10 }] },
    ];
    const r = await post('/volunteer/activities/act-1/signup', { user_name: '张三' });
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe('BAD_STATE');
    expect(r.body.message).toContain('已关闭');
    expect(h.calls.find((c) => c.sql.includes('INSERT INTO volunteer_record'))).toBeUndefined();
  });

  it('② 名额满（count=slots）signup → 409 名额已满', async () => {
    h.scripted = [
      { match: /FROM volunteer_activity/, rows: [{ id: 'act-2', status: 'open', slots: 2 }] },
      { match: /count\(\*\)::int AS n/, rows: [{ n: 2 }] },
    ];
    const r = await post('/volunteer/activities/act-2/signup', { user_name: '李四' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('BAD_STATE');
    expect(r.body.message).toContain('名额已满');
    expect(h.calls.find((c) => c.sql.includes('INSERT INTO volunteer_record'))).toBeUndefined();
  });

  it('③ slots=0 活动（0 容量）signup → 409（修复后锁定语义：0 容量=不可报名）', async () => {
    h.scripted = [
      { match: /FROM volunteer_activity/, rows: [{ id: 'act-3', status: 'open', slots: 0 }] },
      { match: /count\(\*\)::int AS n/, rows: [{ n: 0 }] },
    ];
    const r = await post('/volunteer/activities/act-3/signup', { user_name: '王五' });
    expect(r.status).toBe(409);
    expect(r.body.message).toContain('名额已满');
  });

  it('④ open 未满 signup → 201（正向回归：守卫不误伤正常报名）', async () => {
    h.scripted = [
      { match: /FROM volunteer_activity/, rows: [{ id: 'act-4', status: 'open', slots: 5 }] },
      { match: /count\(\*\)::int AS n/, rows: [{ n: 1 }] },
      { match: /INSERT INTO volunteer_record/, rows: [{ id: 'rec-1', status: 'registered' }] },
    ];
    const r = await post('/volunteer/activities/act-4/signup', { user_name: '赵六' });
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    expect((r.body.item as any).status).toBe('registered');
  });

  it('⑤ signup 守卫 SQL 契约：act SELECT 必带 FOR UPDATE 行锁（防并发超卖）', async () => {
    h.scripted = [
      { match: /FROM volunteer_activity/, rows: [{ id: 'act-5', status: 'open', slots: 5 }] },
      { match: /count\(\*\)::int AS n/, rows: [{ n: 0 }] },
      { match: /INSERT INTO volunteer_record/, rows: [{ id: 'rec-2', status: 'registered' }] },
    ];
    await post('/volunteer/activities/act-5/signup', { user_name: '钱七' });
    const act = h.calls.find((c) => c.sql.includes('FROM volunteer_activity'));
    expect(act).toBeDefined();
    expect(act!.sql).toMatch(/FOR UPDATE/);
    expect(act!.sql).toMatch(/status/);
    expect(act!.sql).toMatch(/slots/);
  });
});

describe('审批守卫（approve 状态机校验）', () => {
  it('⑥ registered（未签退）直 approve → 409 只能对已签退的记录审批', async () => {
    h.scripted = [
      { match: /SELECT \* FROM volunteer_record/, rows: [{ id: 'rec-3', status: 'registered', check_in_at: null }] },
    ];
    const r = await post('/volunteer/records/rec-3/approve');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('BAD_STATE');
    expect(r.body.message).toContain('已签退');
    expect(h.calls.find((c) => c.sql.includes("SET status = 'approved'"))).toBeUndefined();
  });

  it('⑦ 全链 signup→checkin→checkout→approve 全 200（状态机正向闭环）', async () => {
    // 步骤1 signup：open 未满 → 201
    h.scripted = [
      { match: /FROM volunteer_activity/, rows: [{ id: 'act-6', status: 'open', slots: 5 }] },
      { match: /count\(\*\)::int AS n/, rows: [{ n: 0 }] },
      { match: /INSERT INTO volunteer_record/, rows: [{ id: 'rec-4', status: 'registered' }] },
    ];
    const s1 = await post('/volunteer/activities/act-6/signup', { user_name: '孙八' });
    expect(s1.status).toBe(201);

    // 步骤2 checkin：registered → 200
    h.scripted = [
      { match: /SELECT \* FROM volunteer_record/, rows: [{ id: 'rec-4', status: 'registered', check_in_at: null }] },
      { match: /SET status = 'checked_in'/, rows: [{ id: 'rec-4', status: 'checked_in' }] },
    ];
    const s2 = await post('/volunteer/records/rec-4/checkin');
    expect(s2.status).toBe(200);

    // 步骤3 checkout：checked_in（有 check_in_at）→ 200
    h.scripted = [
      { match: /SELECT \* FROM volunteer_record/, rows: [{ id: 'rec-4', status: 'checked_in', check_in_at: '2026-09-08T02:00:00Z' }] },
      { match: /SET status = 'checked_out'/, rows: [{ id: 'rec-4', status: 'checked_out', duration_min: 60, points: 1 }] },
    ];
    const s3 = await post('/volunteer/records/rec-4/checkout');
    expect(s3.status).toBe(200);

    // 步骤4 approve：checked_out → 200（守卫放行）
    h.scripted = [
      { match: /SELECT \* FROM volunteer_record/, rows: [{ id: 'rec-4', status: 'checked_out', check_in_at: '2026-09-08T02:00:00Z' }] },
      { match: /SET status = 'approved'/, rows: [{ id: 'rec-4', status: 'approved' }] },
    ];
    const s4 = await post('/volunteer/records/rec-4/approve');
    expect(s4.status).toBe(200);
    expect((s4.body.item as any).status).toBe('approved');
  });
});
