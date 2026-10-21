// R4-E：派单「策略种类」从代码枚举 → 注册表 + fail-safe 回退。
// 覆盖三件事：
//  1) 内置 skill_match / load_balance 的选人结果与改动前逐值一致（零回归锚）；
//  2) 未注册 type（如 by_distance）不抛异常、回退 pickWorker 兜底、并打印 warn 日志（不静默失败）；
//  3) 注册表可扩展：注册自定义策略函数后，同 type 调用走到新函数（扩展点收敛到一处）。
// 风格与 dispatch.config.test.ts 保持一致：rule/need 用 DB 存储同款 snake_case。
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  pickWorker,
  resolveDispatch,
  DISPATCH_STRATEGY_REGISTRY,
  type WorkerRow,
  type DispatchRule,
  type Need,
} from '../engine/dispatch.js';

const workers: WorkerRow[] = [
  { id: 'w1', skill_tags: ['repair'], load: 3, active: true },
  { id: 'w2', skill_tags: ['repair', 'electric'], load: 1, active: true },
  { id: 'w3', skill_tags: ['repair'], load: 1, active: false }, // 非 active 不选
];

function dbRule(partial: Partial<DispatchRule>): DispatchRule {
  return {
    id: partial.id ?? 'r1',
    name: partial.name ?? 'rule',
    priority: partial.priority ?? 100,
    match: partial.match ?? {},
    strategy: partial.strategy ?? { type: 'load_balance' },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('派单策略注册表：内置策略零回归', () => {
  it('skill_match 与改动前逐值一致（技能硬过滤 → least_load，选 w2）', () => {
    const rule = dbRule({
      id: 'r-skill',
      name: '电工优先',
      match: { business_type: 'repair' },
      strategy: { type: 'skill_match', skill_tags: ['electric'] },
    });
    const res = resolveDispatch(workers, [rule], { business_type: 'repair', skill_tags: ['electric'] });
    expect(res).not.toBeNull();
    expect(res!.worker.id).toBe('w2');
    expect(res!.ruleId).toBe('r-skill');
  });

  it('load_balance 与改动前逐值一致（least_load，且非 active 不入选）', () => {
    const rule = dbRule({
      id: 'r-load',
      name: '负载均衡',
      match: { business_type: 'repair' },
      strategy: { type: 'load_balance' },
    });
    const res = resolveDispatch(workers, [rule], { business_type: 'repair' });
    expect(res!.worker.id).toBe('w2'); // w1 load3 / w2 load1 / w3 非 active
    expect(res!.reason).not.toContain('model-scored');
  });

  it('skill_match 与 load_balance 在相同候选集上结果一致（历史同算法锚点）', () => {
    const need: Need = { business_type: 'repair' };
    const a = resolveDispatch(workers, [dbRule({ strategy: { type: 'skill_match' } })], need);
    const b = resolveDispatch(workers, [dbRule({ strategy: { type: 'load_balance' } })], need);
    expect(a!.worker.id).toBe(b!.worker.id);
    expect(a!.worker.id).toBe('w2');
  });

  it('AL-004 负载因子不回归：load_balance + 模型 → 低负载翻转高分', () => {
    const ws: WorkerRow[] = [
      { id: 'w-load9', skill_tags: ['repair'], load: 9, active: true },
      { id: 'w-load8', skill_tags: ['repair'], load: 8, active: true },
    ];
    const model: any = { score: ({ workerId }: { workerId: string }) => (workerId === 'w-load9' ? 0.85 : 0.84) };
    const res = resolveDispatch(
      ws,
      [dbRule({ strategy: { type: 'load_balance' } })],
      { business_type: 'repair' },
      model,
    );
    expect(res!.worker.id).toBe('w-load8');
  });

  it('注册表内置 skill_match / load_balance 两个策略', () => {
    expect(Object.keys(DISPATCH_STRATEGY_REGISTRY)).toEqual(
      expect.arrayContaining(['skill_match', 'load_balance']),
    );
  });
});

describe('派单策略注册表：未知 type 的 fail-safe', () => {
  it('未注册 type 不抛异常，回退 pickWorker 兜底选人（least_load）', () => {
    const rule = dbRule({
      id: 'r-unknown',
      name: '按距离最近',
      match: { business_type: 'repair' },
      strategy: { type: 'by_distance' },
    });
    expect(() => resolveDispatch(workers, [rule], { business_type: 'repair' })).not.toThrow();
    const res = resolveDispatch(workers, [rule], { business_type: 'repair' });
    expect(res).not.toBeNull();
    expect(res!.ruleId).toBe('r-unknown');
    // 兜底口径 = pickWorker（active + least_load）
    expect(res!.worker.id).toBe(pickWorker(workers, {})!.id);
    expect(res!.worker.id).toBe('w2');
  });

  it('未注册 type 打印 warn 日志（不静默失败）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rule = dbRule({
      id: 'r-unknown',
      name: '按距离最近',
      match: { business_type: 'repair' },
      strategy: { type: 'by_distance' },
    });
    resolveDispatch(workers, [rule], { business_type: 'repair' });
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls.map((c) => c.join(' ')).join(' | ');
    expect(msg).toContain('by_distance');
    expect(msg.toLowerCase()).toContain('fallback');
  });

  it('已注册 type 不打印 warn（正常路径无噪音）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resolveDispatch(workers, [dbRule({ strategy: { type: 'load_balance' } })], { business_type: 'repair' });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('派单策略注册表：可扩展（新增种类不改引擎）', () => {
  it('注册自定义策略函数后，该 type 调用走到新函数', () => {
    const seen: string[] = [];
    DISPATCH_STRATEGY_REGISTRY['by_distance'] = (_workers, _need, _cfg) => {
      seen.push('by_distance');
      return [..._workers].sort((a, b) => b.load - a.load)[0] ?? null; // 故意反序：取负载最高
    };
    try {
      const rule = dbRule({
        id: 'r-custom',
        name: '按距离最近',
        match: { business_type: 'repair' },
        strategy: { type: 'by_distance' },
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const res = resolveDispatch(workers, [rule], { business_type: 'repair' });
      expect(seen).toEqual(['by_distance']);
      expect(res!.worker.id).toBe('w1'); // 自定义策略生效（load3 胜出），不再是 least_load 的 w2
      expect(warn).not.toHaveBeenCalled(); // 已注册 → 不走 fail-safe
    } finally {
      delete DISPATCH_STRATEGY_REGISTRY['by_distance'];
    }
  });

  it('自定义策略返回 null 时不误派（继续按无可用工人处理）', () => {
    DISPATCH_STRATEGY_REGISTRY['never_pick'] = () => null;
    try {
      const rule = dbRule({
        id: 'r-never',
        match: { business_type: 'repair' },
        strategy: { type: 'never_pick' },
      });
      expect(resolveDispatch(workers, [rule], { business_type: 'repair' })).toBeNull();
    } finally {
      delete DISPATCH_STRATEGY_REGISTRY['never_pick'];
    }
  });
});
