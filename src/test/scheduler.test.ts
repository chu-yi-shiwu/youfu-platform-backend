import { describe, it, expect } from 'vitest';
import { localDateStr } from '../scheduler/modelTrainScheduler.js';
import { tryAcquireSchedulerLock, releaseSchedulerLock } from '../scheduler/lock.js';

describe('localDateStr（R17-001 时区口径修复）', () => {
  it('返回本地日期而非 UTC——跨时区日界不串', () => {
    // 构造一个本地=2026-08-29 但 UTC=2026-08-28 的时戳（东八区 03:00）
    // 修复前 lastRunDate 用 toISOString().slice(0,10) 会得到 '2026-08-28'，
    // 与 shouldRunNow 比较的本地 '2026-08-29' 不一致 → 同日重复训练。
    const d = new Date(2026, 7, 29, 3, 0, 0); // 注：月份 0-based，7=八月，本地时区解释
    const got = localDateStr(d);
    const localExpected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(got).toBe(localExpected);
    expect(got).toBe('2026-08-29');
    // 关键不变量：绝不返回 UTC 切片（东八区该时刻 UTC 是 2026-08-28）。
    // 该断言仅在 runner 时区 ≠ UTC 时可检验：UTC runner 上本地=UTC，got 与切片恒等。
    // CI（ubuntu-latest 为 UTC）自动跳过；东八区本地开发全量验证（CI 红 ×2 根因，#365）。
    if (d.getTimezoneOffset() !== 0) {
      expect(got).not.toBe(d.toISOString().slice(0, 10));
    }
  });

  it('普通时刻口径与本地 getFullYear/Month/Date 一致', () => {
    const d = new Date(2026, 0, 5, 12, 30, 0);
    expect(localDateStr(d)).toBe('2026-01-05');
  });
});

describe('调度器跨进程锁（R25-001）', () => {
  it('无可用 PG（单测环境）时优雅降级：tryAcquire 返回 true、release 不抛', async () => {
    // 单测无真实 PG，pool.connect 会失败；锁模块必须放行而非阻断，保证单进程语义不变。
    // （R31-F4 修复后：取锁走专用连接 pool.connect，取/放严格同连接。）
    const acquired = await tryAcquireSchedulerLock('inspection');
    expect(acquired).toBe(true);
    await expect(releaseSchedulerLock('inspection')).resolves.toBeUndefined();
  });

  it('未知调度器名不施加额外约束（直接放行）', async () => {
    expect(await tryAcquireSchedulerLock('does-not-exist')).toBe(true);
  });
});
