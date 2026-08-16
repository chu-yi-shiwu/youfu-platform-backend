import { describe, it, expect } from 'vitest';
import { applyRecommendationToDef, type OptimizationDecision } from '../services/optimizer.js';
import { DEFAULT_WORK_ORDER_DEF } from '../engine/stateMachine.js';

function wfDecision(target: string, recommendation: Record<string, unknown> = {}): OptimizationDecision {
  return { scope: 'workflow', target, recommendation, reason: 't' };
}

describe('applyRecommendationToDef (T-① 收口自我优化闭环)', () => {
  it('recheck_gate 注入 recheck 状态与转移，且幂等', () => {
    const d1 = applyRecommendationToDef(DEFAULT_WORK_ORDER_DEF, wfDecision('work_order:recheck_gate'));
    expect(d1.states).toContain('recheck');
    expect(d1.transitions.some((t) => t.from === 'assigned' && t.to === 'recheck' && t.event === 'recheck_open')).toBe(true);
    expect(d1.transitions.some((t) => t.from === 'recheck' && t.to === 'processing' && t.event === 'recheck_pass')).toBe(true);
    const d2 = applyRecommendationToDef(d1, wfDecision('work_order:recheck_gate'));
    expect(d2.states.filter((s) => s === 'recheck').length).toBe(1);
    expect(d2.transitions.filter((t) => t.from === 'assigned' && t.to === 'recheck').length).toBe(1);
  });

  it('auto_escalate 注入 escalated 终态与转移', () => {
    const d = applyRecommendationToDef(DEFAULT_WORK_ORDER_DEF, wfDecision('work_order:auto_escalate'));
    expect(d.states).toContain('escalated');
    expect(d.transitions.some((t) => t.from === 'processing' && t.to === 'escalated' && t.event === 'auto_escalate')).toBe(true);
    expect(d.config?.auto_escalate).toBe(true);
  });

  it('sla_tighten 在 config 收紧 SLA 目标阈值', () => {
    const d = applyRecommendationToDef(DEFAULT_WORK_ORDER_DEF, wfDecision('work_order:sla_tighten', { current_sla_rate: 0.25 }));
    expect(d.config?.sla_tighten).toBe(true);
    expect(Number(d.config?.target_sla_rate)).toBeGreaterThanOrEqual(0.8);
  });

  it('原默认流转不被破坏', () => {
    const d = applyRecommendationToDef(DEFAULT_WORK_ORDER_DEF, wfDecision('work_order:recheck_gate'));
    expect(d.transitions.some((t) => t.from === 'draft' && t.to === 'assigned')).toBe(true);
    expect(d.transitions.some((t) => t.from === 'processing' && t.to === 'completed')).toBe(true);
  });
});
