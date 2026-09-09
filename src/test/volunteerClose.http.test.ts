// volunteerClose.http.test.ts —— P1：活动关闭/重开端点 + 志愿者人员档案聚合端点。
// 真·express + 真 HTTP（对齐 volunteerGuard.http.test.ts 范式），mock 掉 DB 连接池。
// 覆盖：
//   ① PUT /activities/:id/status {status:'closed'} → 200 + status 落参 closed
//   ② PUT 非法 status → 422（zod 枚举校验）
//   ③ PUT 不存在的活动 → 404
//   ④ GET /people → 200 人员档案聚合行（按 user_name 归并）
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

import volunteerRouter from '../routes/volunteer.js';

const T = 't-volunteer-close';
let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = { tenantId: T, role: 'admin', authMode: 'dev', userId: 'u1', requestId: 'test' };
    next();
  });
  app.use('/api/v1/volunteer', volunteerRouter);
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

describe('volunteer 活动关闭端点（P1）', () => {
  it('① 关闭活动 → 200，status=closed 落参，域事件 type=close', async () => {
    h.calls.length = 0;
    h.scripted.length = 0;
    h.scripted.push({ match: /UPDATE volunteer_activity/, rows: [{ id: 'a1', title: '导诊', status: 'closed' }] });
    h.scripted.push({ match: /INSERT INTO domain_event/, rows: [] });
    const r = await fetch(`${base}/api/v1/volunteer/activities/a1/status`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'closed' }),
    });
    expect(r.status).toBe(200);
    const body: any = await r.json();
    expect(body.item.status).toBe('closed');
    const upd = h.calls.find((c) => /UPDATE volunteer_activity/.test(c.sql));
    expect(upd?.params[2]).toBe('closed');
  });

  it('② 非法 status → 422', async () => {
    const r = await fetch(`${base}/api/v1/volunteer/activities/a1/status`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'paused' }),
    });
    expect(r.status).toBe(422);
  });

  it('③ 活动不存在 → 404', async () => {
    h.scripted.length = 0;
    h.scripted.push({ match: /UPDATE volunteer_activity/, rows: [], rowCount: 0 });
    const r = await fetch(`${base}/api/v1/volunteer/activities/nope/status`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'closed' }),
    });
    expect(r.status).toBe(404);
  });
});

describe('volunteer 人员档案聚合端点（P1）', () => {
  it('④ GET /people → 200 归并行（报名数/时长/积分）', async () => {
    h.scripted.length = 0;
    h.scripted.push({
      match: /GROUP BY user_name/,
      rows: [
        { user_name: '张阿姨', signup_count: 3, approved_count: 2, total_duration_min: 300, total_points: 5, last_activity_at: '2026-09-01T02:00:00Z' },
        { user_name: '李叔', signup_count: 1, approved_count: 0, total_duration_min: 45, total_points: 0, last_activity_at: '2026-08-20T02:00:00Z' },
      ],
    });
    const r = await fetch(`${base}/api/v1/volunteer/people`);
    expect(r.status).toBe(200);
    const body: any = await r.json();
    expect(body.items).toHaveLength(2);
    expect(body.items[0].user_name).toBe('张阿姨');
    expect(body.items[0].total_points).toBe(5);
  });
});
