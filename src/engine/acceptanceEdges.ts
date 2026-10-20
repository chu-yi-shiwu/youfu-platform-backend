// 验收边注入（注册制批次三）：给 work_order workflow_def 追加两条验收转移边。
// 纯加法模块——不触碰 stateMachine.ts 既有状态/边；本文件只提供常量与幂等注入纯函数。
//   - acceptance_pass: completed → closed（验收合格，闭环）
//   - acceptance_reject: completed → processing（验收不合格，退回返工；SLA 由验收端点重置）
// 注入策略：仅当同 from+event 的边不存在时追加（幂等）；同时确保目标态在 def.states 中
// （如 DEFAULT 4 态图缺 closed），避免注入后 isKnownState 校验拒绝合法目标态。
import type { WorkflowDef, WorkflowTransition } from './stateMachine.js';

/**
 * 验收两条边（allowedRoles 与验收端点角色门禁一致：admin/operator/reviewer）。
 *
 * 地基第二步（用户拍板 2026-10-16）：验收与审核**同口径**改为"可叠加权限属性"——
 * 追加 allowedPerms:['workflow.approve']。判定为 allowedRoles ∪ allowedPerms **并集**，
 * 故 admin/operator/reviewer 三条老路径逐字不变（存量零回归），
 * 新增的是"租户把 workflow.approve 授给任意角色（含自建岗位）→ 该角色即可验收"。
 *
 * 【命名纪律】此处**沿用既有权限点** workflow.approve（role.ts:26 PERMS 清单已登记），
 * 未新造权限点名：验收通过/驳回本就是审批动作，与 workflowDef 的审批端点同语义族。
 * 若产品要求"验收"与"流程配置审批"拆成两个独立权限点，需产品给定权限点名后再拆。
 * 【存量】租户已落库的 def 不含 allowedPerms → 由 091 迁移回填（本常量只影响新注入的 def）。
 */

/** 验收事件名单一事实源：服务层(Event钉死)与本常量(边定义)必须同源，不得各写字面量。 */
export const ACCEPTANCE_PASS_EVENT = 'acceptance_pass';
export const ACCEPTANCE_REJECT_EVENT = 'acceptance_reject';

export const ACCEPTANCE_EDGES: readonly WorkflowTransition[] = [
  { from: 'completed', to: 'closed', event: ACCEPTANCE_PASS_EVENT, allowedRoles: ['admin', 'operator', 'reviewer'], allowedPerms: ['workflow.approve'] },
  { from: 'completed', to: 'processing', event: ACCEPTANCE_REJECT_EVENT, allowedRoles: ['admin', 'operator', 'reviewer'], allowedPerms: ['workflow.approve'] },
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

/**
 * F10：验收起止态由 def 派生，不写字面量。
 *
 * 【为什么】services/acceptance.ts 此前把三个状态名写死在代码里：
 *   `if (status !== 'completed') 409` 与 `toStatus = pass ? 'closed' : 'processing'`。
 *   而验收边本体（ACCEPTANCE_EDGES）里的 from/to 才是租户流程里的真实名字——租户在
 *   配置中心把验收边改成 `review_passed → archived`（例如他们的完成态就叫 archived），
 *   注入与字典都认，唯独服务层不认：单已到 archived 却在守卫里报「仅已完成工单可验收」，
 *   且收尾硬写 'closed' → isKnownState 拒绝 = 验收按钮彻底不可用、单据卡在最后一步。
 *   这与 F9 的统计口径、F8 的挂起态同款「写了两处，其中一处是死的」。
 *   修法同一哲学：**边怎么写的，服务层就怎么走**。
 */
export function acceptanceEventFor(result: 'pass' | 'reject'): string {
  return result === 'pass' ? ACCEPTANCE_PASS_EVENT : ACCEPTANCE_REJECT_EVENT;
}

/** 可验收的起态集合（def 中 acceptance_* 边的 from）。无边时返回空数组（守卫按"不可验收"处理）。 */
export function acceptanceFromStates(def: WorkflowDef): string[] {
  const events: string[] = [ACCEPTANCE_PASS_EVENT, ACCEPTANCE_REJECT_EVENT];
  const froms = new Set<string>();
  for (const t of def.transitions ?? []) {
    if (events.includes(t.event)) froms.add(t.from);
  }
  return [...froms];
}

/** 收尾目标态（def 中对应 acceptance 边的 to）；无边返回 null，调用方必须显式报错。 */
export function acceptanceTargetStatus(def: WorkflowDef, result: 'pass' | 'reject'): string | null {
  const ev = acceptanceEventFor(result);
  const hit = (def.transitions ?? []).find((t) => t.event === ev);
  return hit ? hit.to : null;
}
