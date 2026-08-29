// ⑦P0 过程挖掘看板 —— 数据层（飞轮"眼睛"）。
// 消费统一事件总线 domain_event（020），按 entity_id 回放事件时序，
// 产出：流程变体(variant)发现、瓶颈时长、吞吐、合规偏离。
// ③ 精确状态机合规：当该业务流配置了 workflow_def 时，对每条轨迹用可配置状态机引擎
//   （canTransition）逐跳回放校验合法跳转（'create' 视为进入初始态的引导事件，其余 type 即状态），
//   偏离率=不合规轨迹占比；这能真实驱动优化飞轮（如 rework 的 recheck 未纳入状态机时被判偏离→触发 recheck_gate）。
//   未配置 workflow_def 的业务流诚实降级回"主导路径近似"（不编造精确合规）。
// 全程只读、全 $1 参数化（满足发布闸门 SQL 注入扫描）；不新增任何迁移。
// 纯函数与 PG 查询分离，便于单测（模仿 repo/stats.ts 的 calc* 纯函数模式）。
import type { PoolClient } from 'pg';
import { canTransition, isKnownState, doneStates, learningTriggerStates, autoRouteStates, autoRouteFor, type WorkflowDef } from '../engine/stateMachine.js';
import { getWorkflowDef } from '../engine/workflowDef.js';

export interface RawEvent {
  entity_id: string | null;
  type: string;
  actor: string | null;
  created_at: Date;
}

export interface TraceEvent {
  type: string;
  actor: string | null;
  at: number; // epoch ms
}

export interface Trace {
  entityId: string;
  events: TraceEvent[];
}

export interface Variant {
  seq: string[];
  count: number;
  share: number; // 0..1
}

export interface ActivityStat {
  activity: string;
  avg_minutes: number;
  max_minutes: number;
  count: number;
}

export interface EdgeStat {
  from: string;
  to: string;
  avg_minutes: number;
  max_minutes: number;
  count: number;
}

export interface ThroughputPoint {
  day: string; // YYYY-MM-DD
  events: number;
  cases: number;
}

export interface Conformance {
  happy_path: string[];
  deviation_rate: number;
  deviating_variants: Variant[];
  precise: boolean; // true=状态机逐跳校验；false=主导路径近似（该业务流未配置 workflow_def）
  note: string;
}

export interface ResonanceInfo {
  configured: boolean; // 该业务流是否配置了 workflow_def（共振控制点存在）
  initial: string;
  done_states: string[]; // 完成态口径（统计/训练样本）
  learning_triggers: string[]; // 数据→模型共振触发态（per-def，Task179 接线）
  auto_routes: { from: string; to: string; strategy: string | null }[]; // 自动派发路由（模型 surface 反写入口）
  learning_hits_in_scope: number; // 范围内实际踏入学习触发态的工单数（共振已发生）
  auto_dispatched_in_scope: number; // 范围内自动派发工单数（autoRoutes 已生效）
  model_version: number; // 模型已学习次数（累计；incrementalLearn 每次 +1）
}

export interface ProcessMiningResult {
  tenant_id: string;
  entity_type: string;
  generated_at: string;
  scope: { days: number; from: string; to: string };
  overview: { case_count: number; event_count: number; available_entity_types: string[] };
  variants: Variant[];
  bottlenecks: {
    per_activity: ActivityStat[];
    per_edge: EdgeStat[];
    slowest_edge: EdgeStat | null;
    slowest_activity: ActivityStat | null;
  };
  throughput: ThroughputPoint[];
  conformance: Conformance;
  resonance: ResonanceInfo; // ④⑤ 模数共振可视化（Task186）
}

// ============ 纯函数（脱离 PG，便于单测） ============

const round1 = (n: number): number => Number(n.toFixed(1));

