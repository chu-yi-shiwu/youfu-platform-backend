// volunteerSelfService.http.test.ts —— 2026-11-13 志愿者自助签到/签退。
// 场景：工人本人在小程序报名后，按 record.user_name == worker.name 放行签到/签退；
// 非本人仍走 volunteer.audit（403）。my-records 只返回本人记录。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] }>,
  scripted: [] as Array<{ match: RegExp; rows: any[]; rowCount?: number }>,
  auth: {} as any,
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

const T = 't-volunteer-self';
let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = h.auth;
    next();
  });
  app.use('/api/v1/volunteer', volunteerRouter);
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
  h.auth = { tenantId: T, role: 'worker', authMode: 'dev', userId: 'acct-w1', requestId: 'test' };
});

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any = {};
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
}

describe('志愿者自助签到/签退（worker 本人）', () => {
  it('my-records：只按当前工人姓名返回本人记录', async () => {
    h.scripted = [
      { match: /SELECT name FROM worker/, rows: [{ name: '张三' }] },
      { match: /FROM volunteer_record r/, rows: [{ id: 'rec-1', activity_id: 'act-1', user_name: '张三', status: 'registered' }] },
    ];
    const r = await call('GET', '/volunteer/my-records');
    expect(r.status).toBe(200);
    expect(r.body.items[0].user_name).toBe('张三');
    const q = h.calls.find((c) => /SELECT name FROM worker/.test(c.sql));
    expect(q!.params).toContain('acct-w1');
  });

  it('本人签到：record.user_name == worker.name → 200，不需要 volunteer.audit', async () => {
    h.scripted = [
      { match: /SELECT \* FROM volunteer_record/, rows: [{ id: 'rec-1', activity_id: 'act-1', user_name: '张三', status: 'registered' }] },
      { match: /SELECT 1 FROM worker/, rows: [{ '?column?': 1 }] },
      { match: /SELECT end_at FROM volunteer_activity/, rows: [{ end_at: null }] },
      { match: /UPDATE volunteer_record SET status = 'checked_in'/, rows: [{ id: 'rec-1', status: 'checked_in' }] },
    ];
    const r = await call('POST', '/volunteer/records/rec-1/checkin');
    expect(r.status).toBe(200);
    expect(r.body.item.status).toBe('checked_in');
  });

  it('非本人签到：worker.name 不匹配 → 403，不能替他人签到', async () => {
    h.auth = { tenantId: T, role: 'worker', authMode: 'prod', userId: 'acct-w2', requestId: 'test' };
    h.scripted = [
      { match: /SELECT \* FROM volunteer_record/, rows: [{ id: 'rec-1', activity_id: 'act-1', user_name: '张三', status: 'registered' }] },
      { match: /SELECT 1 FROM worker/, rows: [] },
      { match: /FROM role_permission/, rows: [] },
    ];
    const r = await call('POST', '/volunteer/records/rec-1/checkin');
    expect(r.status).toBe(403);
  });

  it('本人签退：checked_in → checked_out，自动算时长', async () => {
    h.scripted = [
      { match: /SELECT \* FROM volunteer_record/, rows: [{ id: 'rec-1', activity_id: 'act-1', user_name: '张三', status: 'checked_in', check_in_at: new Date(Date.now() - 3600e3).toISOString() }] },
      { match: /SELECT 1 FROM worker/, rows: [{ '?column?': 1 }] },
      { match: /UPDATE volunteer_record SET status = 'checked_out'/, rows: [{ id: 'rec-1', status: 'checked_out', duration_min: 60, points: 1 }] },
    ];
    const r = await call('POST', '/volunteer/records/rec-1/checkout');
    expect(r.status).toBe(200);
    expect(r.body.item.status).toBe('checked_out');
  });

  it('本人取消报名：registered → 200，释放名额', async () => {
    h.scripted = [
      { match: /SELECT \* FROM volunteer_record/, rows: [{ id: 'rec-1', activity_id: 'act-1', user_name: '张三', status: 'registered' }] },
      { match: /SELECT 1 FROM worker/, rows: [{ '?column?': 1 }] },
      { match: /DELETE FROM volunteer_record/, rows: [], rowCount: 1 },
    ];
    const r = await call('DELETE', '/volunteer/records/rec-1');
    expect(r.status).toBe(200);
    expect(r.body.deleted).toBe(1);
  });

  it('已签到记录不能取消报名 → 409', async () => {
    h.scripted = [
      { match: /SELECT \* FROM volunteer_record/, rows: [{ id: 'rec-1', activity_id: 'act-1', user_name: '张三', status: 'checked_in' }] },
      { match: /SELECT 1 FROM worker/, rows: [{ '?column?': 1 }] },
    ];
    const r = await call('DELETE', '/volunteer/records/rec-1');
    expect(r.status).toBe(409);
  });

  it('管理员编辑活动 → 200；名额小于已报名人数 → 409', async () => {
    h.auth = { tenantId: T, role: 'admin', authMode: 'dev', userId: 'admin-1', requestId: 'test' };
    h.scripted = [
      { match: /SELECT \* FROM volunteer_activity/, rows: [{ id: 'act-1', title: '旧标题', slots: 5, start_at: null, end_at: null }] },
      { match: /SELECT count\(\*\)::int n FROM volunteer_record/, rows: [{ n: 3 }] },
      { match: /UPDATE volunteer_activity SET/, rows: [{ id: 'act-1', title: '新标题', slots: 5 }] },
    ];
    const ok = await call('PUT', '/volunteer/activities/act-1', { title: '新标题', slots: 5 });
    expect(ok.status).toBe(200);
    h.scripted = [
      { match: /SELECT \* FROM volunteer_activity/, rows: [{ id: 'act-1', title: '旧标题', slots: 5, start_at: null, end_at: null }] },
      { match: /SELECT count\(\*\)::int n FROM volunteer_record/, rows: [{ n: 3 }] },
    ];
    const bad = await call('PUT', '/volunteer/activities/act-1', { slots: 2 });
    expect(bad.status).toBe(409);
  });

  it('管理员删除活动：无报名 200；有报名 409', async () => {
    h.auth = { tenantId: T, role: 'admin', authMode: 'dev', userId: 'admin-1', requestId: 'test' };
    h.scripted = [
      { match: /SELECT id FROM volunteer_activity/, rows: [{ id: 'act-1' }] },
      { match: /SELECT count\(\*\)::int n FROM volunteer_record/, rows: [{ n: 0 }] },
      { match: /DELETE FROM volunteer_activity/, rows: [], rowCount: 1 },
    ];
    const ok = await call('DELETE', '/volunteer/activities/act-1');
    expect(ok.status).toBe(200);
    h.scripted = [
      { match: /SELECT id FROM volunteer_activity/, rows: [{ id: 'act-1' }] },
      { match: /SELECT count\(\*\)::int n FROM volunteer_record/, rows: [{ n: 2 }] },
    ];
    const bad = await call('DELETE', '/volunteer/activities/act-1');
    expect(bad.status).toBe(409);
  });
});
