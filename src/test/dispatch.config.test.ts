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
