// 批次 A：派单规则引擎纯函数测试（无 DB 依赖，可本地验证）。
// 覆盖 matchRule / resolveDispatch / getActiveRules（DB 形状 → 引擎真实链路）。
// 重要：rule/need 一律使用与 DB 存储、前端表单、路由层一致的 snake_case
//       （business_type / skill_tags），杜绝隐性契约错位导致规则失配。
import { describe, it, expect } from 'vitest';
import {
  matchRule,
  resolveDispatch,
  getActiveRules,
  type WorkerRow,
  type DispatchRule,
  type Need,
} from '../engine/dispatch.js';

const workers: WorkerRow[] = [
  { id: 'w1', skill_tags: ['repair'], load: 3, active: true },
  { id: 'w2', skill_tags: ['repair', 'electric'], load: 1, active: true },
  { id: 'w3', skill_tags: ['repair'], load: 1, active: false }, // 非 active 不选
];

// 直接用 DB 存储形状（snake_case jsonb）构造 rule，验证真实链路契约
function dbRule(partial: Partial<DispatchRule>): DispatchRule {
  return {
    id: partial.id ?? 'r1',
    name: partial.name ?? 'rule',
    priority: partial.priority ?? 100,
    match: partial.match ?? {},
    strategy: partial.strategy ?? { type: 'load_balance' },
  };
}

describe('dispatch matchRule (snake_case 契约)', () => {
  it('business_type 命中', () => {
    expect(matchRule(dbRule({ match: { business_type: 'repair' } }), { business_type: 'repair' })).toBe(true);
  });
  it('business_type 不命中', () => {
    expect(matchRule(dbRule({ match: { business_type: 'repair' } }), { business_type: 'transport' })).toBe(false);
  });
  it('skill_tags 全包含才命中（AND）', () => {
    const r = dbRule({ match: { skill_tags: ['repair', 'electric'] } });
    expect(matchRule(r, { skill_tags: ['repair', 'electric'] })).toBe(true);
    expect(matchRule(r, { skill_tags: ['repair'] })).toBe(false);
  });
  it('priority 维度', () => {
    const r = dbRule({ match: { priority: 'urgent' } });
    expect(matchRule(r, { priority: 'urgent' })).toBe(true);
    expect(matchRule(r, { priority: 'normal' })).toBe(false);
  });
  it('未填维度视为通配', () => {
    expect(matchRule(dbRule({ match: {} }), { business_type: 'repair', skill_tags: ['x'], priority: 'normal' })).toBe(true);
  });
});

describe('dispatch resolveDispatch (snake_case)', () => {
  it('按规则命中并选人，reason 含规则名', () => {
    const rule = dbRule({
      id: 'r1',
      name: 'urgent electric',
      priority: 200,
      match: { business_type: 'repair', priority: 'urgent', skill_tags: ['electric'] },
      strategy: { type: 'skill_match', skill_tags: ['electric'] },
    });
    const need: Need = { business_type: 'repair', priority: 'urgent', skill_tags: ['electric'] };
    const res = resolveDispatch(workers, [rule], need);
    expect(res).not.toBeNull();
    expect(res!.worker.id).toBe('w2');
    expect(res!.reason).toContain('urgent electric');
  });

  it('无规则命中返回 null（上层降级 pickWorker）', () => {
    const rule = dbRule({ match: { business_type: 'transport' } });
    const res = resolveDispatch(workers, [rule], { business_type: 'repair' });
    expect(res).toBeNull();
  });

  it('高优先级规则优先被尝试', () => {
    const low = dbRule({ id: 'low', priority: 10 });
    const high = dbRule({ id: 'high', priority: 999 });
    const res = resolveDispatch(workers, [low, high], { business_type: 'repair' });
    expect(res!.ruleId).toBe('high');
  });

  it('规则命中但策略无可派工人时返回 null（不误派到无关工人）', () => {
    const rule = dbRule({
      match: { business_type: 'repair' },
      strategy: { type: 'skill_match', skill_tags: ['plumbing'] }, // 无工人有此技能
    });
    const res = resolveDispatch(workers, [rule], { business_type: 'repair', skill_tags: ['repair'] });
    expect(res).toBeNull();
  });
});

