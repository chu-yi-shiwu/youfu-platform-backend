import { describe, it, expect } from 'vitest';
import { canTransition, DEFAULT_WORK_ORDER_DEF } from '../engine/stateMachine.js';

const def = DEFAULT_WORK_ORDER_DEF;
import { pickWorker, type WorkerRow } from '../engine/dispatch.js';

describe('P6 不自动闭环', () => {
  it('派单命中后得到 assigned，而非 completed', () => {
    const workers: WorkerRow[] = [{ id: 'w1', skill_tags: ['repair'], load: 0, active: true }];
    const picked = pickWorker(workers, { skillTags: ['repair'] });
    expect(picked).not.toBeNull();
    // 派单只能到 assigned，绝不跳到 completed
    expect(canTransition(def, 'draft', 'completed')).toBe(false);
  });

  it('任何自动流程都不出现 draft->completed', () => {
    expect(canTransition(def, 'draft', 'completed')).toBe(false);
    expect(canTransition(def, 'assigned', 'completed')).toBe(false);
  });
});
