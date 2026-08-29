// 业务主题模板（业务流程配置中心"下拉生成"的数据源，T-① 零代码配置载体）。
// 每个模板是一个合法的 WorkflowDef（仅含 initial/states/transitions，config 缺省由引擎兜底），
// 供运营在界面"选主题 → 生成 starter 状态机 → 微调 → 落库 workflow_def"。
// 这是"所有业务流必须过 workflow_def"红线的落地：巡检/运送/应急/循环签到不再硬编码流转内核。
import { RICH_WORK_ORDER_DEF, type WorkflowDef } from './stateMachine.js';

// 巡检内置兜底（当 workflow_def 无 inspection_task 行时使用，确保既有巡检路由不崩）。
// 状态值与 inspection.ts 既有语义保持一致：pending→in_progress→done/exception。
export const INSPECTION_DEF: WorkflowDef = {
  initial: 'pending',
  states: ['pending', 'in_progress', 'done', 'exception', 'cancelled'],
  transitions: [
    { from: 'pending', to: 'in_progress', event: 'checkin', allowedRoles: ['admin', 'operator', 'worker'] },
    { from: 'in_progress', to: 'done', event: 'complete', allowedRoles: ['admin', 'operator', 'worker'] },
    { from: 'in_progress', to: 'exception', event: 'exception', requiredFields: ['note'] },
    { from: 'pending', to: 'cancelled', event: 'cancel', allowedRoles: ['admin', 'operator'] },
    { from: 'in_progress', to: 'cancelled', event: 'cancel', allowedRoles: ['admin', 'operator'] },
  ],
  config: { doneStates: ['done'], learningTriggers: ['done'] },
};

export const TRANSPORT_DEF: WorkflowDef = {
  initial: 'pending',
  states: ['pending', 'assigned', 'transporting', 'done', 'exception', 'cancelled'],
  transitions: [
    { from: 'pending', to: 'assigned', event: 'dispatch', requiredFields: ['assignee'], allowedRoles: ['admin', 'operator', 'dispatcher'] },
    { from: 'assigned', to: 'transporting', event: 'receive', allowedRoles: ['admin', 'worker'] },
    { from: 'transporting', to: 'done', event: 'complete', allowedRoles: ['admin', 'worker'] },
    { from: 'transporting', to: 'exception', event: 'exception', requiredFields: ['note'] },
    { from: 'pending', to: 'cancelled', event: 'cancel', allowedRoles: ['admin', 'operator'] },
    { from: 'assigned', to: 'cancelled', event: 'cancel', allowedRoles: ['admin', 'operator'] },
    { from: 'transporting', to: 'cancelled', event: 'cancel', allowedRoles: ['admin', 'operator'] },
  ],
  config: { doneStates: ['done'], learningTriggers: ['done'] },
};

export const EMERGENCY_DEF: WorkflowDef = {
  initial: 'draft',
  states: ['draft', 'dispatched', 'processing', 'resolved', 'closed', 'cancelled'],
  transitions: [
    { from: 'draft', to: 'dispatched', event: 'activate', allowedRoles: ['admin', 'operator'] },
    { from: 'dispatched', to: 'processing', event: 'process', allowedRoles: ['admin', 'worker'] },
    { from: 'processing', to: 'resolved', event: 'resolve', allowedRoles: ['admin', 'worker'] },
    { from: 'resolved', to: 'closed', event: 'close', allowedRoles: ['admin', 'operator'] },
    { from: 'draft', to: 'cancelled', event: 'cancel', allowedRoles: ['admin', 'operator'] },
    { from: 'dispatched', to: 'cancelled', event: 'cancel', allowedRoles: ['admin', 'operator'] },
    { from: 'processing', to: 'cancelled', event: 'cancel', allowedRoles: ['admin', 'operator'] },
  ],
  config: { doneStates: ['resolved', 'closed'], learningTriggers: ['resolved'] },
};

export const CYCLE_CHECK_DEF: WorkflowDef = {
  initial: 'scheduled',
  states: ['scheduled', 'checked', 'missed', 'closed'],
  transitions: [
    { from: 'scheduled', to: 'checked', event: 'check', allowedRoles: ['admin', 'worker'] },
    { from: 'scheduled', to: 'missed', event: 'miss', allowedRoles: ['admin', 'worker'] },
    { from: 'checked', to: 'closed', event: 'close', allowedRoles: ['admin', 'operator'] },
  ],
  config: { doneStates: ['checked'], learningTriggers: ['checked'] },
};

export interface ThemeTemplate {
  entityType: string;
  name: string;
  def: WorkflowDef;
}

// 业务主题清单（下拉生成用）。work_order 复用 RICH 模板；其余为各业务流 starter。
export const THEME_TEMPLATES: ThemeTemplate[] = [
  { entityType: 'work_order', name: '工单', def: RICH_WORK_ORDER_DEF },
  { entityType: 'inspection_task', name: '巡检', def: INSPECTION_DEF },
  { entityType: 'transport_task', name: '运送', def: TRANSPORT_DEF },
  { entityType: 'emergency_plan', name: '应急预案', def: EMERGENCY_DEF },
  { entityType: 'cycle_check', name: '循环签到', def: CYCLE_CHECK_DEF },
];

const LABEL_MAP: Record<string, string> = {
  work_order: '工单',
  inspection_task: '巡检',
  transport_task: '运送',
  emergency_plan: '应急预案',
  cycle_check: '循环签到',
};

/** 给列表展示用：entity_type → 友好名（优先 def.config.name，其次内置映射）。 */
export function themeLabel(entityType: string, defName?: string): string {
  if (defName) return defName;
  return LABEL_MAP[entityType] ?? entityType;
}
