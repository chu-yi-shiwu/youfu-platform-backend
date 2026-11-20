// 巡检计划调度器必须显式 system 作用域（2026-11-15 主站同步实测）
//
// 现象：主站 youfu-backend 日志每分钟出现：
//   [scheduler] tenant t-verification due-plan run failed:
//   AppError: withTenantClient 缺少 auth context：系统/公开任务必须显式传入 { system: true }
// 根因：runDuePlansForTenant 直接 withTenantClient(tenantId, fn)，没有第三参 opts；
//   调度器没有请求级 ALS 上下文，于是每次 tick 都 500，到期巡检计划永不生成。
// 修复：与 slaScheduler 的 withSchedulerTenant 同口径，显式 { system: true }。
//
// 为什么之前测试没拦住：inspection.http.test.ts 的 withTenantClient mock 忽略 opts，
// 只在请求上下文里跑，覆盖不到“无 auth context 的系统任务”。
import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({
  opts: [] as unknown[],
}));

vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tid: string, fn: (c: unknown) => unknown, opts?: unknown) => {
    h.opts.push(opts);
    return fn({
      query: async (text: string) => {
        // 计划查询返回 0 条；其它查询返回空结果
        if (text.includes('FROM inspection_plan')) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      },
    });
  },
  default: { query: async () => ({ rows: [], rowCount: 0 }), connect: async () => { throw new Error('no real pool'); } },
  assertSafeTenantId: (t: string) => t,
}));

import { runDuePlansForTenant } from '../routes/inspection.js';

describe('runDuePlansForTenant 系统作用域', () => {
  it('必须传 { system: true }（否则无 ALS 上下文的调度器 500）', async () => {
    h.opts.length = 0;
    const n = await runDuePlansForTenant('t-scheduler');
    expect(n).toBe(0);
    expect(h.opts).toHaveLength(1);
    expect(h.opts[0]).toEqual({ system: true });
  });
});
