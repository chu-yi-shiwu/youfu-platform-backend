// 巡检签到距离校验（防伪 L1）：haversine 球面距离
import { describe, it, expect } from 'vitest';

// 与 inspection.ts 内联实现保持一致（避免导出污染路由层）
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

describe('haversineM（巡检签到距离校验）', () => {
  it('同点距离为 0', () => {
    expect(haversineM(25.97, 113.42, 25.97, 113.42)).toBeLessThan(1);
  });
  it('约 1 度纬度 ≈ 111km', () => {
    const d = haversineM(25.0, 113.42, 26.0, 113.42);
    expect(d).toBeGreaterThan(110000);
    expect(d).toBeLessThan(112000);
  });
  it('几百米内 < 500m 阈值（不判疑似）', () => {
    const d = haversineM(25.97, 113.42, 25.9705, 113.4205);
    expect(d).toBeLessThan(500);
  });
  it('跨城 > 500m 阈值（判疑似）', () => {
    const d = haversineM(25.97, 113.42, 25.90, 113.50);
    expect(d).toBeGreaterThan(500);
  });
});
