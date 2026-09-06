// wfdef_arrived_patch_core.d.mts —— wfdef_arrived_patch_core.mjs 的类型声明（P1 修 TS7016）。
// 形状逐字段对齐 tools/wfdef_arrived_patch_core.mjs 实现与 stateMachine.ts RICH 定义：
// 转移边三元组 (from,event,to) + 可选 allowedRoles/requiredFields；def 异构防御按 unknown 收口。

export interface WfTransition {
  from: string;
  to: string;
  event: string;
  allowedRoles?: string[];
  requiredFields?: string[];
  /** 存量租户 def 允许携带扩展字段（不丢不改） */
  [key: string]: unknown;
}

export interface WfDef {
  initial?: string;
  states: string[];
  transitions: WfTransition[];
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 与 RICH_WORK_ORDER_DEF 对齐的三条 arrived 边（顺序即插入顺序）。 */
export const ARRIVED_TRANSITIONS: ReadonlyArray<{
  from: string;
  to: string;
  event: string;
  allowedRoles: string[];
  requiredFields?: string[];
}>;

/** 判断 def 是否需要到场态补丁（异构防御：非对象/缺数组/已含 arrived 一律 false）。 */
export function needsArrivedPatch(def: unknown): boolean;

export interface ArrivedPatchResult {
  def: WfDef;
  changed: boolean;
  addedStates: number;
  addedEdges: number;
  statesBefore: string[] | null;
  statesAfter: string[] | null;
}

/** 对单个 def 做 JSON 增量补丁（纯函数、不可变入参、幂等）。 */
export function applyArrivedPatch(def: unknown): ArrivedPatchResult;

/** workflow_def 行结构（def 兼容对象与 JSON 字符串两种形态）。 */
export interface WfDefRow {
  tenant_id: string;
  entity_type: string;
  version: number;
  def: unknown;
  [key: string]: unknown;
}

export interface PatchedRow {
  tenant_id: string;
  entity_type: string;
  version_before: number;
  def_before: unknown;
  def_after: WfDef;
  addedStates: number;
  addedEdges: number;
  statesBefore: string[] | null;
  statesAfter: string[] | null;
}

/** 对一批 workflow_def 行打补丁（纯函数）；def 解析失败的脏数据跳过不猜。 */
export function patchWorkflowDefRows(rows: WfDefRow[]): {
  patched: PatchedRow[];
  unchanged: number;
};
