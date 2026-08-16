// P6 统计口径 —— 诚实区分"自动派单率"(过程指标) 与"自动闭环率"(验收北极星)。
// 依据审查报告 P6 定义：
//   - 自动派单率 = auto_flow=true 占比（过程指标，非北极星）
//   - 自动闭环率 = 工单从建单到 completed 全程无人值守比例
// 本版诚实口径：auto_close_rate = auto_flow=true 且最终 status=completed 的占比。
//   ⚠️ 注：这仍非"严格无人值守"口径（严格口径需结合 ticket_event 审计链逐单判定
//   是否有人工 transition 干预）。真实无人值守闭环率待工程接 ticket_event 审计聚合细化，
//   此处不编造"演示自动完成"数据（已消除演示自动置 completed 的旧问题）。
import type { PoolClient } from 'pg';
import { getWorkflowDef } from '../engine/workflowDef.js';
import { doneStates, terminalStates } from '../engine/stateMachine.js';

export interface TicketStats {
  tenant_id: string;
  total: number;
  completed: number;
  auto_dispatched: number;        // auto_flow=true 单数
  auto_closed: number;            // auto_flow=true 且 status=completed（诚实口径自动闭环）
  auto_dispatch_rate: number;     // 自动派单率（过程指标）
  auto_close_rate: number;        // 自动闭环率（验收口径，诚实）
  note: string;
}

export async function ticketStats(client: PoolClient, tenantId: string): Promise<TicketStats> {
  // A+ Phase1.5：完成态口径由 workflow_def 派生（DEFAULT=['completed']；RICH=['completed','closed','evaluated']），
  // 富模板下不漏计 closed/evaluated，且不把 cancelled 算完成。
  const def = await getWorkflowDef(client, tenantId, 'work_order');
  const done = doneStates(def);
  const r = await client.query<{
    total: string;
    completed: string;
    auto_dispatched: string;
    auto_closed: string;
  }>(
    `SELECT
       COUNT(*)::text                                          AS total,
       COUNT(*) FILTER (WHERE status = ANY($2::text[]))::text  AS completed,
       COUNT(*) FILTER (WHERE auto_flow = true)::text          AS auto_dispatched,
       COUNT(*) FILTER (WHERE auto_flow = true AND status = ANY($2::text[]))::text AS auto_closed
     FROM work_orders WHERE tenant_id = $1`,
    [tenantId, done],
  );
  const row = r.rows[0];
  const total = Number(row.total);
  const completed = Number(row.completed);
  const autoDispatched = Number(row.auto_dispatched);
  const autoClosed = Number(row.auto_closed);
  return {
    tenant_id: tenantId,
    total,
    completed,
    auto_dispatched: autoDispatched,
    auto_closed: autoClosed,
    auto_dispatch_rate: total ? Number((autoDispatched / total).toFixed(4)) : 0,
    auto_close_rate: total ? Number((autoClosed / total).toFixed(4)) : 0,
    note: 'auto_close_rate 为诚实口径（auto_flow 命中且最终 completed）；非严格无人值守口径，严格口径待接 ticket_event 审计聚合',
  };
}

// ============ B2 过程挖掘度量层 ============
// 消费 work_orders + ticket_event + domain_event，计算派单命中率/转派率/SLA/时长分布/瓶颈。
// 诚实口径（延续 P6）：仅统计有数据的指标，缺失返回 0 并 note，禁止编造。

export interface ProcessMetrics {
  tenant_id: string;
  total: number;
  dispatch_hit_rate: number; // 自动派单命中率（auto_flow=true 占比）
  reassign_rate: number; // 转派率（同单 >=2 次 assign 占比）
  sla_rate: number; // SLA 达成率（仅计配置了 sla_due_at 的工单）
  sla_note: string;
  duration_buckets: { lt_1h: number; h1_4: number; h4_24: number; gt_24h: number };
  bottleneck: { entity_type: string; active: number }[];
}

/** 纯函数：由聚合计数计算比率（便于单测，脱离 PG） */
export function calcRates(
  total: number,
  autoDispatched: number,
  reassigned: number,
): { dispatch_hit_rate: number; reassign_rate: number } {
  return {
    dispatch_hit_rate: total ? Number((autoDispatched / total).toFixed(4)) : 0,
    reassign_rate: total ? Number((reassigned / total).toFixed(4)) : 0,
  };
}

/** 纯函数：SLA 达成率（仅计有 SLA 的工单；无 SLA 配置返回 0 并标注） */
export function calcSlaRate(withSla: number, slaMet: number): { sla_rate: number; sla_note: string } {
  if (!withSla)
    return { sla_rate: 0, sla_note: '当前租户暂无配置 SLA 的工单，SLA 达成率无数据可算（返回 0，不编造）' };
  return { sla_rate: Number((slaMet / withSla).toFixed(4)), sla_note: `基于 ${withSla} 张配置了 SLA 的工单计算` };
}