/** 按 entity_id 回放事件时序 → 轨迹列表（无 entity_id 的事件无法成 case，跳过）。 */
export function replayTraces(rows: RawEvent[]): Trace[] {
  const map = new Map<string, TraceEvent[]>();
  for (const r of rows) {
    if (!r.entity_id) continue; // 无 case 标识无法回放（仍计入 event_count）
    const arr = map.get(r.entity_id) ?? [];
    arr.push({ type: r.type, actor: r.actor, at: r.created_at.getTime() });
    map.set(r.entity_id, arr);
  }
  const traces: Trace[] = [];
  for (const [entityId, events] of map) {
    events.sort((a, b) => a.at - b.at);
    traces.push({ entityId, events });
  }
  return traces;
}

/** 聚合变体：相同活动序列去重计数 + 占比（按频次降序）。 */
export function aggregateVariants(traces: Trace[]): Variant[] {
  const counts = new Map<string, { seq: string[]; count: number }>();
  for (const t of traces) {
    const seq = t.events.map((e) => e.type);
    const key = JSON.stringify(seq);
    const cur = counts.get(key);
    if (cur) cur.count++;
    else counts.set(key, { seq, count: 1 });
  }
  const total = traces.length || 1;
  return [...counts.values()]
    .map((v) => ({ seq: v.seq, count: v.count, share: Number((v.count / total).toFixed(4)) }))
    .sort((a, b) => b.count - a.count);
}

/** 瓶颈：每活动停留时长（到下一事件）与每直接后继边(directly-follows)时长。 */
export function computeBottlenecks(traces: Trace[]): {
  per_activity: ActivityStat[];
  per_edge: EdgeStat[];
  slowest_edge: EdgeStat | null;
  slowest_activity: ActivityStat | null;
} {
  const actMap = new Map<string, { sum: number; max: number; n: number }>();
  const edgeMap = new Map<string, { sum: number; max: number; n: number }>();
  for (const t of traces) {
    for (let i = 0; i < t.events.length - 1; i++) {
      const cur = t.events[i];
      const next = t.events[i + 1];
      const mins = (next.at - cur.at) / 60000;
      const a = actMap.get(cur.type) ?? { sum: 0, max: 0, n: 0 };
      a.sum += mins;
      a.max = Math.max(a.max, mins);
      a.n++;
      actMap.set(cur.type, a);
      const ek = JSON.stringify([cur.type, next.type]);
      const e = edgeMap.get(ek) ?? { sum: 0, max: 0, n: 0 };
      e.sum += mins;
      e.max = Math.max(e.max, mins);
      e.n++;
      edgeMap.set(ek, e);
    }
  }
  const perActivity = [...actMap.entries()]
    .map(([k, v]) => ({ activity: k, avg_minutes: round1(v.sum / v.n), max_minutes: round1(v.max), count: v.n }))
    .sort((a, b) => b.avg_minutes - a.avg_minutes);
  const perEdge = [...edgeMap.entries()]
    .map(([k, v]) => {
      const [from, to] = JSON.parse(k) as [string, string];
      return { from, to, avg_minutes: round1(v.sum / v.n), max_minutes: round1(v.max), count: v.n };
    })
    .sort((a, b) => b.avg_minutes - a.avg_minutes);
  return {
    per_activity: perActivity,
    per_edge: perEdge,
    slowest_edge: perEdge[0] ?? null,
    slowest_activity: perActivity[0] ?? null,
  };
}

/** 吞吐：按天聚合事件数 + 当日活跃 case 数（范围外事件忽略）。 */
export function computeThroughput(events: RawEvent[], from: Date, to: Date): ThroughputPoint[] {
  const dayMap = new Map<string, { events: number; cases: Set<string> }>();
  for (const e of events) {
    const d = e.created_at;
    if (d < from || d > to) continue;
    const day = d.toISOString().slice(0, 10);
    const bucket = dayMap.get(day) ?? { events: 0, cases: new Set<string>() };
    bucket.events++;
    if (e.entity_id) bucket.cases.add(e.entity_id);
    dayMap.set(day, bucket);
  }
  return [...dayMap.entries()]
    .map(([day, b]) => ({ day, events: b.events, cases: b.cases.size }))
    .sort((a, b) => (a.day < b.day ? -1 : 1));
}

