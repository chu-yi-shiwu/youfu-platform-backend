// 只读工具执行器（智能体批次一 · 2026-09-07）：供 adminAiChat 路由注入 runAdminTurn。
// ───────────────────────────────────────────────────────────────────────────
// 安全铁律：
//   - 只读（SELECT），全程不写库、不改状态、不发通知；
//   - 参数二次净化（adminAgent.sanitizeTicketQueryArgs 复洗，防模型越权形状——双保险）；
//   - 租户隔离走 withTenantClient（RLS 既有范式，SET LOCAL app.tenant_id + ROLE youfu_app）；
//   - 话术服务端确定性拼接（真实行数/行数据），模型零自由发挥空间 → 无幻觉数字。
// ───────────────────────────────────────────────────────────────────────────
import { withTenantClient } from '../db/pool.js';
import { list, type WorkOrderRow } from '../repo/ticket.js';
import { getWorkflowDef, getDefsAcrossAllVersions, intersectStates } from '../engine/workflowDef.js';
import { doneStates, DEFAULT_WORK_ORDER_DEF } from '../engine/stateMachine.js';
import {
  sanitizeTicketQueryArgs,
  type AdminToolExecutor,
  type TicketQueryArgs,
  type TicketResultCard,
  type TicketResultItem,
  type StatsCard,
} from './adminAgent.js';

/** 结果卡最多展示条数（total 是真实总数，items 只带前 5 条防刷屏/防大包） */
const RESULT_SHOW = 5;

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function toResultItem(r: WorkOrderRow): TicketResultItem {
  return {
    id: r.id,
    order_no: r.order_no,
    status: r.status,
    priority: r.priority,
    department: r.department ?? undefined,
    assignee_name: r.assignee_name ?? null,
    created_at: r.created_at,
  };
}

function describeConds(q: { status?: string; priority?: string; department?: string; service_desk?: string; source?: string; today_only?: boolean }): string {
  const parts: string[] = [];
  if (q.today_only) parts.push('仅今天');
  if (q.priority) parts.push(`优先级 ${q.priority}`);
  if (q.status) parts.push(`状态 ${q.status}`);
  if (q.department) parts.push(`科室/位置 ${q.department}`);
  if (q.service_desk) parts.push(`服务台 ${q.service_desk}`);
  if (q.source) parts.push(`来源 ${q.source}`);
  return parts.join(' · ');
}

/** 确定性关键词兜底（live 探针 P2/P4 教训：模型丢条件）：
 *  用户原话里的"urgent/紧急/今天/处理中"等确定性信号直接落到查询参数，
 *  模型 args 与原话冲突时以原话为准（确定性优先，模型只做补充）。 */
/**
 * F10：候选状态名先过一遍租户 def 的白名单。
 *   此前这里按内置模板的名字硬推 assigned/processing/completed/closed/evaluated——
 *   租户自定义流程里根本没有这些名字时，AI 客服会把用户原话里的「处理中/已完成」
 *   翻译成**本租户不存在的状态**，list() 按它去过滤 ⇒ 查什么都是 0 单（且对话里看不出原因）。
 *   现在：命中关键词后只保留真实存在于该租户流程里的状态；knownStates 缺省时保持旧行为。
 */
function augmentArgsFromMessage(msg: string | undefined, q: TicketQueryArgs, knownStates?: readonly string[]): TicketQueryArgs {
  if (!msg) return q;
  // 优先级：原话关键词强信号直接覆盖模型 args（原话为准）；弱信号仅在缺失时补
  if (/urgent|紧急/i.test(msg)) q.priority = 'urgent';
  else if (/\blow\b|低优先/.test(msg)) q.priority = 'low';
  else if (!q.priority && /普通|normal/i.test(msg)) q.priority = 'normal';
  if (!q.today_only && /今天|今日|当天/.test(msg)) q.today_only = true;
  if (!q.status) {
    const keep = (names: string[]) =>
      knownStates && knownStates.length > 0 ? names.filter((n) => knownStates.includes(n)) : names;
    const st: string[] = [];
    if (/待处理|待派|待接|待审核|pending/.test(msg)) st.push(...keep(['pending']));
    if (/已派|处理中|进行中|assigned|processing/.test(msg)) st.push(...keep(['assigned', 'processing']));
    if (/已完成|已完工|completed/.test(msg)) st.push(...keep(['completed']));
    if (/已关闭|已评价|closed|evaluated/.test(msg)) st.push(...keep(['closed', 'evaluated']));
    if (st.length) q.status = [...new Set(st)].slice(0, 4).join(',');
  }
  return q;
}

