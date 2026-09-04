// AL-003 修复回归：businessTypeForCategory 中文分类 → 派单 business_type 映射
// 事故锚点：空调单曾因硬编码 'repair' 派给电工（对齐审查 2026-09-04）
import { describe, it, expect } from 'vitest';
import { businessTypeForCategory } from '../services/intakeEnrich.js';

describe('businessTypeForCategory（AL-003 技能派单接线）', () => {
  it('分类名权威优先：空调维修 → hvac（不被描述里其他词带偏）', () => {
    expect(businessTypeForCategory('空调维修', '空调不制冷还漏水')).toBe('hvac');
  });
  it('分类名未中时用描述兜底：无分类「马桶堵了」→ plumbing', () => {
    expect(businessTypeForCategory(null, '马桶堵了')).toBe('plumbing');
  });
  it('电梯困人 → elevator', () => {
    expect(businessTypeForCategory('电梯维保', '3号电梯困人')).toBe('elevator');
  });
  it('照明 → lighting（宽泛「电」字不得截胡更具体的「灯」）', () => {
    expect(businessTypeForCategory(null, '走廊灯不亮')).toBe('lighting');
  });
  it('纯电气 → electric', () => {
    expect(businessTypeForCategory(null, '办公室插座跳闸')).toBe('electric');
  });
  it('网络/IT → network', () => {
    expect(businessTypeForCategory(null, '会议室投影仪无法开机')).toBe('network');
  });
  it('全不中回落 repair（负载均衡兜底池，保持旧行为）', () => {
    expect(businessTypeForCategory('其他', '桌椅松动')).toBe('repair');
    expect(businessTypeForCategory(null, null)).toBe('repair');
  });
});
