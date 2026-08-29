import { describe, it, expect } from 'vitest';
import {
  replayTraces,
  aggregateVariants,
  computeBottlenecks,
  computeThroughput,
  computeConformancePrecise,
  computeConformanceApprox,
  type RawEvent,
} from '../repo/processMining.js';
import { DEFAULT_WORK_ORDER_DEF } from '../engine/stateMachine.js';

// ⑦P0 过程挖掘纯函数单测（脱离 PG，验证聚合/回放/瓶颈/吞吐/合规逻辑）
function ev(entityId: string | null, type: string, at: number, actor = 'system'): RawEvent {
  return { entity_id: entityId, type, actor, created_at: new Date(at) };
}

describe('replayTraces', () => {
  it('按 entity_id 回放并按时间排序；跳过无 entity_id 的事件', () => {
    const rows = [
      ev('c1', 'complete', 3000),
      ev('c1', 'create', 1000),
      ev('c1', 'assign', 2000),
      ev(null, 'orphan', 5000), // 无 case 标识，跳过
    ];
    const traces = replayTraces(rows);
    expect(traces).toHaveLength(1);
    expect(traces[0].entityId).toBe('c1');
    expect(traces[0].events.map((e) => e.type)).toEqual(['create', 'assign', 'complete']);
  });

  it('多 case 各自成轨迹', () => {
    const traces = replayTraces([ev('a', 'create', 1), ev('b', 'create', 2), ev('a', 'done', 3)]);
    expect(traces).toHaveLength(2);
  });
});

describe('aggregateVariants', () => {
  it('相同序列合并计数 + 按频次降序 + 占比', () => {
    const traces = replayTraces([
      ev('c1', 'create', 1),
      ev('c1', 'complete', 2),
      ev('c2', 'create', 1),
      ev('c2', 'complete', 2),
      ev('c3', 'create', 1),
      ev('c3', 'assign', 2),
      ev('c3', 'complete', 3),
    ]);
    const variants = aggregateVariants(traces);
    expect(variants).toHaveLength(2);
    expect(variants[0].seq).toEqual(['create', 'complete']);
    expect(variants[0].count).toBe(2);
    expect(variants[0].share).toBeCloseTo(2 / 3, 3);
    expect(variants[1].seq).toEqual(['create', 'assign', 'complete']);
  });
});

describe('computeBottlenecks', () => {
  it('计算直接后继边与每活动停留时长（分钟）', () => {
    const traces = replayTraces([
      ev('c1', 'create', 0),
      ev('c1', 'assign', 60 * 60000), // +60min
      ev('c1', 'complete', 180 * 60000), // +120min
    ]);
    const { per_edge, per_activity, slowest_edge } = computeBottlenecks(traces);
    expect(per_edge).toHaveLength(2);
    const createAssign = per_edge.find((e) => e.from === 'create' && e.to === 'assign')!;
    expect(createAssign.avg_minutes).toBe(60);
    const assignComplete = per_edge.find((e) => e.from === 'assign' && e.to === 'complete')!;
    expect(assignComplete.avg_minutes).toBe(120);
    expect(slowest_edge!.from).toBe('assign');
    expect(slowest_edge!.avg_minutes).toBe(120);
    expect(per_activity.find((a) => a.activity === 'assign')!.avg_minutes).toBe(120);
  });

  it('单事件实例不产生时长（无崩溃）', () => {
    const traces = replayTraces([ev('c1', 'create', 0)]);
    const b = computeBottlenecks(traces);
    expect(b.per_edge).toHaveLength(0);
    expect(b.slowest_edge).toBeNull();
  });
});

describe('computeThroughput', () => {
  it('按天聚合事件与活跃 case；范围外忽略', () => {
    const from = new Date('2026-08-01T00:00:00Z');
    const to = new Date('2026-08-31T23:59:59Z');
    const rows = [
      ev('c1', 'create', new Date('2026-08-10T01:00:00Z').getTime()),
      ev('c1', 'assign', new Date('2026-08-10T02:00:00Z').getTime()),
      ev('c2', 'create', new Date('2026-08-11T01:00:00Z').getTime()),
      ev('c3', 'create', new Date('2026-07-01T01:00:00Z').getTime()), // 范围外
    ];
    const tp = computeThroughput(rows, from, to);
    const d10 = tp.find((p) => p.day === '2026-08-10')!;
    expect(d10.events).toBe(2);
    expect(d10.cases).toBe(1);
    const d11 = tp.find((p) => p.day === '2026-08-11')!;
    expect(d11.cases).toBe(1);
    expect(tp.find((p) => p.day === '2026-07-01')).toBeUndefined();
  });
});

