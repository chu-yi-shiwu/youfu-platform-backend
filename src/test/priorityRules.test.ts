// 报修优先级预填规则单测（2026-09-06）
// 覆盖：规则矩阵命中（urgent）、普通类目不升档、用户显式优先、
//       优先级决策链 source 留痕、陪检/运送类目排除、规则表结构红线。
import { describe, it, expect } from 'vitest';
import {
  PRIORITY_RULES,
  EXCLUDED_CATEGORY_KEYWORDS,
  DEFAULT_PRIORITY,
  isExcludedCategory,
  matchPriorityRule,
  resolvePrefillPriority,
} from '../services/priorityRules.js';
import { inferPriority } from '../services/intakeEnrich.js';

describe('规则表结构红线', () => {
  it('规则表只做 urgent 升档，绝无降档规则', () => {
    for (const r of PRIORITY_RULES) expect(r.priority).toBe('urgent');
  });
  it('陪检/运送类目关键词绝不出现在预填规则表（另一条业务线，硬红线）', () => {
    const allKw = PRIORITY_RULES.flatMap((r) => r.keywords);
    for (const banned of ['陪检', '转科', '护送', '运送', '转运', 'CT', 'X线', 'X光']) {
      expect(allKw.some((k) => k.includes(banned))).toBe(false);
    }
  });
  it('排除清单包含陪检/转科/CT类/X线类', () => {
    for (const must of ['陪检', '转科', 'CT', 'X线']) {
      expect(EXCLUDED_CATEGORY_KEYWORDS).toContain(must);
    }
  });
  it('默认优先级为 normal（历史 97.9% 为一般，不激进升档）', () => {
    expect(DEFAULT_PRIORITY).toBe('normal');
  });
  it('每条规则都有 id / keywords / note（可审计可从 JSON 灌入）', () => {
    for (const r of PRIORITY_RULES) {
      expect(r.id).toBeTruthy();
      expect(r.keywords.length).toBeGreaterThan(0);
      expect(r.note).toBeTruthy();
    }
  });
});

describe('matchPriorityRule（描述 + 类目双通道）', () => {
  it('描述命中：跳闸/断电/停电 → urgent', () => {
    for (const desc of ['三楼配电箱跳闸了', '整层办公室断电', '住院部停电请快点来']) {
      expect(matchPriorityRule(desc)?.priority).toBe('urgent');
    }
  });
  it('描述命中：电梯困人 → urgent', () => {
    expect(matchPriorityRule('住院部电梯困人，有人被关')?.priority).toBe('urgent');
  });
  it('描述命中：漏水 → urgent（含空调漏水，历史一致）', () => {
    expect(matchPriorityRule('病房漏水')?.priority).toBe('urgent');
    expect(matchPriorityRule('空调漏水，滴到走廊了')?.priority).toBe('urgent');
  });
  it('类目名命中：类目"跳闸断电"/"医用气体"本身即可触发', () => {
    expect(matchPriorityRule('', '跳闸断电')?.ruleId).toBe('power_trip');
    expect(matchPriorityRule('', '氧气供应')?.ruleId).toBe('medical_gas');
    expect(matchPriorityRule('', '设备带维修')?.ruleId).toBe('medical_gas');
  });
  it('医用气体：氧气/送氧/负压/设备带 → urgent', () => {
    for (const desc of ['病房氧气终端没气了', 'ICU 送氧压力不足', '负压吸引故障', '床头设备带坏了']) {
      expect(matchPriorityRule(desc)?.ruleId).toBe('medical_gas');
    }
  });
  it('普通类目/描述不命中：灯具、马桶堵塞、缺墨 → null', () => {
    expect(matchPriorityRule('灯不亮了')).toBeNull();
    expect(matchPriorityRule('马桶堵了')).toBeNull();
    expect(matchPriorityRule('打印机缺墨，请换墨盒', '缺墨')).toBeNull();
  });
  it('排除类目整体不参与：类目名含陪检/转科/CT/X线 → null', () => {
    expect(matchPriorityRule('病房漏水', 'CT检查陪检')).toBeNull();
    expect(matchPriorityRule('病人转科需要护送', '转科运送')).toBeNull();
    expect(matchPriorityRule('', 'X线设备维修')).toBeNull();
  });
});

describe('resolvePrefillPriority（决策链：user > rule > llm > fallback > default）', () => {
  it('用户显式 priority 完全尊重，即使描述命中规则也以用户为准', () => {
    const r = resolvePrefillPriority({
      userPriority: 'normal',
      llmPriority: 'urgent',
      description: '电梯困人了',
      catalogName: null,
    });
    expect(r.priority).toBe('normal');
    expect(r.source).toBe('user');
  });
  it('规则命中优先于 LLM（临床/安全场景不让 LLM 降档）', () => {
    const r = resolvePrefillPriority({
      llmPriority: 'normal',
      description: '三楼跳闸',
      catalogName: null,
    });
    expect(r.priority).toBe('urgent');
    expect(r.source).toBe('rule');
    expect(r.ruleId).toBe('power_trip');
    expect(r.matchedKeyword).toBe('跳闸');
  });
  it('规则未命中时采纳 LLM 值（source=llm）', () => {
    const r = resolvePrefillPriority({
      llmPriority: 'urgent',
      description: '灯不亮了',
      catalogName: '灯具',
    });
    expect(r.priority).toBe('urgent');
    expect(r.source).toBe('llm');
  });
  it('LLM 非法值不采纳，回落 fallback（legacy inferPriority 结果）', () => {
    const r = resolvePrefillPriority({
      llmPriority: 'high!!',
      description: '灯不亮了',
      catalogName: null,
      fallbackPriority: 'normal',
    });
    expect(r.priority).toBe('normal');
    expect(r.source).toBe('default');
  });
  it('全链路无命中 → normal/default', () => {
    const r = resolvePrefillPriority({ description: '办公室门把手松了', catalogName: '门窗' });
    expect(r.priority).toBe('normal');
    expect(r.source).toBe('default');
  });
});

describe('inferPriority（挂载预填规则矩阵后的扩展签名）', () => {
  it('跳闸/断电/电梯困人/漏水/氧气 → urgent', () => {
    for (const desc of ['配电箱跳闸', '宿舍断电', '电梯困人了', '洗手间漏水', '氧气瓶没气了']) {
      expect(inferPriority(desc)).toBe('urgent');
    }
  });
  it('类目名参与匹配：描述含糊但类目明确 → urgent', () => {
    expect(inferPriority('病房这边出问题了，快来看看', '医用气体')).toBe('urgent');
  });
  it('旧关键词推断逻辑不受影响：断电→urgent、保养→low、灯不亮→normal', () => {
    expect(inferPriority('办公室断电了')).toBe('urgent');
    expect(inferPriority('空调保养预约')).toBe('low');
    expect(inferPriority('灯不亮')).toBe('normal');
  });
  it('旧调用点（单参数）行为兼容：普通描述仍 normal', () => {
    expect(inferPriority('门禁刷不开')).toBe('normal');
  });
});

describe('isExcludedCategory', () => {
  it('命中排除清单（大小写不敏感）', () => {
    expect(isExcludedCategory('陪检服务')).toBe(true);
    expect(isExcludedCategory('ct检查运送')).toBe(true);
    expect(isExcludedCategory('X线类')).toBe(true);
  });
  it('普通类目不排除；空值安全', () => {
    expect(isExcludedCategory('灯具维修')).toBe(false);
    expect(isExcludedCategory(null)).toBe(false);
    expect(isExcludedCategory(undefined)).toBe(false);
    expect(isExcludedCategory('')).toBe(false);
  });
});
