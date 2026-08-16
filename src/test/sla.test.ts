import { describe, it, expect } from 'vitest';
import { resolveSlaMinutes, setSlaDueAt, slaScan, type SlaScanRow } from '../engine/sla.js';
import type { WorkOrderStatus } from '../engine/stateMachine.js';

describe('sla.resoleSlaMinutes', () => {
  it('电工紧急=30 一般=240', () => {
    expect(resolveSlaMinutes('electrician', 'urgent')).toBe(30);
    expect(resolveSlaMinutes('electrician', 'normal')).toBe(240);
  });
  it('标本紧急=15', () => {
    expect(resolveSlaMinutes('specimen', 'urgent')).toBe(15);
  });
  it('未知目录兜底一般维修 240', () => {
    expect(resolveSlaMinutes(undefined, 'normal')).toBe(240);
    expect(resolveSlaMinutes('zzz', 'urgent')).toBe(30);
  });
});

describe('sla.setSlaDueAt', () => {
  it('截止 = now + 时限分钟', () => {
    const now = new Date('2026-08-13T10:00:00Z');
    const { slaMinutes, dueAt } = setSlaDueAt('electrician', 'urgent', now);
    expect(slaMinutes).toBe(30);
    expect(dueAt.getTime()).toBe(now.getTime() + 30 * 60_000);
  });
});

describe('sla.slaScan', () => {
  const base = (over: Partial<SlaScanRow> = {}): SlaScanRow => ({
    id: 'wo1', status: 'assigned', sla_due_at: null, escalated_at: null, ...over,
  });
  const now = new Date('2026-08-13T12:00:00Z');

  it('已到期未升级且活跃 → 命中', () => {
    const rows = [base({ sla_due_at: new Date('2026-08-13T11:00:00Z') })];
    const hits = slaScan(rows, now);
    expect(hits).toHaveLength(1);
    expect(hits[0].workOrderId).toBe('wo1');
    expect(hits[0].escalMinutes).toBe(60);
  });

  it('未到期 → 不命中', () => {
    const rows = [base({ sla_due_at: new Date('2026-08-13T12:30:00Z') })];
    expect(slaScan(rows, now)).toHaveLength(0);
  });

  it('已升级 → 不重复命中', () => {
    const rows = [base({ sla_due_at: new Date('2026-08-13T11:00:00Z'), escalated_at: new Date('2026-08-13T11:01:00Z') })];
    expect(slaScan(rows, now)).toHaveLength(0);
  });

  it('completed 态不计时 → 不命中', () => {
    const rows = [base({ status: 'completed' as WorkOrderStatus, sla_due_at: new Date('2026-08-13T11:00:00Z') })];
    expect(slaScan(rows, now)).toHaveLength(0);
  });

  it('无 sla_due_at（claim_hall 兜底）→ 不命中', () => {
    const rows = [base({ sla_due_at: null })];
    expect(slaScan(rows, now)).toHaveLength(0);
  });
});
