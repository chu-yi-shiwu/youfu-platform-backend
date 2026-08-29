// R21-002：dataQuality 纯函数回归测试（C2 数据质量治理 gate，共振防脏数据喂模型的核心）。
// 全部纯函数，脱离 PG 真测，覆盖：事件校验 / 工单校验 / 综合评分 / 录入端轻闸门。
import { describe, it, expect } from 'vitest';
import {
  validateEvent,
  validateOrder,
  assessQuality,
  validateIntake,
} from '../services/dataQuality.js';

const nowIso = new Date().toISOString();

describe('dataQuality.validateEvent', () => {
  it('已知类型 + 完整字段 → 无问题', () => {
    const issues = validateEvent({
      entity_type: 'work_order',
      entity_id: 'x',
      type: 'create',
      created_at: nowIso,
      payload: {},
    });
    expect(issues).toHaveLength(0);
  });

  it('未知实体类型 / 缺失 entity_id / 未知类型 / 空 payload → 各自报 issue', () => {
    const issues = validateEvent({
      entity_type: 'ghost',
      entity_id: null,
      type: 'bogus',
      payload: null,
    });
    const fields = issues.map((i) => i.field);
    expect(fields).toContain('entity_type');
    expect(fields).toContain('entity_id');
    expect(fields).toContain('type');
    expect(fields).toContain('payload');
  });

  it('未来时间戳 → 报 issue', () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const issues = validateEvent({
      entity_type: 'work_order',
      entity_id: 'x',
      type: 'create',
      created_at: future,
      payload: {},
    });
    expect(issues.some((i) => i.field === 'created_at')).toBe(true);
  });

  it('不可解析日期 → 报 issue', () => {
    const issues = validateEvent({
      entity_type: 'work_order',
      entity_id: 'x',
      type: 'create',
      created_at: 'not-a-date',
      payload: {},
    });
    expect(issues.some((i) => i.field === 'created_at')).toBe(true);
  });
});

describe('dataQuality.validateOrder', () => {
  it('缺失 business_type → issue（模型维度缺失）', () => {
    expect(validateOrder({ id: 'w1' }).some((i) => i.field === 'business_type')).toBe(true);
  });

  it('SLA 截止早于创建 → issue', () => {
    const issues = validateOrder({
      id: 'w2',
      business_type: 'repair',
      sla_due_at: '2020-01-01T00:00:00Z',
      created_at: '2020-01-02T00:00:00Z',
    });
    expect(issues.some((i) => i.field === 'sla_due_at')).toBe(true);
  });

  it('合法工单 → 无 issue', () => {
    expect(
      validateOrder({
        id: 'w3',
        business_type: 'repair',
        sla_due_at: '2020-01-02T00:00:00Z',
        created_at: '2020-01-01T00:00:00Z',
      }),
    ).toHaveLength(0);
  });
});

describe('dataQuality.assessQuality', () => {
  it('无数据 → score=1 + note 不编造', () => {
    const r = assessQuality([], []);
    expect(r.score).toBe(1);
    expect(r.note).toContain('无数据');
  });

  it('全合法 → score=1', () => {
    const r = assessQuality(
      [
        {
          entity_type: 'work_order',
          entity_id: 'x',
          type: 'create',
          created_at: nowIso,
          payload: {},
        },
      ],
      [{ id: 'w1', business_type: 'repair' }],
    );
    expect(r.score).toBe(1);
  });

  it('有脏数据 → score<1 且 by_type 计数', () => {
    const r = assessQuality(
      [{ entity_type: 'ghost', entity_id: null, type: 'bogus', payload: null }],
      [{ id: 'w1' }],
    );
    expect(r.score).toBeLessThan(1);
    expect(r.by_type['缺失 entity_id']).toBeGreaterThanOrEqual(1);
  });
});

describe('dataQuality.validateIntake', () => {
  it('空标题 → 硬拒（ok=false）', () => {
    expect(validateIntake({ title: '' }).ok).toBe(false);
  });

  it('标题过短 / 超长 → 硬拒', () => {
    expect(validateIntake({ title: 'ab' }).ok).toBe(false);
    expect(validateIntake({ title: 'x'.repeat(121) }).ok).toBe(false);
  });

  it('合法标题 + 缺失位置 → ok=true 但 warning', () => {
    const q = validateIntake({ title: '三楼空调不制冷', location: '' });
    expect(q.ok).toBe(true);
    expect(q.warnings.some((w) => w.field === 'location')).toBe(true);
  });

  it('非法电话 → 仅 warning 不硬拒（防误伤分机号）', () => {
    const q = validateIntake({ title: '空调故障', reporter_phone: '123' });
    expect(q.ok).toBe(true);
    expect(q.warnings.some((w) => w.field === 'phone')).toBe(true);
  });

  it('去噪：控制字符 / 多空格 → normalized_title 干净', () => {
    const q = validateIntake({ title: '  三楼\t空调  不制冷  ' });
    expect(q.normalized_title).toBe('三楼 空调 不制冷');
  });

  it('术语联想 → 命中给 warning 建议规范标题', () => {
    const q = validateIntake({ title: '办公室空调不冷' });
    expect(q.warnings.some((w) => w.field === 'title')).toBe(true);
  });
});