/** 单条轨迹状态机回放：是否整体合规（每跳均为合法跳转）。
 *  domain_event.type 语义：状态流转事件=结果状态；生命周期事件不推进状态机：
 *   - 'create'     建单引导事件 → 进入初始态（不构成一次状态跳转）
 *   - 'sla_escalated' SLA 升级标注事件 → 不改 workflow 状态（只写 escalated_at），跳过
 *   - 历史口径 'assign' → 兼容映射为结果状态 'assigned'（④ 前自动派单写的是事件名） */
function replayTraceConforms(def: WorkflowDef, t: Trace): boolean {
  let cur: string | null = null;
  for (const e of t.events) {
    let ty = e.type;
    if (ty === 'create') {
      if (cur !== null) return false; // create 不应在流程中段出现
      cur = def.initial;
      continue;
    }
    if (ty === 'sla_escalated') continue; // 标注事件，不改状态机
    if (ty === 'assign') ty = 'assigned'; // 兼容历史事件总线口径(事件名→结果状态)
    if (!isKnownState(def, ty)) return false; // 未知活动/状态
    if (cur === null) {
      if (ty !== def.initial) return false; // 首个真实活动须为初始态
      cur = ty;
    } else if (!canTransition(def, cur, ty)) {
      return false; // 非法跳转
    } else {
      cur = ty;
    }
  }
  return true;
}

/** 精确状态机合规（③）：逐轨迹回放校验，偏离率=不合规轨迹占比。 */
export function computeConformancePrecise(def: WorkflowDef, traces: Trace[], variants: Variant[]): Conformance {
  if (traces.length === 0) {
    return {
      happy_path: [],
      deviation_rate: 0,
      deviating_variants: [],
      precise: true,
      note: '当前范围无流程实例，无法计算合规偏离（不编造）',
    };
  }
  let nonConforming = 0;
  const confByVariant = new Map<string, number>();
  const nonConfByVariant = new Map<string, number>();
  for (const t of traces) {
    const key = JSON.stringify(t.events.map((e) => e.type));
    if (replayTraceConforms(def, t)) {
      confByVariant.set(key, (confByVariant.get(key) ?? 0) + 1);
    } else {
      nonConforming++;
      nonConfByVariant.set(key, (nonConfByVariant.get(key) ?? 0) + 1);
    }
  }
  const total = traces.length;
  const deviationRate = Number((nonConforming / total).toFixed(4));
  const deviatingVariants = variants
    .filter((v) => (nonConfByVariant.get(JSON.stringify(v.seq)) ?? 0) > 0)
    .map((v) => ({ ...v }));
  // happy_path = 合规轨迹中出现频次最高的变体序列
  let happy: string[] = [];
  let best = -1;
  for (const v of variants) {
    const c = confByVariant.get(JSON.stringify(v.seq)) ?? 0;
    if (c > best) {
      best = c;
      happy = v.seq;
    }
  }
  return {
    happy_path: happy,
    deviation_rate: deviationRate,
    deviating_variants: deviatingVariants,
    precise: true,
    note: `精确状态机合规：基于 workflow_def(${def.states.join('/')}) 逐轨迹回放校验合法跳转；偏离率=不合规轨迹占比(${nonConforming}/${total})。'create' 视为进入初始态 ${def.initial} 的引导事件。`,
  };
}

/** 主导路径近似合规（降级用：该业务流未配置 workflow_def 时诚实退化为"主导路径依从"）。 */
export function computeConformanceApprox(variants: Variant[]): Conformance {
  if (variants.length === 0) {
    return {
      happy_path: [],
      deviation_rate: 0,
      deviating_variants: [],
      precise: false,
      note: '当前范围无流程实例，无法计算合规偏离（不编造）',
    };
  }
  const happy = variants[0];
  const total = variants.reduce((s, v) => s + v.count, 0);
  const deviating = variants.slice(1);
  const deviationRate = total ? Number(((total - happy.count) / total).toFixed(4)) : 0;
  return {
    happy_path: happy.seq,
    deviation_rate: deviationRate,
    deviating_variants: deviating,
    precise: false,
    note: `主导路径近似合规（该业务流未配置 workflow_def）：偏离率=1-主导占比；精确状态机合规需先配置状态图。`,
  };
}