describe('getActiveRules DB 形状 → 引擎（真实链路契约）', () => {
  // 模拟从 dispatch_rule 表 SELECT 出的行（snake_case jsonb 列），与 008 SQL + config.ts 一致
  const fakeRows = [
    {
      id: 'r1',
      name: '电工紧急单',
      priority: 200,
      match_json: { business_type: 'repair', skill_tags: ['electric'] },
      strategy_json: { type: 'skill_match', skill_tags: ['electric'] },
    },
  ];
  function fakeClient(rows: any[]) {
    return { query: async () => ({ rows }) } as any;
  }

  it('读出后 matchRule 能正确按 business_type + skill_tags 匹配', async () => {
    const rules = await getActiveRules(fakeClient(fakeRows), 't1');
    expect(rules[0].match.business_type).toBe('repair');
    expect(rules[0].strategy.skill_tags).toEqual(['electric']);
    // 真实链路：建单 need 为 repair+electric → 命中
    const res = resolveDispatch(workers, rules, { business_type: 'repair', skill_tags: ['electric'] });
    expect(res).not.toBeNull();
    expect(res!.worker.id).toBe('w2');
  });

  it('读出后 business_type 不匹配则降级（不命中）', async () => {
    const rules = await getActiveRules(fakeClient(fakeRows), 't1');
    const res = resolveDispatch(workers, rules, { business_type: 'transport', skill_tags: [] });
    expect(res).toBeNull();
  });
});

// AL-004 修复回归（2026-09-04）：rankByModel 评分必须含负载因子 1/(1+load)。
// 此前评分 = 规则权 × 模型分，load 完全不参与 → load_balance 语义在有模型时失效。
describe('resolveDispatch with model（AL-004 负载因子）', () => {
  const rule = dbRule({ id: 'lb', name: 'load_balance rule', priority: 100, match: {}, strategy: { type: 'load_balance' } });
  const need: Need = { business_type: 'repair' };
  // 假模型：按 workerId 查表返回模型分（仅实现 score 的 MockBackend）
  function fakeModel(scores: Record<string, number>): any {
    return { score: ({ workerId }: { workerId: string }) => scores[workerId] ?? 0 };
  }

  it('模型分相同 → 低负载工人胜出（因子生效）', () => {
    const ws: WorkerRow[] = [
      { id: 'busy', skill_tags: ['repair'], load: 9, active: true },
      { id: 'free', skill_tags: ['repair'], load: 0, active: true },
    ];
    const res = resolveDispatch(ws, [rule], need, fakeModel({ busy: 0.8, free: 0.8 }));
    expect(res!.worker.id).toBe('free');
  });

  it('高分但高负载被低分低负载翻转（AL-004 实案复现：load=9 胜过 load=8 的正主）', () => {
    const ws: WorkerRow[] = [
      { id: 'w-load9', skill_tags: ['repair'], load: 9, active: true },
      { id: 'w-load8', skill_tags: ['repair'], load: 8, active: true },
    ];
    // 无负载因子时 0.85 > 0.84 → w-load9 胜；加因子后 0.85/10=0.0850 vs 0.84/9≈0.0933 → 低负载翻转
    const res = resolveDispatch(ws, [rule], need, fakeModel({ 'w-load9': 0.85, 'w-load8': 0.84 }));
    expect(res!.worker.id).toBe('w-load8');
  });

  it('负载相同 → 高模型分胜出（因子不破坏质量序）', () => {
    const ws: WorkerRow[] = [
      { id: 'mediocre', skill_tags: ['repair'], load: 3, active: true },
      { id: 'expert', skill_tags: ['repair'], load: 3, active: true },
    ];
    const res = resolveDispatch(ws, [rule], need, fakeModel({ mediocre: 0.2, expert: 0.9 }));
    expect(res!.worker.id).toBe('expert');
  });

  it('无模型仍走 least_load 兜底（向后兼容不回归）', () => {
    const ws: WorkerRow[] = [
      { id: 'busy', skill_tags: ['repair'], load: 5, active: true },
      { id: 'free', skill_tags: ['repair'], load: 1, active: true },
    ];
    const res = resolveDispatch(ws, [rule], need);
    expect(res!.worker.id).toBe('free');
    expect(res!.reason).not.toContain('model-scored');
  });
});
