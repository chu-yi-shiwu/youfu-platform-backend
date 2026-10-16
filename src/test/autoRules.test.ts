/**
 * 自动审核规则（地基④）——红线与判定回归。
 *
 * 这里是"引擎绝不自动推进到终态"（stateMachine.ts:5-6）的机器化证明：
 * 只要有人把规则配成"自动推进到 closed/cancelled/evaluated"，保存时就必须被拒。
 * 用例按"能存 / 不能存"两分，不能存的全部断言抛错原因。
 */
import { describe, it, expect } from 'vitest';
import {
  AUTO_RULE_EVENTS,
  TERMINAL_STATES,
  matchAutoRule,
  pickAutoRule,
  resolveAutoRuleEdge,
  assertAutoRuleSavable,
  type AutoRule,
  type AutoRuleContext,
} from '../engine/autoRules.js';
import { RICH_WORK_ORDER_DEF, type WorkflowDef } from '../engine/stateMachine.js';

/** 造一条规则（默认：pending_review 的 approve，启用，无条件）。 */
const rule = (over: Partial<AutoRule> = {}): AutoRule => ({
  tenantId: 't1',
  entityType: 'work_order',
  fromState: 'pending_review',
  event: 'approve',
  conditions: {},
  enabled: true,
  ...over,
});

const ctx = (over: Partial<AutoRuleContext> = {}): AutoRuleContext => ({
  priority: 'normal',
  category: '设施维修',
  hasException: false,
  ...over,
});

/** 终态 def：approve 边直接指向 closed（模拟有人想把"自动关单"配成自动审核）。 */
const terminalDef: WorkflowDef = {
  initial: 'completed',
  states: ['completed', 'closed'],
  transitions: [{ from: 'completed', to: 'closed', event: 'approve' }],
};

describe('常量口径', () => {
  it('事件白名单只有 approve / reject（终态动作一律不在内）', () => {
    expect([...AUTO_RULE_EVENTS]).toEqual(['approve', 'reject']);
    for (const e of ['close', 'cancel', 'satisfy', 'acceptance_pass', 'complete']) {
      expect(AUTO_RULE_EVENTS).not.toContain(e);
    }
  });

  it('终态名单 = closed / cancelled / evaluated（completed 不算终态，后面还有 close/satisfy）', () => {
    expect([...TERMINAL_STATES].sort()).toEqual(['cancelled', 'closed', 'evaluated']);
    expect(TERMINAL_STATES).not.toContain('completed');
  });
});

describe('assertAutoRuleSavable —— 保存前红线闸', () => {
  it('正常审核边（pending_review --approve--> review_passed）可存', () => {
    expect(assertAutoRuleSavable(RICH_WORK_ORDER_DEF, { fromState: 'pending_review', event: 'approve' })).toEqual({
      to: 'review_passed',
    });
  });

  it('打回边（pending_review --reject--> processing）可存', () => {
    expect(assertAutoRuleSavable(RICH_WORK_ORDER_DEF, { fromState: 'pending_review', event: 'reject' })).toEqual({
      to: 'processing',
    });
  });

  it('🔴 红线：目标态是终态 → 拒绝保存（自动关单绝无可能）', () => {
    expect(() => assertAutoRuleSavable(terminalDef, { fromState: 'completed', event: 'approve' })).toThrow(
      /不得自动推进到终态 closed/,
    );
  });

  it('🔴 红线：cancel / close 这类终态动作即使混进来也先被事件白名单挡住', () => {
    expect(() => assertAutoRuleSavable(RICH_WORK_ORDER_DEF, { fromState: 'assigned', event: 'cancel' })).toThrow(
      /自动审核只允许 approve\/reject/,
    );
    expect(() => assertAutoRuleSavable(RICH_WORK_ORDER_DEF, { fromState: 'completed', event: 'close' })).toThrow(
      /自动审核只允许 approve\/reject/,
    );
  });

  it('流程里没有这条边 → 拒绝保存（防配到一个永远不触发的幽灵规则）', () => {
    expect(() => assertAutoRuleSavable(RICH_WORK_ORDER_DEF, { fromState: 'draft', event: 'approve' })).toThrow(
      /不存在 draft --approve--> 这条边/,
    );
  });
});

