import { describe, it, expect } from 'vitest';
import { canTransition, nextStates, DEFAULT_WORK_ORDER_DEF, RICH_WORK_ORDER_DEF, type WorkOrderStatus } from '../engine/stateMachine.js';

const def = DEFAULT_WORK_ORDER_DEF;

describe('状态机合法顺序', () => {
  const chain: WorkOrderStatus[] = ['draft', 'assigned', 'processing', 'completed'];
  it('相邻步骤均合法', () => {
    for (let i = 0; i < chain.length - 1; i++) {
      expect(canTransition(def, chain[i], chain[i + 1])).toBe(true);
    }
  });
  it('completed 无后续', () => {
    expect(canTransition(def, 'completed', 'completed')).toBe(false);
    expect(nextStates(def, 'completed')).toEqual([]);
  });
});

// RICH 13 态复核分支（admin 复核页的契约基石）：submit_review → approve/reject
describe('RICH 模板复核分支（pending_review）', () => {
  const rich = RICH_WORK_ORDER_DEF;
  it('processing 可提交复核 submit_review → pending_review', () => {
    expect(canTransition(rich, 'processing', 'pending_review')).toBe(true);
  });
  it('pending_review 可 approve → review_passed（admin/reviewer）', () => {
    expect(canTransition(rich, 'pending_review', 'review_passed')).toBe(true);
  });
  it('pending_review 可 reject → processing（退回重做）', () => {
    expect(canTransition(rich, 'pending_review', 'processing')).toBe(true);
  });
  it('review_passed 可 complete → completed（复核通过后闭环）', () => {
    expect(canTransition(rich, 'review_passed', 'completed')).toBe(true);
  });
  it('pending_review 不允许跳 completed（必须经 review_passed）', () => {
    expect(canTransition(rich, 'pending_review', 'completed')).toBe(false);
  });
  it('approve/reject 的角色门禁仅 admin+reviewer', () => {
    const approve = rich.transitions.find((t) => t.from === 'pending_review' && t.to === 'review_passed');
    const reject = rich.transitions.find((t) => t.from === 'pending_review' && t.to === 'processing');
    expect(approve?.allowedRoles).toEqual(['admin', 'reviewer']);
    expect(reject?.allowedRoles).toEqual(['admin', 'reviewer']);
  });
});

describe('非法跳步拦截（P6 红线：绝不跳步闭环）', () => {
  it('draft 不能直接到 completed', () => {
    expect(canTransition(def, 'draft', 'completed')).toBe(false);
  });
  it('draft 不能直接到 processing（必须先进 assigned）', () => {
    expect(canTransition(def, 'draft', 'processing')).toBe(false);
  });
  it('assigned 不能直接到 completed（必须先进 processing）', () => {
    expect(canTransition(def, 'assigned', 'completed')).toBe(false);
  });
  it('processing 才能到 completed', () => {
    expect(canTransition(def, 'processing', 'completed')).toBe(true);
  });
  it('nextStates 提示下一步', () => {
    expect(nextStates(def, 'draft')).toEqual(['assigned']);
    expect(nextStates(def, 'assigned')).toEqual(['processing']);
    expect(nextStates(def, 'processing')).toEqual(['completed']);
  });
});

// DEF-3：建单响应必须含内部 id（uuid），否则 /transition/:id 无法流转（契约错配）。
describe('DEF-3 建单响应含 id', () => {
  it('toCreateRes 返回 id 字段', async () => {
    const { toCreateRes } = await import('../routes/workOrder.js');
    const row = { id: 'uuid-abc', order_no: 'WO_20260813_000001' };
    const res = toCreateRes(row, true, 'w-1', 'auto');
    expect(res.id).toBe('uuid-abc');
    expect(res.order_no).toBe('WO_20260813_000001');
  });
});
