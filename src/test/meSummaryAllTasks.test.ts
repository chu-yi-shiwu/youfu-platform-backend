// 工作台统计必须覆盖四类个人任务：维修 / 巡检 / 运送 / 能耗。
//
// 这个测试守两条线：
//   1. /open/me/summary 必须对四张表都发出计数查询，不能只查 work_orders；
//   2. 四类任务的活跃/成功/终态集合与完成时间字段必须显式固定，
//      今日边界必须使用 Asia/Shanghai 本地日，不能依赖 CURRENT_DATE / 数据库默认时区。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

const h = vi.hoisted(() => ({
  captured: [] as Array<{ text: string; params: unknown[] }>,
  rows: {
    work_order: { active_count: 1, done_count: 3, today_done: 1, today_new: 2 },
    inspection: { active_count: 2, done_count: 3, today_done: 1, today_new: 1 },
    transport: { active_count: 1, done_count: 3, today_done: 1, today_new: 1 },
    energy: { active_count: 2, done_count: 3, today_done: 1, today_new: 0 },
  },
}));

vi.mock('../db/pool.js', () => ({
  default: { query: async () => ({ rows: [], rowCount: 0 }) },
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) =>
    fn({
      query: async (text: string, params: unknown[] = []) => {
        h.captured.push({ text, params });
        if (text.includes('SELECT DISTINCT def_version')) return { rows: [], rowCount: 0 };
        if (text.includes('FROM workflow_def')) return { rows: [], rowCount: 0 };
        if (text.includes('FROM worker WHERE tenant_id')) {
          return {
            rows: [{ id: 'w-1', name: '统计师傅', skill_tags: ['repair'], load: 0, active: true }],
            rowCount: 1,
          };
        }
        if (text.includes('FROM work_orders')) return { rows: [h.rows.work_order], rowCount: 1 };
        if (text.includes('FROM inspection_task')) return { rows: [h.rows.inspection], rowCount: 1 };
        if (text.includes('FROM transport_order')) return { rows: [h.rows.transport], rowCount: 1 };
        if (text.includes('FROM business_flow_tasks')) return { rows: [h.rows.energy], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    }),
}));

import { authMiddleware, signJwt, __setAuthModeForTest } from '../middleware/auth.js';
import workOrderRouter from '../routes/workOrder.js';

describe('GET /api/v1/open/me/summary 四类任务全覆盖', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    __setAuthModeForTest?.('dev');
    const app = express();
    app.use(express.json());
    app.use(authMiddleware);
    app.use((req, _res, next) => {
      (req as unknown as { res: { locals: Record<string, unknown> } }).res.locals.auth = {
        tenantId: 't-stats', userId: 'u-1', role: 'worker', perms: [],
      };
      next();
    });
    app.use('/api/v1', workOrderRouter);
    app.use(errorMiddleware);
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  const call = async () => {
    h.captured.length = 0;
    const tok = signJwt(
      { tid: 't-stats', sub: 'u-1', role: 'worker', exp: Math.floor(Date.now() / 1000) + 600 },
      'status-vocab-secret',
    );
    const res = await fetch(`${base}/api/v1/open/me/summary`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    expect(res.status).toBe(200);
    return res.json() as Promise<any>;
  };

  it('四张表全部参与统计，总数等于四类之和', async () => {
    const body = await call();
    expect(body.stats).toEqual({
      active_count: 6,
      done_count: 12,
      today_done: 4,
      today_new: 4,
    });
    expect(body.stats_by_type).toEqual({
      work_order: h.rows.work_order,
      inspection_task: h.rows.inspection,
      transport_task: h.rows.transport,
      energy_task: h.rows.energy,
    });
  });

  it('巡检/运送/能耗各自使用明确的活跃、成功、终态集合', async () => {
    await call();
    const inspection = h.captured.find((c) => c.text.includes('FROM inspection_task'))!;
    const transport = h.captured.find((c) => c.text.includes('FROM transport_order'))!;
    const energy = h.captured.find((c) => c.text.includes('FROM business_flow_tasks'))!;
    expect(inspection).toBeTruthy();
    expect(transport).toBeTruthy();
    expect(energy).toBeTruthy();

    expect(inspection.params[2]).toEqual(['pending', 'in_progress']);
    expect(inspection.params[3]).toEqual(['done']);
    expect(inspection.params[4]).toEqual(['done', 'exception', 'cancelled']);

    expect(transport.params[2]).toEqual(['pending', 'assigned', 'transporting']);
    expect(transport.params[3]).toEqual(['done']);
    expect(transport.params[4]).toEqual(['done', 'exception', 'cancelled']);

    expect(energy.params[1]).toBe('youfu:w-1');
    expect(energy.params[2]).toBe('w-1');
    expect(energy.params[3]).toEqual(['created', 'dispatched', 'in_progress']);
    expect(energy.params[4]).toEqual(['submitted', 'reviewed', 'archived']);
    expect(energy.params[5]).toEqual(['submitted', 'reviewed', 'archived', 'cancelled']);
  });

  it('今日边界显式使用 Asia/Shanghai，完成时间按业务字段固定', async () => {
    await call();
    const workOrder = h.captured.find((c) => c.text.includes('FROM work_orders') && c.text.includes('AS today_done'))!;
    const inspection = h.captured.find((c) => c.text.includes('FROM inspection_task'))!;
    const transport = h.captured.find((c) => c.text.includes('FROM transport_order'))!;
    const energy = h.captured.find((c) => c.text.includes('FROM business_flow_tasks'))!;

    for (const q of [workOrder, inspection, transport, energy]) {
      expect(q.text).toContain("(now() AT TIME ZONE 'Asia/Shanghai')::date");
      expect(q.text).not.toContain('CURRENT_DATE');
    }
    expect(workOrder.text).toContain("COALESCE(completed_at, rated_at, updated_at) AT TIME ZONE 'Asia/Shanghai'");
    expect(inspection.text).toContain("done_at AT TIME ZONE 'Asia/Shanghai'");
    expect(transport.text).toContain("COALESCE(sign_at, arrive_at, updated_at) AT TIME ZONE 'Asia/Shanghai'");
    expect(energy.text).toContain("COALESCE((NULLIF(data->>'submitted_at', ''))::timestamptz, updated_at) AT TIME ZONE 'Asia/Shanghai'");
  });
});
