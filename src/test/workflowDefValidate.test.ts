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

// ============ 地基第二步补漏：角色/权限 ↔ 流程 的联动校验 ============
// 用户要求"角色、权限的非代码级写入与可配置 + 业务流程可配置"，两者必须闭环：
// 租户在流程里填写的角色名/权限点若无人校验，写错即**永久门死该条流转且零提示**。
describe('流程配置的角色/权限引用校验（地基第二步补漏）', () => {
  const withEdge = (over: Record<string, unknown>) => ({
    ...BASE_DEF,
    transitions: [{ from: 'draft', to: 'assigned', event: 'assign', ...over }],
  });

  it('allowedPerms 引用未登记的权限点 → 422（拼错/臆造一律挡住）', () => {
    expect(() => validateWorkflowDef(withEdge({ allowedPerms: ['workflow.aprove'] }) as never)).toThrow(/未登记的权限点/);
  });

  it('allowedPerms 引用合法权限点（workflow.approve）→ 放行', () => {
    expect(() => validateWorkflowDef(withEdge({ allowedPerms: ['workflow.approve'] }) as never)).not.toThrow();
  });

  it('allowedRoles 引用内置角色 → 放行（同步层不查库）', () => {
    expect(() => validateWorkflowDef(withEdge({ allowedRoles: ['admin', 'worker'] }) as never)).not.toThrow();
  });

  it('改造前的漏洞（对照）：同形状但不存在的角色，同步层不该挡（由异步 assertWorkflowDefRolesUsable 挡）', () => {
    // 同步层只管形状与权限点；存在性需查 role_def，交给异步校验（见下组）
    expect(() => validateWorkflowDef(withEdge({ allowedRoles: ['repair_lead'] }) as never)).not.toThrow();
  });
});

describe('assertWorkflowDefRolesUsable（异步角色存在性 · 只拦增量错字）', () => {
  const mkClient = (existing: string[]) => ({
    query: async (_sql: string, _p: unknown[]) => ({ rows: existing.map((code) => ({ code })), rowCount: existing.length }),
  });

  const edge = (roles: string[]) => ({
    ...BASE_DEF,
    transitions: [{ from: 'draft', to: 'assigned', event: 'assign', allowedRoles: roles }],
  });

  it('allowedRoles 形状非法（大写/连字符）→ 422（脏名字不得进流程）', async () => {
    const { assertWorkflowDefRolesUsable } = await import('../engine/workflowDef.js');
    await expect(
      assertWorkflowDefRolesUsable(mkClient(['Repair-Lead']) as never, 't1', edge(['Repair-Lead']) as never),
    ).rejects.toThrow(/形状非法的角色名/);
  });

  it('引用已创建的自定义角色 → 放行（建了就能用，闭环成立）', async () => {
    const { assertWorkflowDefRolesUsable } = await import('../engine/workflowDef.js');
    await expect(assertWorkflowDefRolesUsable(mkClient(['repair_lead']) as never, 't1', edge(['repair_lead']) as never)).resolves.toBeUndefined();
  });

  it('引用未创建的角色 → 422（挡住"永久门死"的配置事故）', async () => {
    const { assertWorkflowDefRolesUsable } = await import('../engine/workflowDef.js');
    await expect(assertWorkflowDefRolesUsable(mkClient([]) as never, 't1', edge(['repair_lead']) as never)).rejects.toThrow(/不存在的角色/);
  });

  it('内置角色无需在 role_def 里 → 放行', async () => {
    const { assertWorkflowDefRolesUsable } = await import('../engine/workflowDef.js');
    await expect(assertWorkflowDefRolesUsable(mkClient([]) as never, 't1', edge(['admin', 'worker']) as never)).resolves.toBeUndefined();
  });

  it('存量豁免：oldDef 里已有的角色名即便已不在 role_def，也不拦（防存量保存被挡=生产事故）', async () => {
    const { assertWorkflowDefRolesUsable } = await import('../engine/workflowDef.js');
    const oldDef = edge(['ghost_role']);
    await expect(
      assertWorkflowDefRolesUsable(mkClient([]) as never, 't1', edge(['ghost_role']) as never, oldDef as never),
    ).resolves.toBeUndefined();
  });

  it('存量豁免只赦旧不赦新：同一个旧角色 + 一个新错字 → 仍挡', async () => {
    const { assertWorkflowDefRolesUsable } = await import('../engine/workflowDef.js');
    const oldDef = edge(['ghost_role']);
    await expect(
      assertWorkflowDefRolesUsable(mkClient([]) as never, 't1', edge(['ghost_role', 'typo_role']) as never, oldDef as never),
    ).rejects.toThrow(/不存在的角色/);
  });
});
