// 工作台统一统计：列表和统计共用 buildWorkOrderWhere + work_orders RLS。
//
// 口径不变量：
//   sum(buckets) = total
//   timeout = list(timeout=1).total（直接用 list 算，避免第二套谓词）
//   today_new = list(today=1).total
//   bucket 下钻 = list(bucket=...).total（bucket 在路由层转成 status）
import type { PoolClient } from 'pg';
import { list } from './ticket.js';
import { buildWorkOrderWhere, type WorkOrderFilter } from './workOrderWhere.js';
import { getDefsAcrossAllVersions, getWorkflowDef } from '../engine/workflowDef.js';
import {
  DEFAULT_WORK_ORDER_DEF,
  doneStates,
  terminalStates,
  cancelledStates,
  evaluatedStates,
} from '../engine/stateMachine.js';
import {
  resolveWorkbenchBuckets,
  bucketForStatus,
  type WorkbenchBucket,
} from '../engine/workbenchBuckets.js';

export interface WorkbenchFilter extends WorkOrderFilter {
  bucket?: string;
  timeoutOnly?: boolean;
}

export interface WorkbenchStats {
  total: number;
  buckets: Record<WorkbenchBucket, number>;
  bucketStatuses: Record<WorkbenchBucket, string[]>;
  timeout: number;
  today_new: number;
  today_done: number;
  rates: {
    auto_dispatch: number;
    cancellation: number;
    auto_close: number;
    satisfaction_avg: number;
    satisfaction_count: number;
  };
  data_quality: {
    evaluated_missing_score: number;
  };
}

function rate(n: number, d: number): number {
  if (!d) return 0;
  return Number((n / d).toFixed(4));
}

export async function workbenchStats(
  client: PoolClient,
  tenantId: string,
  filter: WorkbenchFilter = {},
): Promise<WorkbenchStats> {
  const liveDef = await getWorkflowDef(client, tenantId, 'work_order');
  const buckets = resolveWorkbenchBuckets(liveDef);

  // bucket → statuses。other 需要按当前 scope 的实际 distinct status 反推，不能前端猜。
  let effectiveFilter: WorkbenchFilter = { ...filter };
  if (filter.bucket) {
    const bucket = filter.bucket as WorkbenchBucket;
    if (bucket === 'other') {
      const base = buildWorkOrderWhere(tenantId, { ...filter, status: undefined });
      const r = await client.query<{ status: string }>(
        `SELECT DISTINCT status FROM work_orders wo WHERE ${base.conds.join(' AND ')}`,
        base.params,
      );
      const union = new Set<string>();
      for (const key of ['pending', 'hall', 'active', 'done', 'cancelled'] as const) {
        for (const s of buckets[key]) union.add(s);
      }
      const other = r.rows.map((x) => x.status).filter((s) => !union.has(s));
      effectiveFilter = { ...filter, status: other.join(',') };
    } else {
      effectiveFilter = { ...filter, status: (buckets[bucket] ?? []).join(',') };
    }
  }

  const { conds, params } = buildWorkOrderWhere(tenantId, effectiveFilter);
  const where = conds.join(' AND ');
  const byStatus = await client.query<{ status: string; c: string }>(
    `SELECT status, COUNT(*)::text AS c FROM work_orders wo WHERE ${where} GROUP BY status`,
    params,
  );

  const counts: Record<WorkbenchBucket, number> = {
    pending: 0, hall: 0, active: 0, done: 0, cancelled: 0, other: 0,
  };
  const bucketStatuses: Record<WorkbenchBucket, string[]> = {
    pending: [...buckets.pending],
    hall: [...buckets.hall],
    active: [...buckets.active],
    done: [...buckets.done],
    cancelled: [...buckets.cancelled],
    other: [],
  };
  let total = 0;
  for (const row of byStatus.rows) {
    const n = Number(row.c) || 0;
    total += n;
    const b = bucketForStatus(row.status, buckets);
    counts[b] += n;
    if (b === 'other' && !bucketStatuses.other.includes(row.status)) {
      bucketStatuses.other.push(row.status);
    }
  }

  // 超时/今日：直接复用 list 的同一 WHERE，避免第二套口径。
  const timeoutFilter: WorkbenchFilter = { ...filter, status: undefined, bucket: undefined, timeoutOnly: true };
  const timeoutRes = await list(client, tenantId, { ...timeoutFilter, limit: 1, offset: 0 } as never);
  const todayFilter: WorkbenchFilter = { ...filter, status: undefined, bucket: undefined, todayOnly: true };
  const todayRes = await list(client, tenantId, { ...todayFilter, limit: 1, offset: 0 } as never);

  const defs = await getDefsAcrossAllVersions(client, tenantId, 'work_order', 'work_orders', DEFAULT_WORK_ORDER_DEF);
  const done = Array.from(new Set(defs.flatMap((d) => [...doneStates(d), ...terminalStates(d)])));
  const doneOnly = Array.from(new Set(defs.flatMap((d) => [...doneStates(d)])));
  const cancelled = Array.from(new Set(defs.flatMap((d) => cancelledStates(d))));
  const evaluated = Array.from(new Set(defs.flatMap((d) => evaluatedStates(d))));

  const agg = await client.query<{
    total: string;
    cancelled: string;
    auto_dispatched: string;
    auto_closed: string;
    today_done: string;
    satisfaction_avg: string | null;
    satisfaction_count: string;
  }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE status = ANY($${params.length + 1}::text[]))::text AS cancelled,
       COUNT(*) FILTER (WHERE auto_flow = true)::text AS auto_dispatched,
       COUNT(*) FILTER (WHERE auto_flow = true AND status = ANY($${params.length + 2}::text[]))::text AS auto_closed,
       COUNT(*) FILTER (WHERE completed_at::date = CURRENT_DATE AND status = ANY($${params.length + 3}::text[]))::text AS today_done,
       AVG(satisfaction_score)::text AS satisfaction_avg,
       COUNT(satisfaction_score)::text AS satisfaction_count
     FROM work_orders wo
     WHERE ${where}`,
    [...params, cancelled, done, doneOnly],
  );
  const a = agg.rows[0];
  const aggTotal = Number(a?.total ?? 0);
  const cancelledN = Number(a?.cancelled ?? 0);
  const autoDispatched = Number(a?.auto_dispatched ?? 0);
  const autoClosed = Number(a?.auto_closed ?? 0);
  const satisfactionCount = Number(a?.satisfaction_count ?? 0);
  const satisfactionAvg = a?.satisfaction_avg != null ? Number(a.satisfaction_avg) : 0;

  // 数据质量：已评价但没分数（不补 0，不伪装）。
  const qBase = buildWorkOrderWhere(tenantId, { ...filter, status: undefined, bucket: undefined } as WorkOrderFilter);
  const qRows = await client.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM work_orders wo
      WHERE ${qBase.conds.join(' AND ')}
        AND status = ANY($${qBase.params.length + 1}::text[])
        AND satisfaction_score IS NULL`,
    [...qBase.params, evaluated],
  );

  return {
    total,
    buckets: counts,
    bucketStatuses,
    timeout: timeoutRes.total,
    today_new: todayRes.total,
    today_done: Number(a?.today_done ?? 0),
    rates: {
      auto_dispatch: rate(autoDispatched, aggTotal),
      cancellation: rate(cancelledN, aggTotal),
      auto_close: rate(autoClosed, aggTotal),
      satisfaction_avg: satisfactionAvg,
      satisfaction_count: satisfactionCount,
    },
    data_quality: {
      evaluated_missing_score: Number(qRows.rows[0]?.c ?? 0),
    },
  };
}
