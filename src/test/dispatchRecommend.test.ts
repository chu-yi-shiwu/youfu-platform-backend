// R21-002：dispatchRecommend 纯函数回归测试（DMR 可解释派单推荐，确定性评分）。
// 全部纯函数，脱离 PG 真测，覆盖：技能匹配 / 同根前缀 / 综合评分排序 / 限额 / 兜底。
import { describe, it, expect } from 'vitest';
import { hasSkill, buildRecommend, commonPrefixLen } from '../services/dispatchRecommend.js';

describe('dispatchRecommend.hasSkill', () => {
  it('分类名包含 tag → true', () => {
    expect(hasSkill('空调维修', ['空调'])).toBe(true);
  });

  it('分类名不含 tag 且 tag 不匹配 → false', () => {
    // 'electric' 与中文分类名无子串/同根关系
    expect(hasSkill('空调维修', ['electric'])).toBe(false);
  });

  it('同根前缀 >=4 → true（plumber/plumbing）', () => {
    expect(hasSkill('plumbing', ['plumber'])).toBe(true);
  });

  it('通用词不构成特征命中（除非分类名即该词）', () => {
    expect(hasSkill('会议室', ['维修'])).toBe(false); // 通用词且分类名非"维修"
    expect(hasSkill('维修', ['维修'])).toBe(true); // 分类名即通用词 → 命中
  });

  it('空分类 / 非数组 tags → false', () => {
    expect(hasSkill('', ['x'])).toBe(false);
    expect(hasSkill('空调', null as unknown as string[])).toBe(false);
  });
});

describe('dispatchRecommend.commonPrefixLen', () => {
  it('同根前缀长度', () => {
    expect(commonPrefixLen('plumber', 'plumbing')).toBe(5); // 'plumb'
    expect(commonPrefixLen('abc', 'xyz')).toBe(0);
  });
});

describe('dispatchRecommend.buildRecommend', () => {
  const workers = [
    { id: 'w1', name: '甲', skill_tags: ['空调'], load: 2 },
    { id: 'w2', name: '乙', skill_tags: ['水电'], load: 10 },
    { id: 'w3', name: '丙', skill_tags: ['空调'], load: 1 },
  ];

  it('技能命中优先 + 负载归一：同技能下低负载更高分', () => {
    const rec = buildRecommend(workers as never[], '空调维修', 5);
    expect(rec[0].worker_id).toBe('w3'); // 命中空调且 load 最低
    const w1 = rec.find((r) => r.worker_id === 'w1')!;
    expect(rec[0].score).toBeGreaterThan(w1.score);
  });

  it('无工人 → 空数组', () => {
    expect(buildRecommend([], '空调')).toHaveLength(0);
  });

  it('limit 截断生效', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `w${i}`,
      name: `n${i}`,
      skill_tags: ['x'],
      load: i,
    }));
    expect(buildRecommend(many as never[], 'xx', 3)).toHaveLength(3);
  });

  it('技能未命中 → 仍按负载排序兜底', () => {
    const rec = buildRecommend(workers as never[], '未知分类');
    expect(rec[0].worker_id).toBe('w3'); // 最低负载优先
    expect(rec[0].skill_tags).not.toContain('未知分类');
  });

  it('评分结构：技能命中 60 + 负载归一 40', () => {
    const rec = buildRecommend(workers as never[], '空调维修', 5);
    const w3 = rec.find((r) => r.worker_id === 'w3')!;
    // 命中(60) + 40*(1-1/10)=36 → 96
    expect(w3.score).toBe(96);
  });
});
