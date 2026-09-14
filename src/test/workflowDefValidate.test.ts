// 纵切修复批次 V1（2026-09-14）纵切③ P0-2：validateWorkflowDef 写入口校验收口（纯函数单测）。
// 三项校验：①initial∈states ②transitions from/to∈states ③autoRoutes.to ∈ states 且非 done/terminal 态
// （派单目标态禁止直达终态——P0-2 根因：autoRoutes.to='completed' 绕过处理/验收全链路自动闭环）。
import { describe, it, expect } from 'vitest';

const { validateWorkflowDef } = await import('../engine/workflowDef.js');
const { DEFAULT_WORK_ORDER_DEF, RICH_WORK_ORDER_DEF } = await import('../engine/stateMachine.js');

const BASE_DEF = {
  initial: 'draft',
  states: ['draft', 'assigned', 'processing', 'completed'],
  transitions: [
    { from: 'draft', to: 'assigned', event: 'assign' },
    { from: 'assigned', to: 'processing', event: 'start' },
    { from: 'processing', to: 'completed', event: 'complete' },
  ],
  config: {},
};

function def(over: Record<string, unknown>) {
  return { ...BASE_DEF, ...over } as any;
}

describe('validateWorkflowDef（纵切③ P0-2 校验收口）', () => {
  it('合法 def（含 autoRoutes.to=assigned）→ 通过不抛', () => {
    expect(() =>
      validateWorkflowDef(
        def({ config: { autoRoutes: { draft: { to: 'assigned' } } } }),
      ),
    ).not.toThrow();
  });

  it('① initial 不在 states → 422 BAD_REQUEST', () => {
    try {
      validateWorkflowDef(def({ initial: 'nowhere' }));
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e.code).toBe('BAD_REQUEST');
      expect(e.status).toBe(422);
      expect(String(e.message)).toContain('nowhere');
    }
  });

  it('② transition 指向未声明状态 → 422 BAD_REQUEST', () => {
    const bad = def({
      transitions: [...BASE_DEF.transitions, { from: 'processing', to: 'ghost', event: 'oops' }],
    });
    try {
      validateWorkflowDef(bad);
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e.code).toBe('BAD_REQUEST');
      expect(e.status).toBe(422);
      expect(String(e.message)).toContain('ghost');
    }
  });

  it('② transition from 未声明状态 → 422 BAD_REQUEST', () => {
    const bad = def({
      transitions: [{ from: 'ghost', to: 'assigned', event: 'oops' }],
    });
    expect(() => validateWorkflowDef(bad)).toThrow(/unknown state/);
  });

  it('③ P0-2 核心：autoRoutes.to=completed（完成态）→ 422，禁止自动派单直达终态', () => {
    const bad = def({ config: { autoRoutes: { draft: { to: 'completed' } } } });
    try {
      validateWorkflowDef(bad);
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e.code).toBe('BAD_REQUEST');
      expect(e.status).toBe(422);
      expect(String(e.message)).toContain('终态');
    }
  });

  it('③ autoRoutes.to 是终态但非 doneState（无出向转移的态）→ 同样 422', () => {
    // terminalStates = 无出向转移的状态；'processing' 有出边不是终态，给 states 加一个孤岛态 'archived'
    const bad = def({
      states: [...BASE_DEF.states, 'archived'],
      config: { autoRoutes: { draft: { to: 'archived' } } },
    });
    try {
      validateWorkflowDef(bad);
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e.code).toBe('BAD_REQUEST');
      expect(e.status).toBe(422);
    }
  });

  it('③ autoRoutes.to 不在 states → 422（与 autoRouteFor 运行时兜底双保险）', () => {
    expect(() => validateWorkflowDef(def({ config: { autoRoutes: { draft: { to: 'nowhere' } } } }))).toThrow(
      /not in states/,
    );
  });

  it('③ doneStates 口径生效：config.doneStates 含非终态 completed 也被禁', () => {
    // DEFAULT def：completed 是 doneState 也是 terminalState；RICH def：completed 非终态但是 doneState —— 两口径都必须禁
    const richLike = {
      initial: 'draft',
      states: ['draft', 'assigned', 'completed', 'closed'],
      transitions: [
        { from: 'draft', to: 'assigned', event: 'assign' },
        { from: 'assigned', to: 'completed', event: 'complete' },
        { from: 'completed', to: 'closed', event: 'close' },
      ],
      config: {
        doneStates: ['completed', 'closed'],
        autoRoutes: { draft: { to: 'completed' } }, // completed 非终态（有出边）但是 doneState → 必须禁
      },
    };
    try {
      validateWorkflowDef(richLike as any);
      expect.unreachable('should have thrown');
    } catch (e: any) {
      expect(e.status).toBe(422);
    }
  });

  it('内置 def 不被新校验误伤：DEFAULT / RICH 均通过（防上线即崩）', () => {
    expect(() => validateWorkflowDef(DEFAULT_WORK_ORDER_DEF)).not.toThrow();
    expect(() => validateWorkflowDef(RICH_WORK_ORDER_DEF)).not.toThrow();
  });
});