/** 纯函数：时长（分钟）分桶 [<60, 60-240, 240-1440, >1440] */
export function bucketDuration(minutesArr: number[]): { lt_1h: number; h1_4: number; h4_24: number; gt_24h: number } {
  const b = { lt_1h: 0, h1_4: 0, h4_24: 0, gt_24h: 0 };
  for (const m of minutesArr) {
    if (m < 60) b.lt_1h++;
    else if (m < 240) b.h1_4++;
    else if (m < 1440) b.h4_24++;
    else b.gt_24h++;
  }
  return b;
}

export async function processMetrics(client: PoolClient, tenantId: string): Promise<ProcessMetrics> {
  // A+ Phase1.5：由 workflow_def 派生"活跃集/完成态"，富模板下不写死 4 态。
  const def = await getWorkflowDef(client, tenantId, 'work_order');
  const terminals = terminalStates(def); // 终态（含 cancelled/closed/evaluated）→ 不计入活跃堆
  const done = doneStates(def); // 成功完成态（含 completed 里程碑态）
  // 1) 派单命中率 + 转派率
  const base = await client.query<{ total: string; auto_dispatched: string }>(
    `SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE auto_flow = true)::text AS auto_dispatched
     FROM work_orders WHERE tenant_id = $1`,
    [tenantId],
  );
  const reassigned = await client.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM (
       SELECT work_order_id FROM ticket_event WHERE tenant_id = $1 GROUP BY work_order_id HAVING COUNT(*) >= 2
     ) t`,
    [tenantId],
  );
  const total = Number(base.rows[0].total);
  const autoDispatched = Number(base.rows[0].auto_dispatched);
  const reCount = Number(reassigned.rows[0].c);
  const { dispatch_hit_rate, reassign_rate } = calcRates(total, autoDispatched, reCount);

  // 2) SLA 达成率（完成态由 def 派生：DEFAULT=completed；RICH=completed/closed/evaluated）
  const sla = await client.query<{ with_sla: string; sla_met: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE sla_due_at IS NOT NULL)::text AS with_sla,
       COUNT(*) FILTER (WHERE sla_due_at IS NOT NULL AND status = ANY($2::text[]) AND updated_at <= sla_due_at)::text AS sla_met
     FROM work_orders WHERE tenant_id = $1`,
    [tenantId, done],
  );
  const { sla_rate, sla_note } = calcSlaRate(Number(sla.rows[0].with_sla), Number(sla.rows[0].sla_met));

  // 3) 工单时长分布（完成态工单，分钟）
  const dur = await client.query<{ minutes: string | null }>(
    `SELECT EXTRACT(EPOCH FROM (updated_at - created_at)) / 60 AS minutes
     FROM work_orders WHERE tenant_id = $1 AND status = ANY($2::text[])`,
    [tenantId, done],
  );
  const duration_buckets = bucketDuration(dur.rows.map((r) => (r.minutes != null ? Number(r.minutes) : 0)));

  // 4) 瓶颈定位：各模块活跃（非终态）实体堆积；work_order 活跃集由 def 终态派生（富模板不漏计评审/完成态）
  const bottleneck = await client.query<{ entity_type: string; active: string }>(
    `SELECT 'work_order' AS entity_type, COUNT(*)::text AS active FROM work_orders WHERE tenant_id=$1 AND status <> ALL($2::text[])
     UNION ALL SELECT 'inspection_task', COUNT(*)::text FROM inspection_task WHERE tenant_id=$1 AND status IN ('pending','in_progress')
     UNION ALL SELECT 'volunteer_record', COUNT(*)::text FROM volunteer_record WHERE tenant_id=$1 AND status IN ('registered','checked_in')
     UNION ALL SELECT 'feedback', COUNT(*)::text FROM feedback WHERE tenant_id=$1 AND status='new'
     UNION ALL SELECT 'monitor_alert', COUNT(*)::text FROM monitor_alert WHERE tenant_id=$1 AND status='active'`,
    [tenantId, terminals],
  );
  const bottleneckArr = bottleneck.rows
    .map((r) => ({ entity_type: r.entity_type, active: Number(r.active) }))
    .sort((a, b) => b.active - a.active);

  return {
    tenant_id: tenantId,
    total,
    dispatch_hit_rate,
    reassign_rate,
    sla_rate,
    sla_note,
    duration_buckets,
    bottleneck: bottleneckArr,
  };
}
