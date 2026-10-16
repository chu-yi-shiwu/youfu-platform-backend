/**
 * 自动审核规则（地基④）——引擎层纯函数。
 *
 * 【用户原意】src/engine/stateMachine.ts:22 原文引述：
 *   「审核员不是单独一个人，是一个权限属性，它可以加给谁一个审核权限，或者配置自动审核规则。」
 * 本文件是后半句"配置自动审核规则"的判定核心：给一批规则 + 一张工单快照，
 * 回答"这条单该不该被自动审核"，以及"一条规则本身能不能存"。
 *
 * 【🔴 红线：引擎绝不自动推进到终态】（stateMachine.ts:5-6）
 *   自动审核只能把单推到**中间态**（如 pending_review → review_passed / processing）。
 *   绝不允许自动 close / cancel / satisfy / acceptance_pass——那是人才能做的终局决定。
 *   本文件用两道闸守住：
 *     A. AUTO_RULE_EVENTS 白名单：只允许 approve / reject 两个审核动作；
 *     B. assertAutoRuleSavable：按本租户 def 解析该边真实 to_state，
 *        命中 TERMINAL_STATES → 抛错拒绝保存（写库前就挡住，不等运行期出事）。
 *   DB 侧 094 迁移还有同款 CHECK，三层保险互不替代。
 *
 * 【为什么全是纯函数】
 *   判定逻辑不碰 DB，才能被单测穷举；DB 读写放在 repo 层，路由层组合。
 */
import type { WorkflowDef } from './stateMachine.js';

/** 允许自动化的事件（审核类动作；终态动作一律不在内）。 */
export const AUTO_RULE_EVENTS = ['approve', 'reject'] as const;
export type AutoRuleEvent = (typeof AUTO_RULE_EVENTS)[number];

/**
 * 终态名单：自动审核**绝不**把单推进这些状态。
 * 说明：completed 不在内（它是"工作做完"的里程碑态，后面还有 close/satisfy，
 * 且 review_passed→completed 属正常推进）；closed/cancelled/evaluated 才是真正的终点。
 */
export const TERMINAL_STATES = ['closed', 'cancelled', 'evaluated'] as const;

/** 一条自动审核规则（与 094 workflow_auto_rule 表逐字段对应）。 */
export interface AutoRule {
  id?: string;
  tenantId: string;
  entityType: string;
  fromState: string;
  event: string;
  /** 匹配条件；缺省 {} = 无条件命中（慎用：等于该态所有单都自动审）。 */
  conditions: AutoRuleConditions;
  /** 默认 false：建规则 ≠ 启用。 */
  enabled: boolean;
  note?: string | null;
}

/**
 * 匹配条件（jsonb）。所有字段可选，未给 = 该维度不限。
 *
 * ⚠️ 取数边界（实测 work_orders 列，见 repo/ticket.ts WorkOrderRow）：
 *   本表**没有金额列**（无 amount / estimated_amount），故不设"金额上限"这类条件——
 *   宁可少一个维度，也不实现一个取不到数、永远 fail-closed 的假条件。
 *   可用维度严格对应真实列：priority（优先级）、catalog（工单类型）、ext.has_exception（异常标记）。
 */
export interface AutoRuleConditions {
  /** 优先级白名单（空数组/未给 = 不限优先级）。 */
  priorityIn?: string[] | null;
  /** 工单类型白名单（空数组/未给 = 不限类型）。 */
  categories?: string[] | null;
  /** true = 要求该单无异常标记才命中。 */
  noException?: boolean | null;
}

/** 工单快照（判定输入；字段缺失一律按"不满足"处理，fail-closed）。 */
export interface AutoRuleContext {
  priority?: string | null;
  category?: string | null;
  hasException?: boolean | null;
}

/**
 * 条件匹配（纯函数，fail-closed）：
 *  - 条件未声明的维度 → 不参与判定（等于该维度放行）；
 *  - 条件声明了但工单该字段缺失 → **不命中**（宁可走人工审核，也不误自动）；
 *  - 空条件 {} → 命中（等于"该态全部自动审"，配置台应给出明确提示）。
 */
export function matchAutoRule(rule: AutoRule, ctx: AutoRuleContext): boolean {
  const c = rule.conditions ?? {};

  if (Array.isArray(c.priorityIn) && c.priorityIn.length > 0) {
    if (!ctx.priority) return false;
    if (!c.priorityIn.includes(ctx.priority)) return false;
  }

  if (Array.isArray(c.categories) && c.categories.length > 0) {
    if (!ctx.category) return false;
    if (!c.categories.includes(ctx.category)) return false;
  }

  if (c.noException === true) {
    // hasException 未知（null/undefined）→ 视同有异常 → 不自动（fail-closed）
    if (ctx.hasException !== false) return false;
  }

  return true;
}

/**
 * 从规则列表里挑出**应生效**的那条：必须 enabled + 条件命中。
 * 启用多条时取第一条（表上有唯一约束 tenant+entity+from+event，本就不该有多条同键规则）。
 */
export function pickAutoRule(
  rules: readonly AutoRule[],
  fromState: string,
  ctx: AutoRuleContext,
): AutoRule | null {
  for (const r of rules) {
    if (!r.enabled) continue;
    if (r.fromState !== fromState) continue;
    if (!matchAutoRule(r, ctx)) continue;
    return r;
  }
  return null;
}

/** 在 def 里解析该规则对应的边（from+event 精确匹配）。 */
export function resolveAutoRuleEdge(def: WorkflowDef, rule: Pick<AutoRule, 'fromState' | 'event'>) {
  return def.transitions.find((t) => t.from === rule.fromState && t.event === rule.event) ?? null;
}

/**
 * 保存前校验（红线闸 B）：规则必须"存在、合法、不指向终态"。
 * 抛错即拒绝保存——宁可拒绝一条配置，也不能让引擎自动关单。
 *
 * @throws Error 边不存在 / 事件不在白名单 / 目标态是终态
 */
export function assertAutoRuleSavable(
  def: WorkflowDef,
  rule: Pick<AutoRule, 'fromState' | 'event'>,
): { to: string } {
  if (!(AUTO_RULE_EVENTS as readonly string[]).includes(rule.event)) {
    throw new Error(`自动审核只允许 ${AUTO_RULE_EVENTS.join('/')} 事件：${rule.event}`);
  }
  const edge = resolveAutoRuleEdge(def, rule);
  if (!edge) {
    throw new Error(`本租户流程里不存在 ${rule.fromState} --${rule.event}--> 这条边`);
  }
  if ((TERMINAL_STATES as readonly string[]).includes(edge.to)) {
    throw new Error(`红线：不得自动推进到终态 ${edge.to}（终态必须由人工显式操作）`);
  }
  return { to: edge.to };
}
