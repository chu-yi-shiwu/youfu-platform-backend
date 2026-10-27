// P6 统计口径 —— 诚实区分"自动派单率"(过程指标) 与"自动闭环率"(验收北极星)。
// 依据审查报告 P6 定义：
//   - 自动派单率 = auto_flow=true 占比（过程指标，非北极星）
//   - 自动闭环率 = 工单从建单到 completed 全程无人值守比例
// 本版诚实口径：auto_close_rate = auto_flow=true 且最终 status=completed 的占比。
//   ⚠️ 注：这仍非"严格无人值守"口径（严格口径需结合 ticket_event 审计链逐单判定
//   是否有人工 transition 干预）。真实无人值守闭环率待工程接 ticket_event 审计聚合细化，
//   此处不编造"演示自动完成"数据（已消除演示自动置 completed 的旧问题）。
import type { PoolClient } from 'pg';
import { getDefsAcrossAllVersions, unionStates, intersectStates } from '../engine/workflowDef.js';
import { doneStates, terminalStates, activeStates, cancelledStates, DEFAULT_WORK_ORDER_DEF } from '../engine/stateMachine.js';

// P-5：统计聚合短 TTL 缓存（单进程部署足够；对齐 DataScreen 30s 刷新，降低重复聚合压力）。
// 按租户键隔离；仅缓存最终计算结果，不影响 RLS（结果已按租户算出）。
const STATS_TTL_MS = 30_000;
const statsCache = new Map<string, { at: number; value: unknown }>();
function cachedResult<T>(key: string): T | undefined {
  const hit = statsCache.get(key);
  if (hit && Date.now() - hit.at < STATS_TTL_MS) return hit.value as T;
  return undefined;
}
function storeResult<T>(key: string, value: T): T {
  statsCache.set(key, { at: Date.now(), value });
  return value;
}

/** 清空统计缓存（测试隔离 + 生产手动失效用）。 */
export function clearStatsCache(): void {
  statsCache.clear();
}

export interface TicketStats {
  tenant_id: string;
  total: number;
  completed: number;
  cancelled: number;              // 已撤销（废弃态）单数
  auto_dispatched: number;        // auto_flow=true 单数
  auto_closed: number;            // auto_flow=true 且 status=completed（诚实口径自动闭环）
  auto_dispatch_rate: number;     // 自动派单率（过程指标）
  auto_close_rate: number;        // 自动闭环率（验收口径，诚实）
  cancellation_rate: number;      // 撤销率 = cancelled / total（UOne 颗粒度：撤销率统计）
  satisfaction_avg: number;       // 满意度均分（UOne 颗粒度：满意度统计；无评价单返回 0）
  satisfaction_count: number;     // 已评价单数
  status_distribution: Record<string, number>;       // 各状态计数（UOne 统计绩效：状态分布）
  satisfaction_distribution: { score: string; count: number }[]; // 满意度星级分布（含 unrated 未评价）
  daily_trend: { date: string; created: number; completed: number }[]; // 近30天新建/完成趋势
  claim_hall_reasons: Record<string, number>; // V2-F3（派单纵切 P0-8）：落大厅原因细分计数（enter_hall 事件聚合）
  note: string;
}