// ============ PG 查询（全 $1 参数化，禁 req. 直插） ============

export interface ProcessMiningOpts {
  entityType?: string;
  days?: number;
  limit?: number;
}

export async function processMining(
  client: PoolClient,
  tenantId: string,
  opts: ProcessMiningOpts = {},
): Promise<ProcessMiningResult> {
  const days = Math.min(Math.max(opts.days ?? 30, 1), 365);
  const limit = Math.min(Math.max(opts.limit ?? 50000, 1), 200000);
  const entityType = opts.entityType ?? 'work_order';
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);

  // 可选 entity_type 清单（供看板下拉）
  const etR = await client.query<{ entity_type: string }>(
    `SELECT DISTINCT entity_type FROM domain_event WHERE tenant_id = $1 ORDER BY entity_type`,
    [tenantId],
  );
  const available = etR.rows.map((r) => r.entity_type);

  // 选中 entity_type 在范围内的事件（按 case+时间排序，便于回放）
  const evR = await client.query<RawEvent>(
    `SELECT entity_id, type, actor, created_at
     FROM domain_event
     WHERE tenant_id = $1 AND entity_type = $2 AND created_at >= $3 AND created_at <= $4
     ORDER BY entity_id, created_at
     LIMIT $5`,
    [tenantId, entityType, from, to, limit],
  );
  const rows = evR.rows;

  const traces = replayTraces(rows);
  const variants = aggregateVariants(traces);
  const bottlenecks = computeBottlenecks(traces);
  const throughput = computeThroughput(rows, from, to);
  // ③ 精确状态机合规：仅当该业务流确有 workflow_def 行时用状态机逐跳校验；
  // 否则诚实降级回主导路径近似（避免未配置状态机的业务流被误判）。
  const hasDef = !!(
    await client.query(
      `SELECT 1 FROM workflow_def WHERE tenant_id = $1 AND entity_type = $2 LIMIT 1`,
      [tenantId, entityType],
    )
  ).rowCount;
  const def = await getWorkflowDef(client, tenantId, entityType);
  const conformance = hasDef
    ? computeConformancePrecise(def, traces, variants)
    : computeConformanceApprox(variants);

  // ④⑤ 模数共振可视化（Task186）：把刚接线的 per-def 配置与其实际作用诚实呈现。
  const lt = learningTriggerStates(def);
  const arFroms = autoRouteStates(def);
  const arList = arFroms.map((from) => {
    const r = autoRouteFor(def, from)!;
    return { from, to: r.to, strategy: r.strategy ?? null };
  });
  const hitR = await client.query<{ n: number }>(
    `SELECT COUNT(DISTINCT work_order_id)::int AS n
     FROM ticket_event
     WHERE tenant_id = $1 AND to_status = ANY($2::text[]) AND created_at >= $3 AND created_at <= $4`,
    [tenantId, lt, from, to],
  );
  const autoR = await client.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM work_orders WHERE tenant_id = $1 AND auto_flow = true AND created_at >= $2 AND created_at <= $3`,
    [tenantId, from, to],
  );
  const mvR = await client.query<{ version: number }>(
    `SELECT version FROM model_state WHERE tenant_id = $1 AND model_key = $2`,
    [tenantId, 'dispatch_score'],
  );
  const resonance: ResonanceInfo = {
    configured: hasDef,
    initial: def.initial,
    done_states: doneStates(def),
    learning_triggers: lt,
    auto_routes: arList,
    learning_hits_in_scope: hitR.rows[0]?.n ?? 0,
    auto_dispatched_in_scope: autoR.rows[0]?.n ?? 0,
    model_version: mvR.rows[0]?.version ?? 0,
  };

  return {
    tenant_id: tenantId,
    entity_type: entityType,
    generated_at: new Date().toISOString(),
    scope: { days, from: from.toISOString(), to: to.toISOString() },
    overview: { case_count: traces.length, event_count: rows.length, available_entity_types: available },
    variants,
    bottlenecks,
    throughput,
    conformance,
    resonance,
  };
}
