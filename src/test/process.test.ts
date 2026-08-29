import { describe, it, expect } from 'vitest';
import { calcRates, calcSlaRate, bucketDuration } from '../repo/stats.js';

// B2 过程挖掘度量层：纯函数单测（脱离 PG，验证聚合逻辑正确性）
describe('B2 process metrics pure functions', () => {
  it('calcRates: 空数据返回 0；正常数据计算命中率/转派率', () => {
    expect(calcRates(0, 0, 0)).toEqual({ dispatch_hit_rate: 0, reassign_rate: 0 });
    expect(calcRates(10, 7, 2)).toEqual({ dispatch_hit_rate: 0.7, reassign_rate: 0.2 });
  });

  it('calcSlaRate: 无 SLA 配置返回 0 且 note 标注不编造', () => {
    const r = calcSlaRate(0, 0);
    expect(r.sla_rate).toBe(0);
    expect(r.sla_note).toContain('无数据');
  });

  it('calcSlaRate: 有 SLA 配置计算达成率', () => {
    expect(calcSlaRate(10, 8).sla_rate).toBe(0.8);
    expect(calcSlaRate(10, 8).sla_note).toContain('10');
  });

  it('bucketDuration: 时长分桶 [<60,60-240,240-1440,>1440] 正确', () => {
    const b = bucketDuration([10, 100, 500, 2000]);
    expect(b).toEqual({ lt_1h: 1, h1_4: 1, h4_24: 1, gt_24h: 1 });
  });
});