describe('computeConformancePrecise (③ 状态机逐跳校验)', () => {
  const def = DEFAULT_WORK_ORDER_DEF; // draft→assigned→processing→completed
  it('无实例返回偏离率 0 + 不编造 note', () => {
    const c = computeConformancePrecise(def, [], []);
    expect(c.deviation_rate).toBe(0);
    expect(c.happy_path).toEqual([]);
    expect(c.precise).toBe(true);
    expect(c.note).toContain('无流程实例');
  });

  it('全部遵循状态机时偏离率 0（create 引导→各状态合法跳转）', () => {
    const traces = replayTraces([
      ev('c1', 'create', 1), ev('c1', 'assigned', 2), ev('c1', 'processing', 3), ev('c1', 'completed', 4),
      ev('c2', 'create', 1), ev('c2', 'assigned', 2), ev('c2', 'processing', 3), ev('c2', 'completed', 4),
    ]);
    const variants = aggregateVariants(traces);
    const c = computeConformancePrecise(def, traces, variants);
    expect(c.deviation_rate).toBe(0);
    expect(c.deviating_variants).toHaveLength(0);
    expect(c.precise).toBe(true);
    expect(c.happy_path).toEqual(['create', 'assigned', 'processing', 'completed']);
  });

  it('存在非法跳转轨迹时偏离率=不合规轨迹占比（驱动优化飞轮）', () => {
    // c3 跳过 processing：assigned→completed 非法跳转 → 非合规
    const traces = replayTraces([
      ev('c1', 'create', 1), ev('c1', 'assigned', 2), ev('c1', 'processing', 3), ev('c1', 'completed', 4),
      ev('c2', 'create', 1), ev('c2', 'assigned', 2), ev('c2', 'processing', 3), ev('c2', 'completed', 4),
      ev('c3', 'create', 1), ev('c3', 'assigned', 2), ev('c3', 'completed', 3),
    ]);
    const variants = aggregateVariants(traces);
    const c = computeConformancePrecise(def, traces, variants);
    expect(c.deviation_rate).toBeCloseTo(1 / 3, 3);
    expect(c.deviating_variants).toHaveLength(1);
    expect(c.deviating_variants[0].seq).toEqual(['create', 'assigned', 'completed']);
    expect(c.precise).toBe(true);
  });

  it('未纳入状态机的活动(如 recheck)被判为非合规 → 触发 recheck_gate 优化', () => {
    // 4 态默认 def 不含 recheck 状态：rework 路径中的 recheck 属未知活动 → 非合规
    const traces = replayTraces([
      ev('c1', 'create', 1), ev('c1', 'assigned', 2), ev('c1', 'processing', 3), ev('c1', 'completed', 4),
      ev('c2', 'create', 1), ev('c2', 'assigned', 2), ev('c2', 'processing', 3),
      ev('c2', 'recheck', 4), ev('c2', 'processing', 5), ev('c2', 'completed', 6),
    ]);
    const variants = aggregateVariants(traces);
    const c = computeConformancePrecise(def, traces, variants);
    expect(c.deviation_rate).toBeCloseTo(1 / 2, 3); // 1/2 轨迹非合规
    expect(c.precise).toBe(true);
  });

  it('生命周期事件兼容：历史 assign→assigned 映射 + sla_escalated 标注不改状态', () => {
    // 真实事件总线口径混杂：'assign'(事件名)、'sla_escalated'(标注)。应被正确归一/跳过。
    const traces = replayTraces([
      ev('c1', 'create', 1), ev('c1', 'assign', 2), ev('c1', 'sla_escalated', 3),
      ev('c1', 'processing', 4), ev('c1', 'completed', 5),
    ]);
    const variants = aggregateVariants(traces);
    const c = computeConformancePrecise(def, traces, variants);
    expect(c.deviation_rate).toBe(0); // 全部合规（assign 映射为 assigned，sla_escalated 跳过）
    expect(c.precise).toBe(true);
  });
});

describe('computeConformanceApprox (降级：未配置 workflow_def)', () => {
  it('主导路径近似：偏离率=1-主导占比', () => {
    const variants = aggregateVariants(
      replayTraces([
        ev('c1', 'create', 1), ev('c1', 'complete', 2),
        ev('c2', 'create', 1), ev('c2', 'complete', 2),
        ev('c3', 'create', 1), ev('c3', 'assign', 2), ev('c3', 'complete', 3),
      ]),
    );
    const c = computeConformanceApprox(variants);
    expect(c.deviation_rate).toBeCloseTo(1 / 3, 3);
    expect(c.deviating_variants).toHaveLength(1);
    expect(c.precise).toBe(false);
  });
});
