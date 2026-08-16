// ⑦P0 过程挖掘看板 —— 数据层（飞轮"眼睛"）。
// 消费统一事件总线 domain_event（020），按 entity_id 回放事件时序，
// 产出：流程变体(variant)发现、瓶颈时长、吞吐、合规偏离（主导路径依从）。
// 全程只读、全 $1 参数化（满足发布闸门 SQL 注入扫描）；不新增任何迁移。
// 纯函数与 PG 查询分离，便于单测（模仿 repo/stats.ts 的 calc* 纯函数模式）。
import type { PoolClient } from 'pg';

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
  note: string;
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

/** 合规偏离（P0 近似）：以"主导路径依从"衡量；不编造精确状态机合规。 */
export function computeConformance(variants: Variant[]): Conformance {
  if (variants.length === 0) {
    return {
      happy_path: [],
      deviation_rate: 0,
      deviating_variants: [],
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
    note: `主导路径(${happy.seq.join('→')}) 占比 ${((happy.share ?? 0) * 100).toFixed(1)}%；偏离率=1-主导占比。注：P0 以"主导路径依从"近似合规，精确状态机合规(ticket_event↔workflow_def)为后续增强。`,
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
  const conformance = computeConformance(variants);

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
  };
}
