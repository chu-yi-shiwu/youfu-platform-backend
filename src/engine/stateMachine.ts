// 可配置状态机引擎（T-① · 设计支柱②：单引擎 + 状态图存 DB 零代码配）。
// 取代原固定 4 态字典；合法跳转由 WorkflowDef 声明，支持运行期动态增状态/转移
// （如 C1 优化建议注入的 recheck / escalated），契合"流程零代码配置"。
//
// 红线保留：引擎只做"是否合法"判定，绝不自动把状态推进到终态
// （completed / escalated 必须由显式事件驱动；P6 验收只报自动派单率，不自动闭环）。

export type WorkOrderStatus = string; // 放宽：状态集合由 workflow_def 声明，不再写死枚举

export interface WorkflowTransition {
  from: string;
  to: string;
  event: string;
  // A+ 扩展：把 UOne 流转"规则粒度"建模进可配置（老系统写死，此处可配）
  requiredFields?: string[]; // 该流转必填字段（缺失 → 422）
  allowedRoles?: string[];   // 允许执行的角色；为空/未定义 = 租户内任意已认证用户可走（向后兼容，避免门死自己）
  sideEffects?: string[];    // 副作用标记：pause_sla / resume_sla / notify_*（真实落库或记录）
}

export interface WorkflowDef {
  initial: string;
  states: string[];
  transitions: WorkflowTransition[];
  config?: Record<string, unknown>;
}

// work_order 默认状态图（最小 4 态，仅作无 workflow_def 行时的兜底，不绑死租户）。
// 富粒度流程由 Phase 2 种子脚本以 RICH_WORK_ORDER_DEF upsert 到具体租户（如 t-verification）。
export const DEFAULT_WORK_ORDER_DEF: WorkflowDef = {
  initial: 'draft',
  states: ['draft', 'assigned', 'processing', 'completed'],
  transitions: [
    { from: 'draft', to: 'assigned', event: 'assign' },
    { from: 'assigned', to: 'processing', event: 'start' },
    { from: 'processing', to: 'completed', event: 'complete' },
  ],
  config: { doneStates: ['completed'] }, // 完成态口径（成功结束）；兜底=终态减废弃态
};

// 富 13 态模板（取 UOne 工单全生命周期之所长）：受理→派单→接单→处理→(暂停/挂起)→审核→完成→关闭→评价，
// 外加各活跃态可撤销。差异化：老系统写死流程，此处流程存 workflow_def，可配置、可租户定制（设计支柱②）。
// 包含旧 4 态兼容路径，保证历史工单(draft/assigned/processing/completed)在富模板下仍可流转。
export const RICH_WORK_ORDER_DEF: WorkflowDef = {
  initial: 'draft',
  states: [
    'draft',           // 草稿/新建
    'pending_accept',  // 待受理
    'pending_dispatch', // 待派单
    'assigned',        // 已派单/待接收
    'processing',      // 处理中
    'paused',          // 暂停中
    'suspended',       // 已挂起
    'pending_review',  // 待审核
    'review_passed',   // 审核通过
    'completed',       // 已完成
    'closed',          // 已关闭
    'cancelled',       // 已撤销
    'evaluated',       // 已评价
  ],
  transitions: [
    // —— 兼容旧 4 态（历史工单 / 无模板租户可用）——
    { from: 'draft', to: 'assigned', event: 'assign' },
    { from: 'assigned', to: 'processing', event: 'start' },
    { from: 'processing', to: 'completed', event: 'complete' },
    // —— UOne 粒度主干（取之所长）——
    { from: 'draft', to: 'pending_accept', event: 'submit' },
    { from: 'pending_accept', to: 'pending_dispatch', event: 'accept', allowedRoles: ['admin', 'dispatcher', 'service_desk'] },
    { from: 'pending_dispatch', to: 'assigned', event: 'dispatch', allowedRoles: ['admin', 'dispatcher', 'service_desk'], requiredFields: ['assignee'] },
    { from: 'assigned', to: 'processing', event: 'receive', allowedRoles: ['admin', 'worker'] },
    { from: 'assigned', to: 'pending_dispatch', event: 'return', requiredFields: ['return_reason'] },
    { from: 'processing', to: 'paused', event: 'pause', sideEffects: ['pause_sla'] },
    { from: 'paused', to: 'processing', event: 'resume', sideEffects: ['resume_sla'] },
    { from: 'processing', to: 'suspended', event: 'suspend', requiredFields: ['suspend_reason'], sideEffects: ['pause_sla'] },
    { from: 'suspended', to: 'processing', event: 'resume', sideEffects: ['resume_sla'] },
    { from: 'processing', to: 'pending_review', event: 'submit_review', allowedRoles: ['admin', 'worker'] },
    { from: 'pending_review', to: 'review_passed', event: 'approve', allowedRoles: ['admin', 'reviewer'] },
    { from: 'pending_review', to: 'processing', event: 'reject', allowedRoles: ['admin', 'reviewer'] },
    { from: 'review_passed', to: 'completed', event: 'complete' },
    { from: 'completed', to: 'closed', event: 'close', requiredFields: ['close_reason'] },
    { from: 'closed', to: 'evaluated', event: 'satisfy', requiredFields: ['satisfaction_score'] },
    // —— 撤销（活跃态 → cancelled）——
    { from: 'draft', to: 'cancelled', event: 'cancel', requiredFields: ['cancel_reason'], allowedRoles: ['admin', 'dispatcher'] },
    { from: 'pending_accept', to: 'cancelled', event: 'cancel', requiredFields: ['cancel_reason'], allowedRoles: ['admin', 'dispatcher'] },
    { from: 'pending_dispatch', to: 'cancelled', event: 'cancel', requiredFields: ['cancel_reason'], allowedRoles: ['admin', 'dispatcher'] },
    { from: 'assigned', to: 'cancelled', event: 'cancel', requiredFields: ['cancel_reason'], allowedRoles: ['admin', 'dispatcher'] },
    { from: 'processing', to: 'cancelled', event: 'cancel', requiredFields: ['cancel_reason'], allowedRoles: ['admin', 'dispatcher'] },
    { from: 'paused', to: 'cancelled', event: 'cancel', requiredFields: ['cancel_reason'], allowedRoles: ['admin', 'dispatcher'] },
    { from: 'suspended', to: 'cancelled', event: 'cancel', requiredFields: ['cancel_reason'], allowedRoles: ['admin', 'dispatcher'] },
    { from: 'pending_review', to: 'cancelled', event: 'cancel', requiredFields: ['cancel_reason'], allowedRoles: ['admin', 'dispatcher'] },
  ],
  config: {
    // 完成态口径（成功结束）：含"已完成"里程碑态 completed（非终态，但工作已做完）+ closed/evaluated。
    // 与 DEFAULT 的 ['completed'] 对齐"工作做完即算完成"语义；cancelled 属废弃态不计入。
    doneStates: ['completed', 'closed', 'evaluated'],
    // Phase 6 占位：让自适应派单/学习可按流配置（复用既有 incrementalLearn / auto-dispatch）
    learningTriggers: ['completed', 'review_passed'],
    autoRoutes: { draft: { to: 'assigned', strategy: 'least_load' } },
  },
};

