// 抢单大厅机制态注入（V2-F7，2026-09-14 · 派单纵切 P0 补遗）：
// ─────────────────────────────────────────────────────────────────────────────
// P0 机理：抢单大厅（claim_hall）是引擎的滴滴式兜底机制——派单未命中时
// workOrder.ts / linkedWorkOrder.ts 直接 UPDATE status='claim_hall'（旁路，
// 不走 transition()）。但 DEFAULT_WORK_ORDER_DEF 是最小 4 态图（无 claim_hall），
// 租户自定义 def 亦常无此态 ⇒ 单落入「def 不认识的状态」后：
//   transition() 内 isKnownState(def, 'claim_hall') = false → 任何出厅流转 422，
//   工单在大厅合法进、非法出，永久卡死（claim 端点是旁路 UPDATE 能出，但
//   走 transition() 的 dispatch/cancel 全被堵）。
//
// 修法（与 acceptanceEdges 同构的幂等注入，纯加法不触碰既有状态/边）：
// 在 workflow_def 读路径（getWorkflowDefOrDefault / ensureWorkflowDef）与
// 开通落库（tenantProvision）注入 claim_hall 态 + 三条出边。
// 取舍（二选一之方案 A）：不采用「落大厅前查 def 不含则改落+通知」——
//   方案 B 只防新增，存量已落大厅的非法单修不了；且抢单大厅是引擎机制
//   兜底而非租户业务态，注入的是"引擎真实行为空间"的诚实呈现。
// 与 acceptanceEdges 的差异：验收边注入只补边+目标态，本函数还需补 from 态本身。
// ─────────────────────────────────────────────────────────────────────────────
import type { WorkflowDef, WorkflowTransition } from './stateMachine.js';

/** 抢单大厅机制态名（与 RICH_WORK_ORDER_DEF 预置态同名，注入幂等）。 */
export const CLAIM_HALL_STATE = 'claim_hall';

/** 大厅三条出边（与 stateMachine.ts RICH def 预置边逐字一致，角色门禁同源）。 */
export const CLAIM_HALL_EDGES: readonly WorkflowTransition[] = [
  { from: 'claim_hall', to: 'assigned', event: 'claim', allowedRoles: ['worker', 'admin', 'dispatcher', 'service_desk'] },
  { from: 'claim_hall', to: 'assigned', event: 'dispatch', requiredFields: ['assignee'], allowedRoles: ['admin', 'dispatcher', 'service_desk'] },
  { from: 'claim_hall', to: 'cancelled', event: 'cancel', requiredFields: ['cancel_reason'], allowedRoles: ['admin', 'dispatcher'] },
] as const;

export interface EnsureClaimHallStateResult {
  /** 注入后的 def（深拷贝，不改入参）。 */
  def: WorkflowDef;
  /** 本次实际新增的状态（空数组 = 态已存在）。 */
  addedStates: string[];
  /** 本次实际新增的边（空数组 = 已存在，幂等 no-op）。 */
  added: WorkflowTransition[];
}

/**
 * 幂等注入抢单大厅机制态（纯函数）：返回新 def（深拷贝）与实际新增清单。
 * - states 缺 claim_hall → 补入（保证 isKnownState 通过，transition 不再 422）；
 * - 同 from+event 的边已存在 → 跳过（幂等，二次调用 added 为空）；
 * - 注入不触碰租户既有状态/边，纯加法。
 */
export function ensureClaimHallState(def: WorkflowDef): EnsureClaimHallStateResult {
  const next: WorkflowDef = JSON.parse(JSON.stringify(def));
  if (!Array.isArray(next.states)) next.states = [];
  if (!Array.isArray(next.transitions)) next.transitions = [];
  const addedStates: string[] = [];
  const added: WorkflowTransition[] = [];
  if (!next.states.includes(CLAIM_HALL_STATE)) {
    next.states.push(CLAIM_HALL_STATE);
    addedStates.push(CLAIM_HALL_STATE);
  }
  for (const edge of CLAIM_HALL_EDGES) {
    const exists = next.transitions.some((t) => t.from === edge.from && t.event === edge.event);
    if (exists) continue;
    next.transitions.push({ ...edge });
    if (!next.states.includes(edge.to)) next.states.push(edge.to);
    added.push({ ...edge });
  }
  return { def: next, addedStates, added };
}

/** def 是否已具备大厅态与三条出边（幂等检查用；RICH def 天然为 true）。 */
export function hasClaimHallState(def: WorkflowDef): boolean {
  if (!Array.isArray(def.states) || !def.states.includes(CLAIM_HALL_STATE)) return false;
  if (!Array.isArray(def.transitions)) return false;
  return CLAIM_HALL_EDGES.every((e) =>
    def.transitions.some((t) => t.from === e.from && t.event === e.event),
  );
}
