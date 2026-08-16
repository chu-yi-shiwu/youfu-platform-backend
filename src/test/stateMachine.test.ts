import { describe, it, expect } from 'vitest';
import { canTransition, nextStates, DEFAULT_WORK_ORDER_DEF } from '../engine/stateMachine.js';

const def = DEFAULT_WORK_ORDER_DEF;

describe('stateMachine (可配置引擎)', () => {
  it('默认 work_order 合法跳转', () => {
    expect(canTransition(def, 'draft', 'assigned')).toBe(true);
    expect(canTransition(def, 'assigned', 'processing')).toBe(true);
    expect(canTransition(def, 'processing', 'completed')).toBe(true);
  });
  it('非法跳转被拒绝', () => {
    expect(canTransition(def, 'draft', 'processing')).toBe(false);
    expect(canTransition(def, 'draft', 'completed')).toBe(false);
    expect(canTransition(def, 'assigned', 'completed')).toBe(false);
    expect(canTransition(def, 'completed', 'assigned')).toBe(false);
  });
  it('nextStates 给出下一步', () => {
    expect(nextStates(def, 'draft')).toEqual(['assigned']);
    expect(nextStates(def, 'completed')).toEqual([]);
  });
});