/** 通用：判断 def 下 from -> to 是否合法跳转（忽略 event/角色/必填，仅拓扑）。 */
export function canTransition(def: WorkflowDef, from: string, to: string): boolean {
  return def.transitions.some((t) => t.from === from && t.to === to);
}

/** 给定当前状态，返回下一步合法目标状态列表。 */
export function nextStates(def: WorkflowDef, from: string): string[] {
  return def.transitions.filter((t) => t.from === from).map((t) => t.to);
}

/** 给定当前状态，返回所有合法出向转移（含规则：事件/必填/角色门禁/副作用），供前端动态渲染动作按钮与权限判断。 */
export function availableTransitions(def: WorkflowDef, from: string): WorkflowTransition[] {
  return def.transitions.filter((t) => t.from === from);
}

/** 判断某状态是否在 def 声明集合中（防越权写入未知状态）。 */
export function isKnownState(def: WorkflowDef, s: string): boolean {
  return def.states.includes(s);
}

/** 给定当前状态与事件，返回目标状态（事件驱动流转）；不存在返回 null。 */
export function applyEvent(def: WorkflowDef, from: string, event: string): string | null {
  const t = def.transitions.find((x) => x.from === from && x.event === event);
  return t ? t.to : null;
}

/** 终态：无任何出向转移的状态（流程走到头，包括废弃态 cancelled 与成功终态 closed/evaluated）。 */
export function terminalStates(def: WorkflowDef): string[] {
  const hasOutgoing = new Set(def.transitions.map((t) => t.from));
  return def.states.filter((s) => !hasOutgoing.has(s));
}

/**
 * 完成态（成功结束）口径：用于"已完成/自动闭环率"统计。
 * 优先读 def.config.doneStates（显式声明，兼容富模板"已完成里程碑态 completed 非终态但算完成"语义）；
 * 兜底 = terminalStates 减去废弃态(cancelled/voided)。
 *  - DEFAULT: ['completed']
 *  - RICH:    ['completed','closed','evaluated']（含 completed 里程碑态）
 * 保证两套状态图下"已完成计数 / 自动闭环率"口径一致、不漏计。
 */
export function doneStates(def: WorkflowDef): string[] {
  const cfg = def.config?.doneStates as string[] | undefined;
  if (Array.isArray(cfg) && cfg.length > 0) return cfg;
  return terminalStates(def).filter((s) => s !== 'cancelled' && s !== 'voided');
}
