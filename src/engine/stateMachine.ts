// 可配置状态机引擎（T-① · 设计支柱②：单引擎 + 状态图存 DB 零代码配）。
// 取代原固定 4 态字典；合法跳转由 WorkflowDef 声明，支持运行期动态增状态/转移
// （如 C1 优化建议注入的 recheck / escalated），契合"流程零代码配置"。
//
// 红线保留：引擎只做"是否合法"判定，绝不自动把状态推进到终态
// （completed / escalated 必须由显式事件驱动；P6 验收只报自动派单率，不自动闭环）。

// 放宽：状态集合由 workflow_def 声明，不再写死枚举。
// 注意：非法状态不会被静默接受——transition() 内部用 isKnownState() 校验 from/to，
// 非法态直接抛 422（CONFLICT），前端不可任意传状态，维护者无需担心类型放宽引入脏数据。
export type WorkOrderStatus = string;

/**
 * 抢单大厅机制态名与入厅事件名——**单一事实源放在引擎核心**。
 * F8（2026-10-19）：此前常量只在 claimHallEdges.ts 定义，而 stateMachine.ts（RICH 模板 +
 *   resolveDispatchTarget）需要用它区分「机制边 vs 客户业务边」，反向 import 会成环。
 *   故上提到此处，claimHallEdges.ts 改为同源 re-export（对外 import 路径零变化）。
 */
export const CLAIM_HALL_STATE = 'claim_hall';
export const ENTER_HALL_EVENT = 'enter_hall';
/** 取消事件名（内置模板一致约定：入边 event='cancel' 的目标态即取消态）。 */
export const CANCEL_EVENT = 'cancel';
/** 认领（抢单）事件名：认领边是"谁可以抢"的事实源，认领池口径由此派生。 */
export const CLAIM_EVENT = 'claim';

export interface WorkflowTransition {
  from: string;
  to: string;
  event: string;
  // A+ 扩展：把 UOne 流转"规则粒度"建模进可配置（老系统写死，此处可配）
  requiredFields?: string[]; // 该流转必填字段（缺失 → 422）
  allowedRoles?: string[];   // 允许执行的角色；为空/未定义 = 租户内任意已认证用户可走（向后兼容，避免门死自己）
  // 【地基第二步】允许执行的**权限点**（任一命中即放行）；与 allowedRoles 取**并集**。
  // 存在意义：把"审核"这类能力从"一个岗位"还原成"可叠加给任何角色的属性"——
  // 用户原意：审核员不是单独一个人，是一个权限属性，可挂给谁，或配自动审核规则。
  // 例：approve/reject 声明 allowedPerms:['workflow.approve'] 后，租户把该权限点授予
  // 自建岗位"维修组长"，该岗位即可审核——无需新增内置角色、无需改代码。
  allowedPerms?: string[];
  sideEffects?: string[];    // 副作用标记：pause_sla / resume_sla / notify_*（真实落库或记录）
}

/** 门禁判定的执行者上下文（纯数据，便于单测）。 */
export interface TransitionActor {
  /** 执行者角色 code（内置 6 角色或租户自建 role_def code）。 */
  role?: string;
  /** 执行者实际生效的权限点集合（来自 listPerms：租户覆盖行优先，否则默认矩阵）。 */
  perms?: readonly string[];
}

/**
 * 转移门禁判定（纯函数，单一事实源）：allowedRoles ∪ allowedPerms **并集**。
 *  - 两者均未声明/为空 → 放行（向后兼容，避免门死自己）；
 *  - 任一命中 → 放行（并集，非交集：新增权限门禁不得反过来收窄既有角色门禁）；
 *  - 都不命中 → 拒。
 * role 缺失视同"不在白名单"（R9-003：不得因缺字段短路放行）。
 */