async function queryTickets(tenantId: string, rawArgs: Record<string, unknown>, message?: string): Promise<{ reply: string; card: TicketResultCard } | null> {
  const base = sanitizeTicketQueryArgs(rawArgs);
  if (!base) return null;
  return withTenantClient(tenantId, async (client) => {
    // F10：先读租户 def —— 原话关键词→状态名的翻译必须按该租户真实的状态集合来做
    const def = await getWorkflowDef(client, tenantId, 'work_order');
    const q = augmentArgsFromMessage(message, base, def.states);
    const { items, total } = await list(client, tenantId, {
      status: q.status as never,
      priority: q.priority,
      department: q.department,
      source: q.source,
      service_desk: q.service_desk,
      limit: 10,
      offset: 0,
      createdSince: q.today_only ? startOfToday() : undefined,
    });
    const card: TicketResultCard = {
      type: 'ticket_result',
      total,
      items: items.slice(0, RESULT_SHOW).map(toResultItem),
    };
    const conds = describeConds(q);
    const reply =
      `查询完成${conds ? '（' + conds + '）' : ''}：共 ${total} 单符合条件` +
      (total > RESULT_SHOW ? `，以下显示最近 ${RESULT_SHOW} 条，可点击卡片查看详情。` : '。');
    return { reply, card };
  });
}

async function getStats(tenantId: string): Promise<{ reply: string; card: StatsCard }> {
  return withTenantClient(tenantId, async (client) => {
    // T1-B 多版本并存兜底：`done` 落在下面的 `status <> ALL($2::text[])` ⇒ 是**排除**判定，
    //   必须取各版本**交集**（只排除"每个版本都认是完成态"的状态）。
    //   只读 live 一份的后果：客户改流程后，老单（锁 v1）的状态在 v1 里算未完成、在 v2 里算了完成
    //   ⇒ 这批老单被静默排掉 ⇒ 话术里的「当前未完成 N 单」**少报**（值班人据此判断积压，方向错）。
    //   取并集则是反向错：排除集变大 ⇒ 少报得更狠。由 adminAgentTools.test.ts「未完成排除集取各版本交集」守卫。
    const defs = await getDefsAcrossAllVersions(client, tenantId, 'work_order', 'work_orders', DEFAULT_WORK_ORDER_DEF);
    const done = intersectStates(defs.map(doneStates));
    const todayR = await client.query(
      `SELECT status, COUNT(*)::int AS c FROM work_orders WHERE tenant_id=$1 AND created_at >= date_trunc('day', now()) GROUP BY status ORDER BY c DESC`,
      [tenantId],
    );
    const openR = await client.query(
      `SELECT COUNT(*)::int AS c FROM work_orders WHERE tenant_id=$1 AND status <> ALL($2::text[])`,
      [tenantId, done],
    );
    const rows = todayR.rows.map((r: { status: string; c: number }) => ({ status: String(r.status), count: Number(r.c) }));
    const totalToday = rows.reduce((s, r) => s + r.count, 0);
    const openTotal = Number(openR.rows[0]?.c ?? 0);
    const card: StatsCard = { type: 'usage_stats', total_today: totalToday, open_total: openTotal, rows };
    const breakdown = rows.map((r) => `${r.status} ${r.count}`).join('、');
    const reply = `今日新增 ${totalToday} 单${breakdown ? '（' + breakdown + '）' : ''}，当前未完成 ${openTotal} 单。`;
    return { reply, card };
  });
}

/** 构造绑定租户的只读工具执行器（每次请求新建，租户隔离；测试可直接注入 mock 替代）。 */
export function makeAdminToolExecutor(tenantId: string): AdminToolExecutor {
  return async (tool, rawArgs, message) => {
    if (tool === 'query_tickets') return queryTickets(tenantId, rawArgs, message);
    if (tool === 'get_stats') return getStats(tenantId);
    return null;
  };
}
