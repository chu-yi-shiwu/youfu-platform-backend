import { describe, it, expect } from 'vitest';
import {
  canTransition, nextStates, DEFAULT_WORK_ORDER_DEF, RICH_WORK_ORDER_DEF,
  learningTriggerStates, autoRouteFor, autoRouteStates, shouldTriggerLearning,
  type WorkflowDef,
} from '../engine/stateMachine.js';

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

describe('④⑤ per-def 模数共振（learningTriggers / autoRoutes 真正生效）', () => {
  it('learningTriggerStates：未声明时回退 doneStates（向后兼容）', () => {
    // DEFAULT 无 learningTriggers → 回退 doneStates ['completed']
    expect(learningTriggerStates(DEFAULT_WORK_ORDER_DEF)).toEqual(['completed']);
    // 自定义仅声明 doneStates、无 learningTriggers → 同样回退
    const onlyDone: WorkflowDef = {
      initial: 'draft', states: ['draft', 'completed'], transitions: [],
      config: { doneStates: ['completed'] },
    };
    expect(learningTriggerStates(onlyDone)).toEqual(['completed']);
  });

  it('learningTriggerStates：声明后按 def 控制，且过滤不在 states 的非法态', () => {
    const custom: WorkflowDef = {
      initial: 'draft',
      states: ['draft', 'assigned', 'review_passed', 'completed'],
      transitions: [],
      config: { learningTriggers: ['review_passed', 'bogus_state'] },
    };
    expect(learningTriggerStates(custom)).toEqual(['review_passed']);
  });

  it('RICH 模板的 learningTriggers 已真实声明（completed/review_passed）', () => {
    expect(RICH_WORK_ORDER_DEF.config?.learningTriggers).toEqual(['completed', 'review_passed']);
    expect(learningTriggerStates(RICH_WORK_ORDER_DEF)).toEqual(['completed', 'review_passed']);
  });

  it('autoRouteFor：合法声明返回目标态与策略', () => {
    expect(autoRouteFor(RICH_WORK_ORDER_DEF, 'draft')).toEqual({ to: 'assigned', strategy: 'least_load' });
  });

  it('autoRouteFor：目标态不在 states 视为无效（返回 null），防止坏配置污染派发', () => {
    const bad: WorkflowDef = {
      initial: 'draft',
      states: ['draft', 'assigned'],
      transitions: [],
      config: { autoRoutes: { draft: { to: 'nowhere' } } },
    };
    expect(autoRouteFor(bad, 'draft')).toBeNull();
  });

  it('shouldTriggerLearning：首次踏入触发态触发，已在触发态则不重复触发', () => {
    // RICH 触发集 = ['completed','review_passed']
    const learnOn = ['completed', 'review_passed'];
    // 从 processing 进入 completed：首次踏入 → 触发
    expect(shouldTriggerLearning('completed', 'processing', learnOn)).toBe(true);
    // 从 completed 进入 closed：from 已在触发集（completed 在 learnOn）→ 不触发（避免双学习）
    expect(shouldTriggerLearning('closed', 'completed', learnOn)).toBe(false);
    // to 不在触发集 → 不触发
    expect(shouldTriggerLearning('processing', 'assigned', learnOn)).toBe(false);
    // review_passed → evaluated：from 在触发集 → 不重复触发
    expect(shouldTriggerLearning('evaluated', 'review_passed', learnOn)).toBe(false);
  });

  it('autoRouteFor：未声明返回 null', () => {
    expect(autoRouteFor(DEFAULT_WORK_ORDER_DEF, 'draft')).toBeNull();
  });

  it('autoRouteStates：仅列出合法 autoRoute 的初态', () => {
    expect(autoRouteStates(RICH_WORK_ORDER_DEF)).toEqual(['draft']);
  });

  it('autoRoutes 缺省时 autoRouteStates 为空（创建派发保持旧行为）', () => {
    expect(autoRouteStates(DEFAULT_WORK_ORDER_DEF)).toEqual([]);
  });
});