export function isTransitionAllowed(t: WorkflowTransition, actor: TransitionActor = {}): boolean {
  const roles = t.allowedRoles;
  const perms = t.allowedPerms;
  const hasRoleGate = Array.isArray(roles) && roles.length > 0;
  const hasPermGate = Array.isArray(perms) && perms.length > 0;
  if (!hasRoleGate && !hasPermGate) return true;
  if (hasRoleGate && roles!.includes(actor.role ?? '')) return true;
  if (hasPermGate && (actor.perms ?? []).some((p) => perms!.includes(p))) return true;
  return false;
}

export interface AutoRoute {
  to: string;
  strategy?: string; // 派单策略提示：'least_load' 强制走负载兜底选人；未声明则保持 规则优先→least_load 兜底
}

export interface WorkflowDefConfig {
  doneStates?: string[];                     // 完成态口径（成功结束），用于统计/训练样本
  learningTriggers?: string[];               // 触发增量学习的状态集合（数据→模型共振控制点）；缺省回退 doneStates
  autoRoutes?: Record<string, AutoRoute>;    // 各初态自动派发目标（配置=模型 surface 反写入口）
  [key: string]: unknown;                    // 允许优化层写入 sla_tighten/target_sla_rate/auto_escalate 等
}

export interface WorkflowDef {
  initial: string;
  states: string[];
  transitions: WorkflowTransition[];
  config?: WorkflowDefConfig;
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
    'claim_hall',      // 抢单大厅(未命中自动派单时归属，待人员抢单)
    'assigned',        // 已派单/待接收
    'arrived',         // 已到场（074 里程碑：工人到场打卡，start 处理前的中间态）
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
    // 【用户原始诉求②"师傅不能接单谁接单？师傅的职能就是接单执行"】
    // 原边 allowedRoles = ['admin','dispatcher','service_desk'] —— **不含 worker**，
    // 即真正干活的师傅接不了单，接单权反而落在 dispatcher/service_desk 两个待退场角色上。
    // 此为"师傅不能接单"的代码根因。修复：**加 worker**（纯加法，存量三者权限一字不动）。
    { from: 'pending_accept', to: 'pending_dispatch', event: 'accept', allowedRoles: ['admin', 'worker'] },
    { from: 'pending_dispatch', to: 'assigned', event: 'dispatch', allowedRoles: ['admin'], allowedPerms: ['dispatch.override'], requiredFields: ['assignee'] },
    // 抢单机制边（与 claimHallEdges.ts PENDING_DISPATCH_CLAIM_EDGE 同源，两处必须一起改）：
    // worker 认领待派单池的单——抢单端点历来允许，补成流程图上诚实的可见边。
    { from: 'pending_dispatch', to: 'assigned', event: 'claim', allowedRoles: ['worker', 'admin'] },
    { from: 'assigned', to: 'arrived', event: 'arrive', allowedRoles: ['admin', 'worker'] },
    // 074 里程碑：到场后 start 开始处理；保留 assigned→processing 'receive' 旧边（无到场打卡的
    // 旧客户端/旧单兼容路径，绝不门死存量流转）。arrived 也属活跃态 → 补 cancel 逃逸边。
    { from: 'arrived', to: 'processing', event: 'start', allowedRoles: ['admin', 'worker'] },
    { from: 'assigned', to: 'processing', event: 'receive', allowedRoles: ['admin', 'worker'] },
    { from: 'assigned', to: 'pending_dispatch', event: 'return', requiredFields: ['return_reason'] },
    { from: 'assigned', to: 'assigned', event: 'forward', requiredFields: ['assignee'], allowedRoles: ['admin'], allowedPerms: ['dispatch.override'] },
    { from: 'processing', to: 'paused', event: 'pause', sideEffects: ['pause_sla'] },
    { from: 'paused', to: 'processing', event: 'resume', sideEffects: ['resume_sla'] },
    { from: 'processing', to: 'suspended', event: 'suspend', requiredFields: ['suspend_reason'], sideEffects: ['pause_sla'] },
    { from: 'suspended', to: 'processing', event: 'resume', sideEffects: ['resume_sla'] },
    { from: 'processing', to: 'pending_review', event: 'submit_review', allowedRoles: ['admin', 'worker'] },
    // 审核 = 可叠加权限属性（地基第二步）：allowedRoles 原样保留（存量零回归），
    // 追加 allowedPerms:['workflow.approve'] —— 租户把该权限点授给任何角色（含自建岗位）
    // 即获得审核权，不必再新增"审核员"这个岗位。
    { from: 'pending_review', to: 'review_passed', event: 'approve', allowedRoles: ['admin', 'reviewer'], allowedPerms: ['workflow.approve'] },
    { from: 'pending_review', to: 'processing', event: 'reject', allowedRoles: ['admin', 'reviewer'], allowedPerms: ['workflow.approve'] },
    { from: 'review_passed', to: 'completed', event: 'complete' },
    { from: 'completed', to: 'closed', event: 'close', requiredFields: ['close_reason'] },
    { from: 'closed', to: 'evaluated', event: 'satisfy', requiredFields: ['satisfaction_score'] },
    // —— 抢单大厅（滴滴式未命中自动派单时归属，人员可抢单）——
    // F8（2026-10-19）：补「入厅边」draft --enter_hall--> claim_hall。此前 RICH def 只有
    //   三条**出厅**边，入厅这条只存在于 claimHallEdges 的运行时注入里（两处不同源）——
    //   落大厅因此只能旁路手写 UPDATE。两处必须逐字同源（同 pending_dispatch claim 边的教训）。
    { from: 'draft', to: 'claim_hall', event: 'enter_hall' },
    { from: 'claim_hall', to: 'assigned', event: 'claim', allowedRoles: ['worker', 'admin'] },
    { from: 'claim_hall', to: 'assigned', event: 'dispatch', requiredFields: ['assignee'], allowedRoles: ['admin'], allowedPerms: ['dispatch.override'] },
    // —— 撤销（活跃态 → cancelled）——
    { from: 'draft', to: 'cancelled', event: 'cancel', requiredFields: ['cancel_reason'], allowedRoles: ['admin'], allowedPerms: ['ticket.manage'] },
    { from: 'claim_hall', to: 'cancelled', event: 'cancel', requiredFields: ['cancel_reason'], allowedRoles: ['admin'], allowedPerms: ['ticket.manage'] },
    { from: 'pending_accept', to: 'cancelled', event: 'cancel', requiredFields: ['cancel_reason'], allowedRoles: ['admin'], allowedPerms: ['ticket.manage'] },
    { from: 'pending_dispatch', to: 'cancelled', event: 'cancel', requiredFields: ['cancel_reason'], allowedRoles: ['admin'], allowedPerms: ['ticket.manage'] },
    { from: 'assigned', to: 'cancelled', event: 'cancel', requiredFields: ['cancel_reason'], allowedRoles: ['admin'], allowedPerms: ['ticket.manage'] },
    { from: 'arrived', to: 'cancelled', event: 'cancel', requiredFields: ['cancel_reason'], allowedRoles: ['admin'], allowedPerms: ['ticket.manage'] },
    { from: 'processing', to: 'cancelled', event: 'cancel', requiredFields: ['cancel_reason'], allowedRoles: ['admin'], allowedPerms: ['ticket.manage'] },
    { from: 'paused', to: 'cancelled', event: 'cancel', requiredFields: ['cancel_reason'], allowedRoles: ['admin'], allowedPerms: ['ticket.manage'] },
    { from: 'suspended', to: 'cancelled', event: 'cancel', requiredFields: ['cancel_reason'], allowedRoles: ['admin'], allowedPerms: ['ticket.manage'] },
    { from: 'pending_review', to: 'cancelled', event: 'cancel', requiredFields: ['cancel_reason'], allowedRoles: ['admin'], allowedPerms: ['ticket.manage'] },
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

/** 内置挂起态（兜底；客户自定义挂起态名时由 def.config.holdStates 或 sideEffects 派生覆盖）。 */
export const BUILTIN_HOLD_STATES = ['paused', 'suspended'] as const;
export const BUILTIN_CANCEL_STATES = ['cancelled'] as const;

/**
 * 挂起态（人已离场、工单暂不算在身）口径：worker.load 净结算与 SLA 扫描**共用同一派生源**。
 *
 * 【为什么要有这个函数】
 *   此前 ticket.ts（load 结算）与 slaScheduler.ts（SLA 扫描）各自硬编码 `'paused'/'suspended'`
 *   两处字面量——而 doneStates / terminalStates 早已是流程派生的。于是客户若在流程里
 *   自定义挂起态名（如 on_hold / waiting_part），两边都不认：
 *     · load：人已离场却不回收 → 派单均衡长期虚高，该派的人派不出去；
 *     · SLA：挂起的单继续计时 → 超时率被污染。
 *   这违反「不改代码发版、界面全搞定」的产品第一原则：客户配了个状态，引擎不认识。
 *
 * 【派生口径（三级，显式优先）】
 *   ① def.config.holdStates —— 客户/配置台显式声明（只保留在 def.states 内的合法态）；
 *   ② 兜底 = sideEffects 含 pause_sla 的**目标态**（挂起的语义锚点就是"暂停 SLA"）
 *      ∪ 内置 paused/suspended（存量租户零行为变化）。
 *   与 learningTriggerStates 同构：显式优先、兜底保持向后兼容。
 */
export function holdStates(def: WorkflowDef): string[] {
  const cfg = def.config?.holdStates;
  if (Array.isArray(cfg) && cfg.length > 0) {
    return cfg.filter((s) => typeof s === 'string' && def.states.includes(s));
  }
  const derived = new Set<string>(BUILTIN_HOLD_STATES);
  for (const t of def.transitions ?? []) {
    if ((t.sideEffects ?? []).includes('pause_sla')) derived.add(t.to);
  }
  return def.states.filter((s) => derived.has(s));
}

/**
 * 取消态（作废）口径：存在 **入边 event === 'cancel'** 的目标态。
 * 与 holdStates 同哲学——机制语义从流转边派生，而不是把状态名写死在 SQL 里。
 * 该约定在全部内置模板（stateMachine RICH / themes 各主题）中一致成立：
 * 一律 `{ ..., to: 'cancelled', event: 'cancel' }`。
 * 兜底：def 里找不到 cancel 边时退回内置名（存量与极端自定义 def 行为零变化）。
 */
export function cancelledStates(def: WorkflowDef): string[] {
  const derived = new Set<string>();
  for (const t of def.transitions ?? []) {
    if (t.event === CANCEL_EVENT) derived.add(t.to);
  }
  const hit = def.states.filter((s) => derived.has(s));
  return hit.length > 0 ? hit : def.states.filter((s) => (BUILTIN_CANCEL_STATES as readonly string[]).includes(s));
}

/** 评价事件名（内置模板约定：入边 event='satisfy' 的目标态即评价完成态）。 */
export const SATISFY_EVENT = 'satisfy';

/**
 * 评价完成态：存在 **event='satisfy' 入边** 的目标态集合（内置模板 = evaluated）。
 * 用途：workOrder.ts 在评价完成时回写满意度 + 自动生成结算草稿。若把 'evaluated' 写死，
 *   客户把评价态改名后这两件事会静默不发生（满意度不入库、草稿不生成，且无任何报错）。
 */
export function evaluatedStates(def: WorkflowDef): string[] {
  const tos = new Set<string>();
  for (const t of def.transitions ?? []) {
    if (t.event === SATISFY_EVENT) tos.add(t.to);
  }
  return def.states.filter((s) => tos.has(s));
}

/**
 * 认领池态（抢单大厅 / 待派单池口径）：存在 **claim 出边** 的 from 态集合。
 *
 * 【为什么要有这个函数】此前「哪些态可以被抢」在两处各写一份
 *   `['claim_hall','pending_dispatch']`——services/claimWorkOrder.ts 的入参守卫与
 *   routes/workOrder.ts GET /open/claim-hall 的列表 SQL。两份字面量的后果与 F9 同源：
 *   ① 客户在流程里另配 claim 边（如 "二次转单池 secondary_pool"）→ 列表查得到、
 *      认领端点 409 拒不了/反过来认领放行但列表看不见；
 *   ② 客户把池态改名 → 两边同时失明，单进得去出不来（与 R32 load 断链同款静默事故）。
 *   派生口径：**能 claim 的状态就是池**——认领边说话，名单不听代码。
 *   内置模板（RICH + claimHallEdges 机制注入）下结果逐字 = claim_hall / pending_dispatch。
 */
export function claimableStates(def: WorkflowDef): string[] {
  const froms = new Set<string>();
  for (const t of def.transitions ?? []) {
    if (t.event === CLAIM_EVENT) froms.add(t.from);
  }
  return def.states.filter((s) => froms.has(s));
}

/**
 * 活跃态（worker 在身 / SLA 在跑）：全态 − 完成 − 终态 − 挂起。
 * load 净结算与 SLA 扫描必须共用此派生，杜绝两处口径漂移（见 holdStates 注释）。
 */
export function activeStates(def: WorkflowDef): string[] {
  const done = doneStates(def);
  const term = terminalStates(def);
  const hold = holdStates(def);
  return def.states.filter((s) => !done.includes(s) && !term.includes(s) && !hold.includes(s));
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

/**
 * 学习触发态（数据→模型共振控制点）：优先读 def.config.learningTriggers（仅保留声明在 states 内的合法状态），
 * 缺省回退 doneStates（向后兼容：未配置则与旧行为一致）。
 *  - 用途：workOrder.ts 在工单首次踏入这些态时触发 incrementalLearn。
 */
export function learningTriggerStates(def: WorkflowDef): string[] {
  const raw = def.config?.learningTriggers;
  if (Array.isArray(raw) && raw.length > 0) {
    const valid = raw.filter((s) => def.states.includes(s));
    if (valid.length > 0) return valid;
  }
  return doneStates(def);
}

/**
 * 是否触发增量学习（数→模闭环的触发点判定，纯函数可单测）。
 * 规则：目标态 to 在触发集 learnOn 内，且"更新前状态 from"不在触发集内（即首次踏入触发态，
 * 避免 completed→closed→evaluated 之间重复学习）。from 必须来自 transition() 锁内返回，
 * 以杜绝并发双触发——本函数只负责判定逻辑，并发串行化由 transition() 的行锁保证。
 */
export function shouldTriggerLearning(to: string, from: string, learnOn: string[]): boolean {
  return learnOn.includes(to) && !learnOn.includes(from);
}

/** 自动派发路由（配置=模型 surface）：返回某初态声明的自动派发目标态与策略；目标态非法（不在 states）则返回 null。 */
export function autoRouteFor(def: WorkflowDef, from: string): AutoRoute | null {
  const ar = def.config?.autoRoutes?.[from];
  if (ar && typeof ar.to === 'string' && def.states.includes(ar.to)) {
    return { to: ar.to, strategy: ar.strategy };
  }
  return null;
}

/**
 * 解析自动派单目标态（派单旁路单一事实源，fail-closed）——2026-10-19 对齐审查修复。
 *
 * 【为什么必须有这个函数】此前两处派单旁路（routes/workOrder.ts autoDispatchAfterCreate、
 * services/linkedWorkOrder.ts）都写 `autoRouteFor(def, initial)?.to ?? 'assigned'`：
 *   租户未配置 autoRoutes 时硬编码回退 'assigned'——若该租户 def 根本没有 assigned 态
 *   （自定义流程完全可以用别的状态名），派单直接把单子写进客户流程里不存在的状态，
 *   之后 transition() 的 isKnownState 拒绝一切流转 = 造失管单。
 *   现网无实例（t-verification/t-phasea 均配 autoRoutes draft→assigned，走①不受影响），
 *   但这是地基级潜在缺陷：**客户配什么流程，派单就必须落在什么流程里**。
 *
 * 解析顺序（每步的场景对照见 src/test/dispatchTargetFailClosed.test.ts）：
 *   ① def.config.autoRoutes[from] 合法声明 → 用之（autoRouteFor 已校验 to ∈ states）；
 *   ② 未配置 → 取 from 的第一条「非终态且非完成态」转移的目标（客户流程的天然第一步；
 *      对 RICH/DEFAULT 即 assigned，与旧硬编码在这些标准 def 上结果逐字一致）；
 *   ③ 初态没有任何可用转移 → null：调用方必须 422 拒绝派单并提示去配 autoRoutes，
 *      严禁再硬编码任何状态名。
 *
 * F4（2026-10-19 深修）：①的目标态还必须是**拓扑可达**的——autoRoutes.to 虽在 states 里，
 *   但若不存在 from→to 的转移边，该 route 视为坏配置（客户把派单目标配成了流程里
 *   跳不到的地方），跳过它落②。生产实证：t-phasea 配 draft→assigned 但其 def 只有
 *   submit→pending_accept / cancel→cancelled 两条出边——旧旁路不查边直接写 assigned
 *   = 跳过受理环节直达派单孤岛；走主通道（transition() 查边）后按拓扑诚实落到
 *   pending_accept。这不是迁就坏配置，是消灭"配置指向拓扑外跳转"的静默容忍。
 */
export function resolveDispatchTarget(def: WorkflowDef, from: string): string | null {
  // F8（2026-10-19）：派单目标只能从**客户业务边**解析，必须排除引擎机制边
  //   （enter_hall 入厅边 / 目标为 claim_hall）。否则「客户流程根本没有可用派单路径」
  //   这一 fail-closed 语义会被机制兜底边顶替成"落抢单大厅"，422 变静默放行——
  //   客户配错了流程却看不出来（正是 dispatchTargetFailClosed 用例⑥守护的事实）。
  //   机制边是引擎的兜底行为空间，不是客户声明的派单路径，两者不可混用。
  const isMechanism = (t: WorkflowTransition) => t.event === ENTER_HALL_EVENT || t.to === CLAIM_HALL_STATE;
  const ar = autoRouteFor(def, from);
  if (ar && (def.transitions ?? []).some((t) => t.from === from && t.to === ar.to && !isMechanism(t))) {
    return ar.to;
  }
  const forbidden = new Set<string>([...doneStates(def), ...terminalStates(def)]);
  const edge = (def.transitions ?? []).find(
    (t) => t.from === from && !forbidden.has(t.to) && !isMechanism(t),
  );
  return edge ? edge.to : null;
}

// ── 074 生命周期里程碑时间列（2026-09-06 任务④）──
// 状态 → work_orders 里程碑列（074_work_order_milestone_timestamps.sql）的单一事实源，
// 写路径共用：transition()（人工/接口流转，2026-10-19 起自动派单 F4、抢单 F6 也已并入主通道）、
// linkedWorkOrder 自动派单旁路——保证派工/到场/完成时间口径一致。
// 注：processing 为「最近一次进入」语义（resume/reject 再入会刷新 started_at），
//     首末之分由 ticket_event/domain_event 事件流水兜底，不在此处做首次判定。
export const STATUS_TIMESTAMP_COLUMNS: Readonly<Record<string, string>> = {
  pending_accept: 'accepted_at', // 受理
  assigned: 'assigned_at',       // 派单（含抢单）
  arrived: 'arrived_at',         // 到场
  processing: 'started_at',      // 开始处理
  completed: 'completed_at',     // 完成
  evaluated: 'rated_at',         // 评价
};

/** 给定目标状态返回应回填的里程碑时间列名；不在映射内返回 undefined（纯函数可单测）。 */
export function timestampColumnFor(status: string): string | undefined {
  return STATUS_TIMESTAMP_COLUMNS[status];
}

/** 返回所有声明了合法 autoRoute 的初态（供管理端可视化/测试）。 */
export function autoRouteStates(def: WorkflowDef): string[] {
  const ar = def.config?.autoRoutes;
  if (!ar || typeof ar !== 'object') return [];
  return Object.keys(ar).filter((from) => autoRouteFor(def, from) !== null);
}
