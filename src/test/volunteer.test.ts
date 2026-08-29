// R20-005 回归测试：volunteer 的 computeCheckout 纯函数（时长/积分计算）。
// 纯函数不依赖数据库，可在本地 Node 真跑。
import { describe, it, expect } from 'vitest';
import { computeCheckout } from '../routes/volunteer.js';

describe('computeCheckout', () => {
  it('正常 90 分钟 → 90 分钟, 1 积分', () => {
    const r = computeCheckout('2026-01-01T08:00:00Z', '2026-01-01T09:30:00Z');
    expect(r).toEqual({ duration_min: 90, points: 1 });
  });

  it('正好 60 分钟 → 60 分钟, 1 积分', () => {
    const r = computeCheckout('2026-01-01T08:00:00Z', '2026-01-01T09:00:00Z');
    expect(r).toEqual({ duration_min: 60, points: 1 });
  });

  it('120 分钟 → 120 分钟, 2 积分', () => {
    const r = computeCheckout('2026-01-01T08:00:00Z', '2026-01-01T10:00:00Z');
    expect(r).toEqual({ duration_min: 120, points: 2 });
  });

  it('不足 60 分钟 → 取整分钟, 0 积分', () => {
    const r = computeCheckout('2026-01-01T08:00:00Z', '2026-01-01T08:45:00Z');
    expect(r).toEqual({ duration_min: 45, points: 0 });
  });

  it('签退早于签到 → 0 分钟 0 积分（防御负值）', () => {
    const r = computeCheckout('2026-01-01T09:00:00Z', '2026-01-01T08:00:00Z');
    expect(r).toEqual({ duration_min: 0, points: 0 });
  });

  it('接受 Date 对象入参', () => {
    const r = computeCheckout(
      new Date('2026-01-01T08:00:00Z'),
      new Date('2026-01-01T10:30:00Z'),
    );
    expect(r).toEqual({ duration_min: 150, points: 2 });
  });
});
