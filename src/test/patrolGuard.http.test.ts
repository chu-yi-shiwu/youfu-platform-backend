// patrolGuard.http.test.ts —— P0-9 巡更执行面归属/权限守卫（HTTP 入口级）。
//
// 【修复前的真实洞】
//   POST /patrol/tasks/:id/checkin 与 /miss 没有任何权限/归属校验：
//   任意登录账号（含完全无关的 worker）都能给别人的巡更任务签到或标记漏签；
//   还能塞入不属于该任务的 point_id，把任务永久卡在 in_progress。
//
// 修复口径（与巡检/工单一致）：
//   worker → 必须是任务 assignee（token.sub → resolveWorkerIds 集合）；
//   非 worker → 需 patrol.manage（默认 admin/operator，租户可显式授予）。
//
// 本文件钉死：本人放行、他人 403 且不 UPDATE、无档案 403、operator 默认放行、
// reviewer 默认拒绝但授权后放行、跨任务 point_id 422。
//
// P0-9 读侧（2026-11-07 追加）：GET /tasks 与 GET /tasks/:id 此前同样对任意登录账号
// 开放，可拉全租户巡更任务（执行人、签到记录）。读侧口径与执行面一致：
//   worker → 列表强制本人档案集合（显式 assignee=他人 只作提示，被服务端覆盖）；
//            无档案返回空列表，绝不降级为全租户查询；详情仅本人名下单可读。
//   非 worker → 需 patrol.manage；授权后可按 assignee 过滤、可读详情。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

const T = 't-patrol';
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

const h = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
  workerRows: [] as Array<{ id: string }>,
  permRows: [] as Array<{ perm: string }>,
  task: {} as Record<string, unknown>,
  taskList: [] as Array<Record<string, unknown>>,
  updates: { n: 0 },
  calls: [] as Array<{ text: string; params?: unknown[] }>,
}));

vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tid: string, fn: (c: unknown) => unknown) => fn({
    query: async (text: string, params?: unknown[]) => {
      h.calls.push({ text, params });
      if (text.includes('SELECT * FROM patrol_task WHERE tenant_id=$1 AND id=$2')) {
        return { rows: [h.task], rowCount: 1 };
      }
      if (text.includes('SELECT * FROM patrol_task WHERE tenant_id = $1')) {
        return { rows: h.taskList, rowCount: h.taskList.length };
      }
      if (text.includes('SELECT id FROM worker WHERE tenant_id=$2')) {
        return { rows: h.workerRows, rowCount: h.workerRows.length };
      }
      if (text.includes('checkin_code=$2')) {
        // 默认：扫描码命中任务第一个点位；测试可通过 h.task 覆盖
        return { rows: [{ id: (h.task.point_ids as string[] | undefined)?.[0] ?? U1 }], rowCount: 1 };
      }
      if (text.includes('SELECT perm FROM role_permission')) {
        return { rows: h.permRows, rowCount: h.permRows.length };
      }
      if (text.includes("SELECT point_ids, checkins FROM patrol_task WHERE tenant_id=$1 AND status='missed'")) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('UPDATE patrol_task')) {
        h.updates.n += 1;
        return { rows: [{ ...h.task, status: 'in_progress' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  }),
  assertSafeTenantId: (t: string) => t,
  default: { query: async () => { throw new Error('[patrolGuard] 单测禁用真实 pool'); } },
}));

import patrolRouter from '../routes/patrol.js';

let server: Server;
let base = '';
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((_req: any, res: any, next: any) => {
    res.locals.auth = { tenantId: T, requestId: 'r-1', authMode: 'prod', ...h.auth };
    next();
  });
  app.use('/api/v1/patrol', patrolRouter);
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/patrol`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const post = (p: string, body: unknown) =>
  fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const get = (p: string) => fetch(base + p);

beforeEach(() => {
  h.workerRows = [];
  h.permRows = [];
  h.updates.n = 0;
  h.calls.length = 0;
  h.task = { id: 'pt-1', tenant_id: T, title: '夜巡', status: 'pending', assignee: 'W1', point_ids: [U1, U2], checkins: [] };
  h.auth = { userId: 'u-1', role: 'worker', username: 'w1' };
});

describe('P0-9 · 巡更 checkin/miss 归属与权限守卫', () => {
  it('① 本人 worker 扫码签到（code 命中任务点位）→ 200，且执行 UPDATE', async () => {
    h.workerRows = [{ id: 'W1' }];
    const r = await post('/tasks/pt-1/checkin', { code: 'SCAN0001' });
    expect(r.status).toBe(200);
    expect(h.updates.n).toBe(1);
    const checkin = JSON.parse(String(h.calls.find((c) => c.text.includes('UPDATE patrol_task'))?.params?.[3] ?? '[]'));
    expect(checkin[0]?.via).toBe('scan');
    // 并发防重：签到前必须行锁，避免 10 并发同点签到全部读到旧 checkins
    expect(h.calls.some((c) => c.text.includes('FROM patrol_task') && c.text.includes('FOR UPDATE'))).toBe(true);
  });

  it('② 他人 worker 签到 → 403，且不 UPDATE', async () => {
    h.workerRows = [{ id: 'W2' }];
    const r = await post('/tasks/pt-1/checkin', { code: 'SCAN0001' });
    expect(r.status).toBe(403);
    expect(h.updates.n).toBe(0);
  });

  it('③ worker 无档案（resolveWorkerIds 空）→ 403，绝不降级放行', async () => {
    h.workerRows = [];
    const r = await post('/tasks/pt-1/checkin', { code: 'SCAN0001' });
    expect(r.status).toBe(403);
    expect(h.updates.n).toBe(0);
  });

  it('④ operator 默认矩阵含 patrol.manage → 200（管理纠正路径保留，via=manual）', async () => {
    h.auth = { userId: 'u-op', role: 'operator', username: 'op' };
    const r = await post('/tasks/pt-1/checkin', { point_id: U1 });
    expect(r.status).toBe(200);
    expect(h.updates.n).toBe(1);
    const checkin = JSON.parse(String(h.calls.find((c) => c.text.includes('UPDATE patrol_task'))?.params?.[3] ?? '[]'));
    expect(checkin[0]?.via).toBe('manual');
  });

  it('⑤ reviewer 默认无 patrol.manage → 403；租户显式授权后 → 200', async () => {
    h.auth = { userId: 'u-rv', role: 'reviewer', username: 'rv' };
    const denied = await post('/tasks/pt-1/checkin', { point_id: U1 });
    expect(denied.status).toBe(403);
    expect(h.updates.n).toBe(0);

    h.permRows = [{ perm: 'patrol.manage' }];
    const ok = await post('/tasks/pt-1/checkin', { point_id: U1 });
    expect(ok.status).toBe(200);
    expect(h.updates.n).toBe(1);
  });

  it('⑥ point_id 不属于该任务（管理补签）→ 422，且不 UPDATE（防任务永久卡在 in_progress）', async () => {
    h.auth = { userId: 'u-op', role: 'operator', username: 'op' };
    const r = await post('/tasks/pt-1/checkin', { point_id: '33333333-3333-4333-8333-333333333333' });
    expect(r.status).toBe(422);
    expect(h.updates.n).toBe(0);
  });

  it('⑦ miss 同样受归属守卫：他人 worker → 403，且不 UPDATE', async () => {
    h.workerRows = [{ id: 'W2' }];
    const r = await post('/tasks/pt-1/miss', { note: '未到岗' });
    expect(r.status).toBe(403);
    expect(h.updates.n).toBe(0);
  });

  it('⑧ 漏洞回归：worker 只传 point_id（不扫码）→ 403 SCAN_REQUIRED，不 UPDATE', async () => {
    h.workerRows = [{ id: 'W1' }];
    const r = await post('/tasks/pt-1/checkin', { point_id: U1 });
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).code).toBe('SCAN_REQUIRED');
    expect(h.updates.n).toBe(0);
  });
});

describe('P0-9 读侧 · 巡更任务列表/详情可见性', () => {
  it('⑧ worker 列表强制本人档案集合：显式 assignee=他人 被忽略，SQL 只按本人过滤', async () => {
    h.workerRows = [{ id: 'W1' }];
    h.taskList = [{ id: 'pt-1', assignee: 'W1' }];
    const r = await get('/tasks?assignee=W2');
    expect(r.status).toBe(200);
    const body = await r.json() as { items: Array<Record<string, unknown>> };
    expect(body.items).toEqual([{ id: 'pt-1', assignee: 'W1' }]);

    const list = h.calls.find((c) => c.text.includes('FROM patrol_task') && c.text.includes('ORDER BY created_at DESC'));
    expect(list, 'worker 列表必须真的查了 patrol_task').toBeTruthy();
    expect(list!.text).toContain('assignee = ANY(');
    expect(list!.text).not.toContain('assignee = $2');
    expect(list!.params).toContainEqual(['W1']);
    expect(list!.params).not.toContain('W2');
  });

  it('⑨ worker 无档案 → 空列表，且绝不发全租户 patrol_task 查询', async () => {
    h.workerRows = [];
    h.taskList = [{ id: 'pt-secret', assignee: 'W9' }];
    const r = await get('/tasks');
    expect(r.status).toBe(200);
    const body = await r.json() as { items: unknown[] };
    expect(body.items).toEqual([]);
    expect(h.calls.some((c) => c.text.includes('FROM patrol_task'))).toBe(false);
    // 不走权限点：worker 的可见性由本人档案集合决定，不查 role_permission
    expect(h.calls.some((c) => c.text.includes('SELECT perm FROM role_permission'))).toBe(false);
  });

  it('⑩ reviewer 默认无 patrol.manage → 列表 403；显式授权后 200 且可按 assignee 过滤', async () => {
    h.auth = { userId: 'u-rv', role: 'reviewer', username: 'rv' };
    const denied = await get('/tasks');
    expect(denied.status).toBe(403);

    h.permRows = [{ perm: 'patrol.manage' }];
    h.taskList = [{ id: 'pt-2', assignee: 'W2' }];
    const ok = await get('/tasks?assignee=W2');
    expect(ok.status).toBe(200);
    const list = h.calls.find((c) => c.text.includes('FROM patrol_task') && c.text.includes('ORDER BY created_at DESC'));
    expect(list).toBeTruthy();
    expect(list!.text).toContain('assignee = $2');
    expect(list!.params).toContain('W2');
  });

  it('⑪ worker 详情：本人单 200；他人单 403', async () => {
    h.workerRows = [{ id: 'W1' }];
    h.task = { id: 'pt-1', tenant_id: T, status: 'pending', assignee: 'W1', point_ids: [U1], checkins: [] };
    const mine = await get('/tasks/pt-1');
    expect(mine.status).toBe(200);
    const body = await mine.json() as { item: Record<string, unknown> };
    expect(body.item.id).toBe('pt-1');

    h.task = { id: 'pt-2', tenant_id: T, status: 'pending', assignee: 'W2', point_ids: [U1], checkins: [] };
    const others = await get('/tasks/pt-2');
    expect(others.status).toBe(403);
  });

  it('⑫ worker 无档案读详情 → 403（不降级放行）', async () => {
    h.workerRows = [];
    h.task = { id: 'pt-1', tenant_id: T, status: 'pending', assignee: 'W1', point_ids: [U1], checkins: [] };
    const r = await get('/tasks/pt-1');
    expect(r.status).toBe(403);
  });

  it('⑬ operator 详情 200（管理纠正路径保留）', async () => {
    h.auth = { userId: 'u-op', role: 'operator', username: 'op' };
    h.task = { id: 'pt-2', tenant_id: T, status: 'pending', assignee: 'W2', point_ids: [U1], checkins: [] };
    const r = await get('/tasks/pt-2');
    expect(r.status).toBe(200);
  });

  it('⑭ reviewer 无授权读详情 → 403；授权后 → 200', async () => {
    h.auth = { userId: 'u-rv', role: 'reviewer', username: 'rv' };
    h.task = { id: 'pt-2', tenant_id: T, status: 'pending', assignee: 'W2', point_ids: [U1], checkins: [] };
    const denied = await get('/tasks/pt-2');
    expect(denied.status).toBe(403);

    h.permRows = [{ perm: 'patrol.manage' }];
    const ok = await get('/tasks/pt-2');
    expect(ok.status).toBe(200);
  });
});
