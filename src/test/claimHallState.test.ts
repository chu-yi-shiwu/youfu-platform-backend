// V2-F7（2026-09-14）：抢单大厅机制态注入回归护栏。
// P0 机理：引擎派单未命中兜底把单直落 claim_hall（旁路 UPDATE），但最小 4 态 def
// 无此态 ⇒ transition() isKnownState 拒绝，出厅流转全 422（合法进、非法出，大厅卡死）。
// 修复：engine/claimHallEdges.ts ensureClaimHallState（与 acceptanceEdges 同构幂等注入）
// 挂到 workflow_def 读路径（getWorkflowDefOrDefault/ensureWorkflowDef）+ 开通落库注入。
// 本文件锚定：
//   1) 纯函数注入/幂等/RICH no-op/深拷贝/过写入口校验；
//   2) 修复前机理对照：原始 4 态 def 下 isKnownState=false、applyEvent=null（transition 必 422）；
//   3) 端到端①：4 态 def 租户派单未命中 → 落大厅（真实 autoDispatchAfterCreate）；
//   4) 端到端②：同一 4 态 def → 真实 transition() 从 claim_hall 出厅（cancel→cancelled /
//      dispatch→assigned），修复后不再 422。
import { describe, it, expect, vi } from 'vitest';

const { ensureClaimHallState, hasClaimHallState, CLAIM_HALL_EDGES, CLAIM_HALL_STATE } =
  await import('../engine/claimHallEdges.js');
const { DEFAULT_WORK_ORDER_DEF, RICH_WORK_ORDER_DEF, isKnownState, applyEvent } =
  await import('../engine/stateMachine.js');
const { validateWorkflowDef, getWorkflowDefOrDefault } = await import('../engine/workflowDef.js');
const { transition } = await import('../repo/ticket.js');
const { autoDispatchAfterCreate } = await import('../routes/workOrder.js');

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;

function makeClient(handler: QueryFn) {
  const calls: Array<{ text: string; params?: any[] }> = [];
  return {
    client: {
      query: vi.fn(async (text: string, params?: any[]) => {
        calls.push({ text, params });
        return handler(text, params);
      }),
    } as any,
    calls,
  };
}

// 最小 4 态租户 def（= DEFAULT 落库形态：无 claim_hall）
const FOUR_STATE_DEF = {
  initial: 'draft',
  states: ['draft', 'assigned', 'processing', 'completed'],
  transitions: [
    { from: 'draft', to: 'assigned', event: 'assign' },
    { from: 'assigned', to: 'processing', event: 'start' },
    { from: 'processing', to: 'completed', event: 'complete' },
  ],
  config: { doneStates: ['completed'] },
};

describe('ensureClaimHallState（纯函数 · 与 acceptanceEdges 同构）', () => {
  it('4 态 def 注入：states 补 claim_hall + 三条出边（claim/dispatch/cancel）', () => {
    const { def, addedStates, added } = ensureClaimHallState(FOUR_STATE_DEF as any);
    expect(def.states).toContain('claim_hall');
    expect(addedStates).toEqual(['claim_hall']);
    expect(added.map((e) => e.event).sort()).toEqual(['cancel', 'claim', 'dispatch']);
    for (const edge of CLAIM_HALL_EDGES) {
      const t = def.transitions.find((x: any) => x.from === CLAIM_HALL_STATE && x.event === edge.event)!;
      expect(t).toBeDefined();
      expect(t.to).toBe(edge.to);
      expect(t.allowedRoles).toEqual(edge.allowedRoles); // 角色门禁与 RICH def 同源
    }
    // 注入后过写入口校验（claim_hall 有出边非终态，不触发 autoRoutes 违例）
    expect(() => validateWorkflowDef(def)).not.toThrow();
  });

  it('幂等：二次注入 added 为空（no-op）；RICH def 天然具备 → no-op', () => {
    const once = ensureClaimHallState(FOUR_STATE_DEF as any).def;
    const twice = ensureClaimHallState(once);
    expect(twice.addedStates).toEqual([]);
    expect(twice.added).toEqual([]);
    // RICH 15 态 def 预置了 claim_hall 与同三条边 → 纯 no-op
    const rich = ensureClaimHallState(RICH_WORK_ORDER_DEF);
    expect(rich.addedStates).toEqual([]);
    expect(rich.added).toEqual([]);
    expect(hasClaimHallState(rich.def)).toBe(true);
    expect(hasClaimHallState(FOUR_STATE_DEF as any)).toBe(false);
  });

  it('深拷贝：不改入参（acceptanceEdges 同构约束）', () => {
    const before = JSON.stringify(FOUR_STATE_DEF);
    ensureClaimHallState(FOUR_STATE_DEF as any);
    expect(JSON.stringify(FOUR_STATE_DEF)).toBe(before);
  });

  it('🔴 修复前机理对照：原始 4 态 def 下 claim_hall 是未知态，出厅事件解析为 null（transition 必 422）', () => {
    expect(isKnownState(DEFAULT_WORK_ORDER_DEF, 'claim_hall')).toBe(false);
    expect(applyEvent(DEFAULT_WORK_ORDER_DEF, 'claim_hall', 'cancel')).toBeNull();
    expect(applyEvent(DEFAULT_WORK_ORDER_DEF, 'claim_hall', 'dispatch')).toBeNull();
  });
});