export async function ticketStats(client: PoolClient, tenantId: string): Promise<TicketStats> {
  const cacheKey = `ticketStats:${tenantId}`;
  const hit = cachedResult<TicketStats>(cacheKey);
  if (hit) return hit;
  // A+ Phase1.5：完成态口径由 workflow_def 派生（DEFAULT=['completed']；RICH=['completed','closed','evaluated']），
  // 富模板下不漏计 closed/evaluated，且不把 cancelled 算完成。
  // T1-B 多版本并存兜底：统计是「包含」计数，取各版本**并集**——
  //   老单锁旧版本，其状态在新流程里可能不算完成/取消 ⇒ 只读 live 会让这批老单**漏计**。
  const defs = await getDefsAcrossAllVersions(client, tenantId, 'work_order', 'work_orders', DEFAULT_WORK_ORDER_DEF);
  const done = unionStates(defs.map(doneStates));
  // 取消态口径同源派生（不入这一格则客户改流程后 cancelled 恒为 0）。
  const cancelledStatesList = unionStates(defs.map(cancelledStates));
  const r = await client.query<{
    total: string;
    completed: string;
    cancelled: string;
    auto_dispatched: string;
    auto_closed: string;
    satisfaction_avg: string | null;
    satisfaction_count: string;
  }>(
    `SELECT
       COUNT(*)::text                                          AS total,
       COUNT(*) FILTER (WHERE status = ANY($2::text[]))::text  AS completed,
       COUNT(*) FILTER (WHERE status = ANY($3::text[]))::text      AS cancelled,
       COUNT(*) FILTER (WHERE auto_flow = true)::text          AS auto_dispatched,
       COUNT(*) FILTER (WHERE auto_flow = true AND status = ANY($2::text[]))::text AS auto_closed,
       AVG(satisfaction_score)::text                          AS satisfaction_avg,
       COUNT(satisfaction_score)::text                        AS satisfaction_count
     FROM work_orders WHERE tenant_id = $1`,
    [tenantId, done, cancelledStatesList],
  );
  const row = r.rows[0];
  const total = Number(row.total);
  const completed = Number(row.completed);
  const cancelled = Number(row.cancelled);
  const autoDispatched = Number(row.auto_dispatched);
  const autoClosed = Number(row.auto_closed);
  const satisfactionAvg = row.satisfaction_avg != null ? Number(row.satisfaction_avg) : 0;
  const satisfactionCount = Number(row.satisfaction_count);

  // UOne 统计绩效维度：状态分布 / 满意度星级分布 / 近30天趋势
  const sd = await client.query<{ status: string; c: string }>(
    `SELECT status, COUNT(*)::text AS c FROM work_orders WHERE tenant_id = $1 GROUP BY status`,
    [tenantId],
  );
  const status_distribution: Record<string, number> = {};
  for (const x of sd.rows) status_distribution[x.status] = Number(x.c);

  const sv = await client.query<{ score: string; c: string }>(
    `SELECT CASE WHEN satisfaction_score IS NULL THEN 'unrated' ELSE satisfaction_score::text END AS score,
            COUNT(*)::text AS c
     FROM work_orders WHERE tenant_id = $1 GROUP BY 1`,
    [tenantId],
  );
  const satisfaction_distribution = sv.rows.map((x) => ({ score: x.score, count: Number(x.c) }));

  const tr = await client.query<{ date: string; created: string; completed: string }>(
    `SELECT to_char(d, 'YYYY-MM-DD') AS date,
            COUNT(w.id) FILTER (WHERE w.created_at::date = d)::text AS created,
            COUNT(w.id) FILTER (WHERE w.status = ANY($2::text[]) AND w.updated_at::date = d)::text AS completed
     FROM generate_series(CURRENT_DATE - 29, CURRENT_DATE, '1 day') d
     LEFT JOIN work_orders w ON w.tenant_id = $1
     GROUP BY d ORDER BY d`,
    [tenantId, done],
  );
  const daily_trend = tr.rows.map((x) => ({ date: x.date, created: Number(x.created), completed: Number(x.completed) }));

  // V2-F3（派单纵切 P0-8 失配观测，2026-09-14）：落大厅原因细分计数——
  // enter_hall 事件 payload->>'reason' 分组聚合（no_rule_matched=配置/技能失配；
  // no_available_worker=无在岗工人；unknown=历史旧格式事件，诚实归档不丢弃）。
  const eh = await client.query<{ reason: string | null; c: string }>(
    `SELECT COALESCE(payload->>'reason', 'unknown') AS reason, COUNT(*)::text AS c
     FROM ticket_event WHERE tenant_id = $1 AND type = 'enter_hall' GROUP BY 1`,
    [tenantId],
  );
  const claim_hall_reasons: Record<string, number> = {};
  for (const x of eh.rows) {
    const n = Number(x.c);
    if (Number.isFinite(n)) claim_hall_reasons[x.reason ?? 'unknown'] = n;
  }

  const result: TicketStats = {
    tenant_id: tenantId,
    total,
    completed,
    cancelled,
    auto_dispatched: autoDispatched,
    auto_closed: autoClosed,
    auto_dispatch_rate: total ? Number((autoDispatched / total).toFixed(4)) : 0,
    auto_close_rate: total ? Number((autoClosed / total).toFixed(4)) : 0,
    cancellation_rate: total ? Number((cancelled / total).toFixed(4)) : 0,
    satisfaction_avg: satisfactionAvg,
    satisfaction_count: satisfactionCount,
    status_distribution,
    satisfaction_distribution,
    daily_trend,
    claim_hall_reasons,
    note: 'auto_close_rate 为诚实口径（auto_flow 命中且最终 completed）；非严格无人值守口径，严格口径待接 ticket_event 审计聚合；撤销率=已撤销/总数；满意度均分基于已评价单；daily_trend.completed 基于完成态工单 updated_at 近似完成日；claim_hall_reasons 按 enter_hall 事件 reason 分组（V2-F3 失配观测）',
  };
  return storeResult(cacheKey, result);
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
  const cacheKey = `processMetrics:${tenantId}`;
  const hit = cachedResult<ProcessMetrics>(cacheKey);
  if (hit) return hit;
  // A+ Phase1.5：由 workflow_def 派生"活跃集/完成态"，富模板下不写死 4 态。
  // T1-B 多版本并存兜底：**区分包含/排除两种判定**——本函数里 `done` 是包含（取并集），
  //   `terminals` 是排除（落在下面 `status <> ALL($2)`，**必须取交集**）。
  // ⚠️ 修错记录：初版这里把 `terminals` 也写成了并集（方向反了），批 5 的验收因为
  //   「在测试里手写正确写法再断言」而没抓到 ⇒ 独立评审才发现。现由
  //   workflowDefAtVersion.pglite.test.ts「批 6」真调本函数守卫，写错立刻红。
  //   并集会让排除集变大 ⇒ 锁旧版本的老单被排掉 ⇒ 大屏「活跃堆积」少报（静默丢单）。
  const defs = await getDefsAcrossAllVersions(client, tenantId, 'work_order', 'work_orders', DEFAULT_WORK_ORDER_DEF);
  const terminals = intersectStates(defs.map(terminalStates)); // 终态（含 cancelled/closed/evaluated）→ 不计入活跃堆
  const done = unionStates(defs.map(doneStates)); // 成功完成态（含 completed 里程碑态）
  // 1) 派单命中率 + 转派率
  const base = await client.query<{ total: string; auto_dispatched: string }>(
    `SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE auto_flow = true)::text AS auto_dispatched
     FROM work_orders WHERE tenant_id = $1`,
    [tenantId],
  );
  // 转派率口径修复（横切⑤⑥ F4）：ticket_event 无 'assign' 类型——转派事实记录在
  // payload->>'transition_event'（'forward'/'dispatch'，dispatchNotification/转台链路写入）。
  // 原口径「每单事件数 ≥2」把状态流转/接单/完成等任意第二起事件都误判为转派，
  // reassign_rate 恒虚高。改为按 transition_event ∈ ('forward','dispatch') 精确计数。
  const reassigned = await client.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM (
       SELECT work_order_id FROM ticket_event
       WHERE tenant_id = $1 AND payload->>'transition_event' = ANY(ARRAY['forward','dispatch']::text[])
       GROUP BY work_order_id
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

  const result: ProcessMetrics = {
    tenant_id: tenantId,
    total,
    dispatch_hit_rate,
    reassign_rate,
    sla_rate,
    sla_note,
    duration_buckets,
    bottleneck: bottleneckArr,
  };
  return storeResult(cacheKey, result);
}

// ── worker.load 漂移对账（2026-10-19 · 只读诊断）──────────────────────────────
// 背景：worker.load 是**派单负载均衡的唯一输入**（engine/dispatch.ts 的 least_load 与
//   模型评分都按它排序）。它是累加字段，历史上曾出现"只增不减"导致与真实在身单数
//   长期背离（t-phasea 实证：某工人记 9、实际 1；另一人记 1、实际 9）——
//   后果是派单均衡持续把单派给已经闲着的人、压着真正忙的人。
//   2026-08-31 起流转已做净结算（R32），**新发生的流转不会再产生偏差**，
//   但存量偏差不会自愈。本函数只做**只读对账**，把背离暴露出来供人工决策，
//   绝不自动改数据（校正写库必须由人批准）。
export interface WorkerLoadDrift {
  worker_id: string;
  name: string;
  /** 系统记的在身数（派单均衡实际使用的数）。 */
  load: number;
  /** 按流程口径重算的真实在身单数（活跃态且 assignee 是本工人）。 */
  active_orders: number;
  /** 差值 = load − active_orders；非 0 即失真（正=虚高会被少派，负=虚低会被多派）。 */
  drift: number;
}

/**
 * 只读对账：逐工人比对 worker.load 与真实在身单数。
 * 活跃态口径与 load 净结算同源（activeStates(def)），杜绝两处口径漂移。
 */
export async function workerLoadDrift(client: PoolClient, tenantId: string): Promise<WorkerLoadDrift[]> {
  // T1-B 多版本并存兜底：工人负载是「包含」计数，取各版本**并集**——
  //   老单不计入某工人名下 ⇒ 该工人看起来更闲 ⇒ **派单会给他派更多，实际过载**。
  const defs = await getDefsAcrossAllVersions(client, tenantId, 'work_order', 'work_orders', DEFAULT_WORK_ORDER_DEF);
  const active = unionStates(defs.map(activeStates));
  const r = await client.query<{ id: string; name: string; load: number; c: string }>(
    `SELECT w.id, w.name, w.load, COALESCE(a.cnt, 0)::text AS c
       FROM worker w
       LEFT JOIN (
         SELECT assignee_id, COUNT(*) AS cnt FROM work_orders
          WHERE tenant_id = $1 AND status = ANY($2::text[])
          GROUP BY assignee_id
       ) a ON a.assignee_id = w.id
      WHERE w.tenant_id = $1
      ORDER BY ABS(w.load - COALESCE(a.cnt, 0)) DESC, w.id`,
    [tenantId, active],
  );
  return r.rows.map((x) => {
    const activeOrders = Number(x.c);
    return {
      worker_id: x.id,
      name: x.name,
      load: Number(x.load) || 0,
      active_orders: activeOrders,
      drift: (Number(x.load) || 0) - activeOrders,
    };
  });
}
