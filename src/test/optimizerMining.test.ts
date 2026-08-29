// ⑦P2 单元测试：generateMiningOptimizations（过程挖掘 → 优化建议，纯函数）。
// 模仿现有 optimizer.test.ts 风格：用最小 ProcessMiningResult 桩驱动，断言建议生成规则。
import { describe, it, expect } from 'vitest';
import { generateMiningOptimizations } from '../services/optimizer.js';
import type { ProcessMiningResult } from '../repo/processMining.js';

function stub(over: Partial<ProcessMiningResult> = {}): ProcessMiningResult {
  return {
    tenant_id: 't',
    entity_type: 'work_order',
    generated_at: new Date().toISOString(),
    scope: { days: 30, from: '', to: '' },
    overview: { case_count: 0, event_count: 0, available_entity_types: [] },
    variants: [],
    bottlenecks: { per_activity: [], per_edge: [], slowest_edge: null, slowest_activity: null },
    throughput: [],
    conformance: { happy_path: [], deviation_rate: 0, deviating_variants: [], precise: true, note: '' },
    resonance: {
      configured: true,
      initial: 'draft',
      done_states: ['completed'],
      learning_triggers: ['completed'],
      auto_routes: [],
      learning_hits_in_scope: 0,
      auto_dispatched_in_scope: 0,
      model_version: 0,
    },
    ...over,
  };
}

describe('generateMiningOptimizations', () => {
  it('空/健康数据：无偏离、无超慢边 → 不产生建议', () => {
    const r = stub({
      conformance: { happy_path: ['create', 'complete'], deviation_rate: 0.1, deviating_variants: [], precise: true, note: '' },
      bottlenecks: {
        per_activity: [],
        per_edge: [],
        slowest_edge: { from: 'a', to: 'b', avg_minutes: 120, max_minutes: 120, count: 5 },
        slowest_activity: null,
      },
    });
    expect(generateMiningOptimizations(r)).toHaveLength(0);
  });

  it('偏离率 > 0.3 → 产生 work_order:recheck_gate 建议', () => {
    const r = stub({
      conformance: { happy_path: ['create', 'complete'], deviation_rate: 0.4, deviating_variants: [], precise: true, note: '' },
      bottlenecks: { per_activity: [], per_edge: [], slowest_edge: null, slowest_activity: null },
    });
    const d = generateMiningOptimizations(r);
    expect(d).toHaveLength(1);
    expect(d[0].scope).toBe('workflow');
    expect(d[0].target).toBe('work_order:recheck_gate');
    expect(d[0].recommendation.deviation_rate).toBe(0.4);
  });

  it('最慢边 > 8h(480分) → 产生 <entity>:auto_escalate 建议', () => {
    const r = stub({
      entity_type: 'work_order',
      conformance: { happy_path: ['create', 'complete'], deviation_rate: 0.1, deviating_variants: [], precise: true, note: '' },
      bottlenecks: {
        per_activity: [],
        per_edge: [],
        slowest_edge: { from: 'assign', to: 'complete', avg_minutes: 528, max_minutes: 528, count: 7 },
        slowest_activity: null,
      },
    });
    const d = generateMiningOptimizations(r);
    expect(d).toHaveLength(1);
    expect(d[0].target).toBe('work_order:auto_escalate');
    expect(d[0].recommendation.edge).toEqual(['assign', 'complete']);
  });

  it('两者同时触发 → 两条建议（recheck_gate + auto_escalate）', () => {
    const r = stub({
      entity_type: 'work_order',
      conformance: { happy_path: ['create', 'complete'], deviation_rate: 0.5, deviating_variants: [], precise: true, note: '' },
      bottlenecks: {
        per_activity: [],
        per_edge: [],
        slowest_edge: { from: 'assign', to: 'complete', avg_minutes: 600, max_minutes: 600, count: 3 },
        slowest_activity: null,
      },
    });
    const d = generateMiningOptimizations(r);
    expect(d).toHaveLength(2);
    const targets = d.map((x) => x.target).sort();
    expect(targets).toEqual(['work_order:auto_escalate', 'work_order:recheck_gate']);
  });

  it('边界：偏离率恰好 0.3 不触发；最慢边恰好 480 分不触发', () => {
    const r = stub({
      conformance: { happy_path: ['create', 'complete'], deviation_rate: 0.3, deviating_variants: [], precise: true, note: '' },
      bottlenecks: {
        per_activity: [],
        per_edge: [],
        slowest_edge: { from: 'a', to: 'b', avg_minutes: 480, max_minutes: 480, count: 2 },
        slowest_activity: null,
      },
    });
    expect(generateMiningOptimizations(r)).toHaveLength(0);
  });
});
