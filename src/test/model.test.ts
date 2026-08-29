import { describe, it, expect } from 'vitest';
import { StatsModelBackend } from '../engine/model/ModelBackend.js';
import { computeRewards } from '../services/modelTrainer.js';

describe('StatsModelBackend（派单自适应评分）', () => {
  it('新候选给基线分，被 UCB 探索优先选中', () => {
    const m = new StatsModelBackend();
    const s = m.score({ category: 'electric', workerId: 'w-new' });
    expect(s).toBeGreaterThan(0.5); // 基线 + UCB 探索加分
  });

  it('正向奖励提升权重、负向降低；学好后评分优于学坏后', () => {
    const m = new StatsModelBackend();
    m.learn('electric', 'w-1', 1);
    m.learn('electric', 'w-1', 1);
    const goodWeight = m.toParams().arms['electric::w-1'].weight;
    const goodScore = m.score({ category: 'electric', workerId: 'w-1' });
    m.learn('electric', 'w-1', -1); // 派错
    const badWeight = m.toParams().arms['electric::w-1'].weight;
    const badScore = m.score({ category: 'electric', workerId: 'w-1' });
    expect(goodWeight).toBeGreaterThan(badWeight); // 权重方向正确（正>负）
    expect(goodScore).toBeGreaterThan(badScore); // 学好后优于学坏后
  });

  it('参数可导出再导入（持久化闭环一致）', () => {
    const m = new StatsModelBackend();
    m.learn('electric', 'w-1', 1);
    const p = m.toParams();
    const m2 = StatsModelBackend.fromParams(p);
    expect(m2.score({ category: 'electric', workerId: 'w-1' })).toBeCloseTo(
      m.score({ category: 'electric', workerId: 'w-1' }),
      5,
    );
  });
});

describe('computeRewards（数据反训奖励计算）', () => {
  it('一次派单即完成 → reward +1', () => {
    const ev = [
      { type: 'assign', to_status: 'assigned', actor: 'auto_dispatch', payload: { worker_id: 'w-1' }, created_at: 't' },
      { type: 'transition', to_status: 'completed', actor: 'system', payload: {}, created_at: 't2' },
    ];
    const r = computeRewards(ev as any);
    expect(r).toHaveLength(1);
    expect(r[0].reward).toBe(1);
    expect(r[0].workerId).toBe('w-1');
  });

  it('转派（assign>=2）→ reward -0.5', () => {
    const ev = [
      { type: 'assign', to_status: 'assigned', actor: 'auto_dispatch', payload: { worker_id: 'w-1' }, created_at: 't' },
      { type: 'assign', to_status: 'assigned', actor: 'auto_dispatch', payload: { worker_id: 'w-2' }, created_at: 't2' },
      { type: 'transition', to_status: 'completed', actor: 'system', payload: {}, created_at: 't3' },
    ];
    const r = computeRewards(ev as any);
    expect(r[0].reward).toBe(-0.5);
  });

  it('超时升级 → reward -1', () => {
    const ev = [
      { type: 'assign', to_status: 'assigned', actor: 'auto_dispatch', payload: { worker_id: 'w-1' }, created_at: 't' },
      { type: 'sla_escalated', to_status: 'assigned', actor: 'system', payload: {}, created_at: 't2' },
    ];
    const r = computeRewards(ev as any);
    expect(r[0].reward).toBe(-1);
  });

  it('无派单事件 → 空', () => {
    const ev = [{ type: 'create', to_status: 'draft', actor: 'system', payload: {}, created_at: 't' }];
    expect(computeRewards(ev as any)).toHaveLength(0);
  });

  // 飞轮断链 1 修复：满意度信号（sat_bonus=(score-3)/2 叠加到最终 assign）
  it('满意度 5 分 → 最终 assign reward +1（1 + 1 = 2）', () => {
    const ev = [
      { type: 'assign', to_status: 'assigned', actor: 'auto_dispatch', payload: { worker_id: 'w-1' }, created_at: 't' },
      { type: 'transition', to_status: 'completed', actor: 'system', payload: {}, created_at: 't2' },
    ];
    const r = computeRewards(ev as any, 5);
    expect(r[0].reward).toBe(2);
  });

  it('满意度 1 分 → 最终 assign reward 归零（1 - 1 = 0）', () => {
    const ev = [
      { type: 'assign', to_status: 'assigned', actor: 'auto_dispatch', payload: { worker_id: 'w-1' }, created_at: 't' },
      { type: 'transition', to_status: 'completed', actor: 'system', payload: {}, created_at: 't2' },
    ];
    const r = computeRewards(ev as any, 1);
    expect(r[0].reward).toBe(0);
  });

  it('满意度只叠加到最终 assign（转派场景历史工人不受当前满意度影响）', () => {
    const ev = [
      { type: 'assign', to_status: 'assigned', actor: 'auto_dispatch', payload: { worker_id: 'w-1' }, created_at: 't' },
      { type: 'assign', to_status: 'assigned', actor: 'auto_dispatch', payload: { worker_id: 'w-2' }, created_at: 't2' },
      { type: 'transition', to_status: 'completed', actor: 'system', payload: {}, created_at: 't3' },
    ];
    const r = computeRewards(ev as any, 5);
    expect(r[0].reward).toBe(-0.5); // 历史工人：转派信号 -0.5，无满意度加成
    expect(r[1].reward).toBe(0.5); // 最终工人：转派 -0.5 + 满意度 +1 = +0.5
  });

  it('满意度缺失（null）→ 不影响事件信号', () => {
    const ev = [
      { type: 'assign', to_status: 'assigned', actor: 'auto_dispatch', payload: { worker_id: 'w-1' }, created_at: 't' },
      { type: 'transition', to_status: 'completed', actor: 'system', payload: {}, created_at: 't2' },
    ];
    const r = computeRewards(ev as any, null);
    expect(r[0].reward).toBe(1);
  });
});

describe('StatsModelBackend arms 上限（R17-003 防内存膨胀）', () => {
  it('学习远超上限的不同臂后，arms 数量被收敛、不无限增长', () => {
    const m = new StatsModelBackend();
    const N = 6000; // 超过 MAX_ARMS(5000)
    for (let i = 0; i < N; i++) {
      m.learn(`cat-${i}`, `w-${i}`, i % 2 === 0 ? 1 : -1);
    }
    const size = Object.keys(m.toParams().arms).length;
    expect(size).toBeLessThanOrEqual(5000);
    expect(size).toBeGreaterThan(0);
  });
});