describe('端到端：4 态 def 租户 派单未命中 → 落大厅 → transition 出厅', () => {
  it('派单未命中（无工人）→ 真实 autoDispatchAfterCreate 落 claim_hall（读路径注入不影响落厅行为）', async () => {
    const { client, calls } = makeClient(async (text: string) => {
      if (text.includes('FROM worker WHERE tenant_id')) return { rows: [] };
      if (text.includes('SELECT def FROM workflow_def')) return { rows: [] }; // 无 def 行 → DEFAULT → 注入
      return { rows: [] };
    });
    const r = await autoDispatchAfterCreate(
      client, 't-4state',
      { id: 'wo-hall-1', order_no: 'WO_20260914_0000000009' },
      { business_type: 'repair', skill_tags: ['plumbing'], priority: 'normal' },
    );
    expect(r.autoFlow).toBe(false);
    expect(r.assignee).toBeNull();
    const statusUpd = calls.find((c) => c.text.includes('UPDATE work_orders SET status'));
    expect(statusUpd?.params?.[0]).toBe('claim_hall');
  });

  it('🔴 核心回归：真实 transition() 从 claim_hall cancel 出厅（4 态 def，读路径注入生效，不再 422）', async () => {
    const { client, calls } = makeClient(async (text: string) => {
      if (text.includes('FOR UPDATE')) {
        return { rows: [{ id: 'wo-hall-1', tenant_id: 't-4state', order_no: 'WO_1', status: 'claim_hall', assignee_id: null }] };
      }
      // def 行 = 4 态（无 claim_hall）→ 真实 getWorkflowDefOrDefault 内注入
      if (text.includes('SELECT def FROM workflow_def')) return { rows: [{ def: FOUR_STATE_DEF }] };
      if (text.includes('UPDATE work_orders SET status')) {
        return { rows: [{ id: 'wo-hall-1', status: 'cancelled' }] };
      }
      return { rows: [] }; // INSERT ticket_event / domain_event
    });
    const r = await transition(
      client, 't-4state', 'wo-hall-1', 'cancelled',
      { actor: 'admin', role: 'admin', fields: { cancel_reason: '误报作废' } },
    );
    // 修复前：isKnownState(def,'claim_hall')=false → 422 unknown state（卡死在大厅）
    // 修复后：注入生效，边解析成功，事件=cancel，目标态=cancelled
    expect(r.from).toBe('claim_hall');
    expect(r.transition?.event).toBe('cancel');
    expect(r.row.status).toBe('cancelled');
    const evt = calls.find((c) => c.text.includes('INSERT INTO ticket_event'));
    expect(evt?.params?.[2]).toBe('claim_hall');
    expect(evt?.params?.[3]).toBe('cancelled');
  });

  it('真实 transition() 从 claim_hall dispatch 出厅 → assigned + worker load+1（大厅积压可人工派单消化）', async () => {
    const { client, calls } = makeClient(async (text: string) => {
      if (text.includes('FOR UPDATE')) {
        return { rows: [{ id: 'wo-hall-2', tenant_id: 't-4state', order_no: 'WO_2', status: 'claim_hall', assignee_id: null }] };
      }
      if (text.includes('SELECT def FROM workflow_def')) return { rows: [{ def: FOUR_STATE_DEF }] };
      if (text.includes('SELECT 1 FROM worker')) return { rows: [{ ok: 1 }], rowCount: 1 };
      if (text.includes('UPDATE work_orders SET status')) {
        return { rows: [{ id: 'wo-hall-2', status: 'assigned', assignee_id: 'wk-9' }] };
      }
      return { rows: [] }; // load+1 / 影子回填 / 事件
    });
    const r = await transition(
      client, 't-4state', 'wo-hall-2', 'assigned',
      // from+to 解析取首条同目标边（claim，与 RICH def 行为一致）；人工派单场景用
      // eventOverride 钉死 dispatch 边（repo/ticket.ts 批次三纯加法参数）
      { actor: 'admin', role: 'admin', fields: { assignee: 'wk-9' }, eventOverride: 'dispatch' },
    );
    expect(r.transition?.event).toBe('dispatch');
    expect(r.row.status).toBe('assigned');
    expect(calls.find((c) => c.text.includes('UPDATE worker SET load'))).toBeTruthy();
  });

  it('读路径注入只作用于 work_order：其它 entityType 不被加态', async () => {
    const { client } = makeClient(async (text: string) => {
      if (text.includes('SELECT def FROM workflow_def')) return { rows: [{ def: FOUR_STATE_DEF }] };
      return { rows: [] };
    });
    const def = await getWorkflowDefOrDefault(client, 't-4state', 'business_flow_tasks', FOUR_STATE_DEF as any);
    expect(def.states).not.toContain('claim_hall');
  });
});
