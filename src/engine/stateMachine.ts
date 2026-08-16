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

// work_order 默认状态图（向后兼容：等同原 draft -> assigned -> processing -> completed）
export const DEFAULT_WORK_ORDER_DEF: WorkflowDef = {
  initial: 'draft',
  states: ['draft', 'assigned', 'processing', 'completed'],
  transitions: [
    { from: 'draft', to: 'assigned', event: 'assign' },
    { from: 'assigned', to: 'processing', event: 'start' },
    { from: 'processing', to: 'completed', event: 'complete' },
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
