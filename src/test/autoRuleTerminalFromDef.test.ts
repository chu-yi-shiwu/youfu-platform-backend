/**
 * 自动审核终态校验改 def 派生（对齐审查修复 F2，2026-10-19）
 *
 * 【缺陷实证（审查发现）】
 *   engine/autoRules.ts:32 TERMINAL_STATES 硬编码 ['closed','cancelled','evaluated']，
 *   assertAutoRuleSavable（保存时闸 B）与 repo/ticket.ts:370 tryAutoAdvance（运行时双保险）
 *   都用它拦「自动审核不得推进到终态」红线。内置 RICH 模板恰好用这套状态名，所以现网
 *   看上去有效；但自定义态名的 def（如 inspection_task 的 pending/in_progress/done）里，
 *   'done' 不在硬编码集里 → 客户可配出「单子审完自动进终态」的规则，红线漏拦。
 *   引擎红线（stateMachine.ts:5-6）是 def 无关的：终态必须由人工显式操作。
 *
 * 【修法】两处判定都改「硬编码 RICH 终态名 ∪ def 派生 terminalStates(def)」并集，
 *   只加强不削弱（安全属性纪律）：
 *   - RICH 下 closed 有出边（→evaluated），但"已关闭"是人工终局决定，绝不放行自动关单
 *     （autoAdvance.test.ts 红线双保险用例口径，并集保住它）；
 *   - closed/cancelled/evaluated 无出边或已在硬编码集 → 仍拦，与旧行为一致；
 *   - 自定义 def 的真实终态（done 等）→ 由派生集正确拦上（旧口径漏拦）。
 *   DB 侧 094 CHECK（第三层保险）不动。
 */

import { describe, it, expect } from 'vitest';
import { assertAutoRuleSavable } from '../engine/autoRules.js';
import { RICH_WORK_ORDER_DEF, type WorkflowDef } from '../engine/stateMachine.js';

/** 自定义态名 def（仿 inspection_task 风格）：review 之后的 done 是终态 */
const CUSTOM_DEF: WorkflowDef = {
  initial: 'pending',
  states: ['pending', 'review', 'done'],
  transitions: [
    { from: 'pending', to: 'review', event: 'submit_review' },
    { from: 'review', to: 'done', event: 'approve' },
  ],
};

describe('F2 assertAutoRuleSavable 终态校验（def 派生，替代硬编码 TERMINAL_STATES）', () => {
  it('① 自定义 def：自动审核推到自定义终态 done → 拒绝保存（旧代码漏拦）', () => {
    expect(() => assertAutoRuleSavable(CUSTOM_DEF, { fromState: 'review', event: 'approve' })).toThrow(
      /不得自动推进到终态/,
    );
  });

  it('② 自定义 def：推到非终态 review → 允许（中间态本就可自动审）', () => {
    // pending --submit_review--> review，但 submit_review 不在 AUTO_RULE_EVENTS 白名单，
    // 构造一条合法 approve 边到非终态来验"放行"路径
    const def: WorkflowDef = {
      initial: 'pending',
      states: ['pending', 'review', 'done'],
      transitions: [
        { from: 'pending', to: 'review', event: 'approve' },
        { from: 'review', to: 'pending', event: 'reject' },
      ],
    };
    expect(assertAutoRuleSavable(def, { fromState: 'pending', event: 'approve' })).toEqual({ to: 'review' });
  });

  it('③ RICH 兼容：approve 推到 review_passed（非终态）→ 允许（存量语义不变）', () => {
    expect(
      assertAutoRuleSavable(RICH_WORK_ORDER_DEF, { fromState: 'pending_review', event: 'approve' }),
    ).toEqual({ to: 'review_passed' });
  });

  it('④ RICH 兼容（并集口径存档）：closed 有出边但仍在硬编码集 → 保存时照拦', () => {
    // 并集语义：def 派生终态（cancelled/evaluated）∪ 硬编码集（+closed）。
    // closed 在 RICH 有 satisfy 出边故非派生终态，但"自动关单"是人工终局决定——
    // 构造 dirty def（approve 直达 closed）验保存闸仍拒绝（与运行期双保险同口径）。
    const dirty: WorkflowDef = {
      ...RICH_WORK_ORDER_DEF,
      transitions: [
        ...RICH_WORK_ORDER_DEF.transitions.filter(
          (t) => !(t.from === 'pending_review' && t.event === 'approve'),
        ),
        { from: 'pending_review', to: 'closed', event: 'approve' },
      ],
    };
    expect(() => assertAutoRuleSavable(dirty, { fromState: 'pending_review', event: 'approve' })).toThrow(
      /不得自动推进到终态/,
    );
    // completed 有出边且不在硬编码集 → 非终态，允许（与旧行为一致）
    const richTerminals = RICH_WORK_ORDER_DEF.states.filter(
      (s) => !RICH_WORK_ORDER_DEF.transitions.some((t) => t.from === s),
    );
    expect(richTerminals).toEqual(['cancelled', 'evaluated']);
    expect(richTerminals).not.toContain('completed');
  });

  it('⑤ 事件白名单闸仍在：非 approve/reject 一律拒（与终态校验互不替代）', () => {
    expect(() => assertAutoRuleSavable(RICH_WORK_ORDER_DEF, { fromState: 'processing', event: 'complete' })).toThrow(
      /自动审核只允许/,
    );
  });

  it('⑥ 边不存在仍拒（拓扑闸）', () => {
    expect(() => assertAutoRuleSavable(CUSTOM_DEF, { fromState: 'done', event: 'approve' })).toThrow(
      /不存在/,
    );
  });
});