describe('matchAutoRule —— 条件匹配（fail-closed 优先）', () => {
  it('空条件 = 该态全部命中（配置台应提示这是"全量自动审"）', () => {
    expect(matchAutoRule(rule(), ctx())).toBe(true);
  });

  it('priority_in 命中 / 不命中', () => {
    const r = rule({ conditions: { priorityIn: ['low', 'normal'] } });
    expect(matchAutoRule(r, ctx({ priority: 'low' }))).toBe(true);
    expect(matchAutoRule(r, ctx({ priority: 'urgent' }))).toBe(false);
  });

  it('categories 命中 / 不命中', () => {
    const r = rule({ conditions: { categories: ['设施维修'] } });
    expect(matchAutoRule(r, ctx({ category: '设施维修' }))).toBe(true);
    expect(matchAutoRule(r, ctx({ category: '保洁' }))).toBe(false);
  });

  it('🔴 fail-closed：条件声明了但工单该字段缺失 → 不命中（宁可走人工，也不误自动）', () => {
    const r = rule({ conditions: { priorityIn: ['normal'] } });
    expect(matchAutoRule(r, ctx({ priority: null }))).toBe(false);
    expect(matchAutoRule(r, ctx({ priority: undefined }))).toBe(false);
  });

  it('no_exception=true：无异常才命中；有异常 / 异常未知一律不命中', () => {
    const r = rule({ conditions: { noException: true } });
    expect(matchAutoRule(r, ctx({ hasException: false }))).toBe(true);
    expect(matchAutoRule(r, ctx({ hasException: true }))).toBe(false);
    expect(matchAutoRule(r, ctx({ hasException: null }))).toBe(false);
    expect(matchAutoRule(r, ctx({ hasException: undefined }))).toBe(false);
  });

  it('多维度同时声明 = 全部满足才命中（与关系，不是或）', () => {
    const r = rule({ conditions: { priorityIn: ['normal'], categories: ['设施维修'], noException: true } });
    expect(matchAutoRule(r, ctx({ priority: 'normal', category: '设施维修', hasException: false }))).toBe(true);
    expect(matchAutoRule(r, ctx({ priority: 'urgent', category: '设施维修', hasException: false }))).toBe(false);
  });
});

describe('pickAutoRule —— 谁能真正生效', () => {
  it('未启用的规则永不生效（建了不等于启用）', () => {
    expect(pickAutoRule([rule({ enabled: false })], 'pending_review', ctx())).toBeNull();
  });

  it('触发态不匹配 → 不生效', () => {
    expect(pickAutoRule([rule()], 'processing', ctx())).toBeNull();
  });

  it('条件不命中 → 不生效', () => {
    const r = rule({ conditions: { priorityIn: ['urgent'] } });
    expect(pickAutoRule([r], 'pending_review', ctx({ priority: 'normal' }))).toBeNull();
  });

  it('启用 + 条件命中 → 生效', () => {
    expect(pickAutoRule([rule()], 'pending_review', ctx())).not.toBeNull();
  });

  it('多条并存时只取第一条命中的（表上有唯一约束，本就不该有多条同键规则）', () => {
    const a = rule({ id: 'a' });
    const b = rule({ id: 'b' });
    expect(pickAutoRule([a, b], 'pending_review', ctx())?.id).toBe('a');
  });
});

describe('resolveAutoRuleEdge', () => {
  it('按 from+event 精确定位边', () => {
    const e = resolveAutoRuleEdge(RICH_WORK_ORDER_DEF, { fromState: 'pending_review', event: 'approve' });
    expect(e).toMatchObject({ from: 'pending_review', to: 'review_passed', event: 'approve' });
  });

  it('找不到 → null（不抛，交由保存校验层决定怎么报错）', () => {
    expect(resolveAutoRuleEdge(RICH_WORK_ORDER_DEF, { fromState: 'nope', event: 'approve' })).toBeNull();
  });
});
