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
}

export interface WorkflowDef {
  initial: string;
  states: string[];
  transitions: WorkflowTransition[];
  config?: Record<string, unknown>;
}

// work_order 默认状态图（取老系统 UOne 工单全生命周期粒度之所长，扩展为超集）。
// 保留原 4 态(draft/assigned/processing/completed)作为子集以保证历史工单合法流转。
// 差异化：老系统写死流程，此处流程存 workflow_def，可配置、可租户定制（设计支柱②）。
export const DEFAULT_WORK_ORDER_DEF: WorkflowDef = {
  initial: 'draft',
  states: [
    'draft',            // 草稿/新建
    'pending_accept',   // 待受理
    'pending_dispatch', // 待派单
    'assigned',         // 已派单/待接收（兼容原 auto_dispatch 写入）
    'pending_confirm',  // 待确认
    'processing',       // 处理中
    'paused',           // 暂停中/已挂起
    'pending_review',   // 待审核
    'completed',        // 已完成
    'closed',           // 已关闭
    'cancelled',        // 已撤销/已作废
    'rejected',         // 已拒绝（审核驳回）
    'evaluated',        // 已评价
  ],
  transitions: [
    // 原 4 态兼容路径
    { from: 'draft', to: 'assigned', event: 'assign' },
    { from: 'assigned', to: 'processing', event: 'start' },
    { from: 'processing', to: 'completed', event: 'complete' },
    // UOne 粒度扩展（受理→派单→接单→确认→处理→审核→结束→评价）
    { from: 'draft', to: 'pending_accept', event: 'submit' },
    { from: 'pending_accept', to: 'pending_dispatch', event: 'accept' },
    { from: 'pending_dispatch', to: 'assigned', event: 'dispatch' },
    { from: 'assigned', to: 'pending_dispatch', event: 'return' },
    { from: 'assigned', to: 'pending_confirm', event: 'confirm_pending' },
    { from: 'pending_confirm', to: 'processing', event: 'confirm' },
    { from: 'pending_confirm', to: 'pending_dispatch', event: 'return' },
    { from: 'processing', to: 'paused', event: 'pause' },
    { from: 'paused', to: 'processing', event: 'resume' },
    { from: 'processing', to: 'pending_review', event: 'submit_review' },
    { from: 'pending_review', to: 'completed', event: 'approve' },
    { from: 'pending_review', to: 'processing', event: 'reject' },
    { from: 'completed', to: 'closed', event: 'close' },
    { from: 'completed', to: 'evaluated', event: 'satisfy' },
    { from: 'evaluated', to: 'closed', event: 'close' },
    // 撤销（各活跃态 → cancelled）
    { from: 'draft', to: 'cancelled', event: 'cancel' },
    { from: 'pending_accept', to: 'cancelled', event: 'cancel' },
    { from: 'pending_dispatch', to: 'cancelled', event: 'cancel' },
    { from: 'assigned', to: 'cancelled', event: 'cancel' },
    { from: 'pending_confirm', to: 'cancelled', event: 'cancel' },
    { from: 'processing', to: 'cancelled', event: 'cancel' },
    { from: 'paused', to: 'cancelled', event: 'cancel' },
    { from: 'pending_review', to: 'cancelled', event: 'cancel' },
    // 审核驳回后重新处理
    { from: 'rejected', to: 'processing', event: 'resubmit' },
  ],
  config: {},
};

/** 通用：判断 def 下 from -> to 是否合法跳转。 */
export function canTransition(def: WorkflowDef, from: string, to: string): boolean {
  return def.transitions.some((t) => t.from === from && t.to === to);
}

/** 给定当前状态，返回下一步合法目标状态列表。 */
export function nextStates(def: WorkflowDef, from: string): string[] {
  return def.transitions.filter((t) => t.from === from).map((t) => t.to);
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
