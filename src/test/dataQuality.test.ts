// T-C / C2 数据质量治理纯函数单测（脱离 PG）。
import { describe, it, expect } from 'vitest';
import { validateEvent, validateOrder, assessQuality } from '../services/dataQuality.js';

describe('validateEvent', () => {
  it('干净事件无问题', () => {
    const issues = validateEvent({
      entity_type: 'work_order', entity_id: 'wo-1', type: 'create',
      created_at: '2026-08-16T00:00:00Z', payload: { a: 1 },
    });
    expect(issues).toHaveLength(0);
  });

  it('缺失 entity_id / 未知类型 / 未来时间戳 触发问题', () => {
    const issues = validateEvent({
      entity_type: 'unknown_thing', entity_id: null, type: 'frobnicate',
      created_at: '2099-01-01T00:00:00Z', payload: null,
    });
    const problems = issues.map((i) => i.problem);
    expect(problems).toContain('缺失 entity_id');
    expect(problems).toContain('未知/缺失实体类型');
    expect(problems).toContain('未知/缺失事件类型');
    expect(problems).toContain('未来时间戳');
    expect(problems).toContain('空 payload');
  });
});

describe('validateOrder', () => {
  it('缺失 business_type 触发问题（模型维度缺失，正是 n3 要封死的）', () => {
    const issues = validateOrder({ id: 'wo-2', business_type: null, created_at: '2026-08-16T00:00:00Z' });
    expect(issues.map((i) => i.problem)).toContain('缺失 business_type（模型维度缺失）');
  });

  it('SLA 早于创建时间触发问题', () => {
    const issues = validateOrder({
      id: 'wo-3', business_type: 'electric',
      created_at: '2026-08-16T00:00:00Z', sla_due_at: '2026-08-15T00:00:00Z',
    });
    expect(issues.map((i) => i.problem)).toContain('SLA 截止早于创建时间');
  });
});

describe('assessQuality', () => {
  it('全干净数据评分 1.0', () => {
    const r = assessQuality(
      [{ entity_type: 'work_order', entity_id: 'a', type: 'create', created_at: '2026-08-16T00:00:00Z', payload: {} }],
      [{ id: 'wo-1', business_type: 'electric', created_at: '2026-08-16T00:00:00Z' }],
    );
    expect(r.score).toBe(1);
    expect(r.total).toBe(2);
  });

  it('无数据返回 1.0 + note 不编造', () => {
    const r = assessQuality([], []);
    expect(r.score).toBe(1);
    expect(r.note).toContain('不编造');
  });

  it('问题计入 by_type 且评分<1', () => {
    const r = assessQuality(
      [{ entity_type: 'work_order', entity_id: null, type: 'create', created_at: '2026-08-16T00:00:00Z', payload: {} }],
      [{ id: 'wo-1', business_type: null, created_at: '2026-08-16T00:00:00Z' }],
    );
    expect(r.score).toBeLessThan(1);
    expect(r.by_type['缺失 entity_id']).toBe(1);
    expect(r.by_type['缺失 business_type（模型维度缺失）']).toBe(1);
  });

  it('单实体多问题不会让评分变负值（钳制到 [0,1]）', () => {
    // 1 条事件缺 entity_id + 未知类型 + 空 payload + 未来时间戳 = 4 条 issue
    const r = assessQuality(
      [{ entity_type: 'unknown_thing', entity_id: null, type: 'frobnicate', created_at: '2099-01-01T00:00:00Z', payload: null }],
      [],
    );
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.score).toBe(0); // 1 实体 4 问题 → 1 - 4/1 钳到 0
  });

  it('格式不可解析的日期被标记（不再静默放过）', () => {
    const issues = validateEvent({
      entity_type: 'work_order', entity_id: 'a', type: 'create',
      created_at: 'not-a-date', payload: {},
    });
    expect(issues.map((i) => i.problem)).toContain('日期格式不可解析');
  });
});
