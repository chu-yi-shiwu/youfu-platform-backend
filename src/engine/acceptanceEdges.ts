// 验收边注入（注册制批次三）：给 work_order workflow_def 追加两条验收转移边。
// 纯加法模块——不触碰 stateMachine.ts 既有状态/边；本文件只提供常量与幂等注入纯函数。
//   - acceptance_pass: completed → closed（验收合格，闭环）
//   - acceptance_reject: completed → processing（验收不合格，退回返工；SLA 由验收端点重置）
// 注入策略：仅当同 from+event 的边不存在时追加（幂等）；同时确保目标态在 def.states 中
// （如 DEFAULT 4 态图缺 closed），避免注入后 isKnownState 校验拒绝合法目标态。
import type { WorkflowDef, WorkflowTransition } from './stateMachine.js';

/** 验收两条边（allowedRoles 与验收端点角色门禁一致：admin/operator/reviewer）。 */
export const ACCEPTANCE_EDGES: readonly WorkflowTransition[] = [
  { from: 'completed', to: 'closed', event: 'acceptance_pass', allowedRoles: ['admin', 'operator', 'reviewer'] },
  { from: 'completed', to: 'processing', event: 'acceptance_reject', allowedRoles: ['admin', 'operator', 'reviewer'] },
] as const;

/** 验收事件前缀（Y3 防后门判定与目标态解析共用）。 */
export const ACCEPTANCE_EVENT_PREFIX = 'acceptance_';

export interface EnsureAcceptanceEdgesResult {
  /** 注入后的 def（深拷贝，不改入参）。 */
  def: WorkflowDef;
  /** 本次实际新增的边（空数组 = 已存在，幂等 no-op）。 */
  added: WorkflowTransition[];
}

/**
 * 幂等注入验收边（纯函数）：返回新 def（深拷贝）与实际新增边清单。
 * - 同 from+event 的边已存在 → 跳过（幂等，二次调用 added 为空）；
 * - 注入某条边时，若其目标态不在 def.states 中则一并补入（保证 isKnownState 通过）。
 */
export function ensureAcceptanceEdges(def: WorkflowDef): EnsureAcceptanceEdgesResult {
  const next: WorkflowDef = JSON.parse(JSON.stringify(def));
  if (!Array.isArray(next.states)) next.states = [];
  if (!Array.isArray(next.transitions)) next.transitions = [];
  const added: WorkflowTransition[] = [];
  for (const edge of ACCEPTANCE_EDGES) {
    const exists = next.transitions.some((t) => t.from === edge.from && t.event === edge.event);
    if (exists) continue;
    next.transitions.push({ ...edge });
    if (!next.states.includes(edge.to)) next.states.push(edge.to);
    added.push({ ...edge });
  }
  return { def: next, added };
}

/** def 是否已具备两条验收边（幂等检查用）。 */
export function hasAcceptanceEdges(def: WorkflowDef): boolean {
  if (!Array.isArray(def.transitions)) return false;
  return ACCEPTANCE_EDGES.every((e) =>
    def.transitions.some((t) => t.from === e.from && t.event === e.event),
  );
}
