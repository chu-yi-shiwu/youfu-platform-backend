// 工作台“我的任务”统计：维修 / 巡检 / 运送 / 能耗四类统一口径。
//
// 这里不能只查 work_orders：移动端“我的任务”已经把四类任务合并展示，
// 工作台如果只统计维修，就会出现“任务列表有巡检/运送/能耗，工作台却看不见”的假统计。
//
// 状态口径（与 themes.ts / 各业务页面保持一致）：
//   - 维修：workflow_def 动态状态集，由调用方传入 active/success/terminal
//   - 巡检：pending/in_progress 活跃；done 成功；done/exception/cancelled 终态
//   - 运送：pending/assigned/transporting 活跃；done 成功；done/exception/cancelled 终态
//   - 能耗：created/dispatched/in_progress 活跃；submitted/reviewed/archived 成功；
//           submitted/reviewed/archived/cancelled 终态
//
// “今日”边界显式使用 Asia/Shanghai 本地日，不依赖数据库默认时区。
// “今日完成”只认成功完成态，并把完成时间固定在业务完成字段上：
//   工单 completed_at/rated_at/updated_at、巡检 done_at、运送 sign_at/arrive_at/updated_at、
//   能耗 data.submitted_at/updated_at。这样后续评价、复核、归档只改 updated_at 时，
//   不会把前几天的完成重新算进今天。
import type { PoolClient } from 'pg';

export const INSPECTION_ACTIVE_STATUSES = ['pending', 'in_progress'] as const;
export const INSPECTION_SUCCESS_STATUSES = ['done'] as const;
export const INSPECTION_TERMINAL_STATUSES = ['done', 'exception', 'cancelled'] as const;

export const TRANSPORT_ACTIVE_STATUSES = ['pending', 'assigned', 'transporting'] as const;
export const TRANSPORT_SUCCESS_STATUSES = ['done'] as const;
export const TRANSPORT_TERMINAL_STATUSES = ['done', 'exception', 'cancelled'] as const;

export const ENERGY_ACTIVE_STATUSES = ['created', 'dispatched', 'in_progress'] as const;
export const ENERGY_SUCCESS_STATUSES = ['submitted', 'reviewed', 'archived'] as const;
export const ENERGY_TERMINAL_STATUSES = ['submitted', 'reviewed', 'archived', 'cancelled'] as const;

export interface MeStatsCounts {
  active_count: number;
  done_count: number;
  today_done: number;
  today_new: number;
}

export type MeTaskType = 'work_order' | 'inspection_task' | 'transport_task' | 'energy_task';

export interface MeTaskStats {
  total: MeStatsCounts;
  by_type: Record<MeTaskType, MeStatsCounts>;
}

export interface WorkOrderStatusSets {
  active: string[];
  success: string[];
  terminal: string[];
}

const EMPTY_COUNTS: MeStatsCounts = Object.freeze({
  active_count: 0,
  done_count: 0,
  today_done: 0,
  today_new: 0,
});

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

export function normalizeCounts(row: Record<string, unknown> | undefined | null): MeStatsCounts {
  return {
    active_count: toCount(row?.active_count),
    done_count: toCount(row?.done_count),
    today_done: toCount(row?.today_done),
    today_new: toCount(row?.today_new),
  };
}

function addCounts(a: MeStatsCounts, b: MeStatsCounts): MeStatsCounts {
  return {
    active_count: a.active_count + b.active_count,
    done_count: a.done_count + b.done_count,
    today_done: a.today_done + b.today_done,
    today_new: a.today_new + b.today_new,
  };
}

function countQuery(sql: string, params: unknown[]) {
  return { sql, params };
}

async function runCounts(
  client: PoolClient,
  sql: string,
  params: unknown[],
): Promise<MeStatsCounts> {
  const q = countQuery(sql, params);
  const r = await client.query(q.sql, q.params);
  return normalizeCounts(r.rows[0] as Record<string, unknown> | undefined);
}

const WORK_ORDER_STATS_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE status = ANY($3::text[]))::int AS active_count,
    COUNT(*) FILTER (WHERE status = ANY($5::text[]))::int AS done_count,
    COUNT(*) FILTER (
      WHERE status = ANY($4::text[])
        AND COALESCE(completed_at, rated_at, updated_at) IS NOT NULL
        AND (COALESCE(completed_at, rated_at, updated_at) AT TIME ZONE 'Asia/Shanghai')::date
          = (now() AT TIME ZONE 'Asia/Shanghai')::date
    )::int AS today_done,
    COUNT(*) FILTER (
      WHERE (created_at AT TIME ZONE 'Asia/Shanghai')::date
        = (now() AT TIME ZONE 'Asia/Shanghai')::date
    )::int AS today_new
  FROM work_orders
  WHERE tenant_id = $1 AND assignee_id = $2`;

const INSPECTION_STATS_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE status = ANY($3::text[]))::int AS active_count,
    COUNT(*) FILTER (WHERE status = ANY($5::text[]))::int AS done_count,
    COUNT(*) FILTER (
      WHERE status = ANY($4::text[])
        AND done_at IS NOT NULL
        AND (done_at AT TIME ZONE 'Asia/Shanghai')::date
          = (now() AT TIME ZONE 'Asia/Shanghai')::date
    )::int AS today_done,
    COUNT(*) FILTER (
      WHERE (created_at AT TIME ZONE 'Asia/Shanghai')::date
        = (now() AT TIME ZONE 'Asia/Shanghai')::date
    )::int AS today_new
  FROM inspection_task
  WHERE tenant_id = $1 AND assignee = $2`;

const TRANSPORT_STATS_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE status = ANY($3::text[]))::int AS active_count,
    COUNT(*) FILTER (WHERE status = ANY($5::text[]))::int AS done_count,
    COUNT(*) FILTER (
      WHERE status = ANY($4::text[])
        AND COALESCE(sign_at, arrive_at, updated_at) IS NOT NULL
        AND (COALESCE(sign_at, arrive_at, updated_at) AT TIME ZONE 'Asia/Shanghai')::date
          = (now() AT TIME ZONE 'Asia/Shanghai')::date
    )::int AS today_done,
    COUNT(*) FILTER (
      WHERE (created_at AT TIME ZONE 'Asia/Shanghai')::date
        = (now() AT TIME ZONE 'Asia/Shanghai')::date
    )::int AS today_new
  FROM transport_order
  WHERE tenant_id = $1 AND carrier = $2`;

// 能耗任务由能源平台写入 business_flow_tasks，worker 归属以 data.worker_ref 为主、assignee 兜底。
// data.submitted_at 是平台回传的真实提交时间；只有缺失时才回退 updated_at。
const ENERGY_STATS_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE status = ANY($4::text[]))::int AS active_count,
    COUNT(*) FILTER (WHERE status = ANY($6::text[]))::int AS done_count,
    COUNT(*) FILTER (
      WHERE status = ANY($5::text[])
        AND COALESCE(public.youfu_safe_timestamptz(data->>'submitted_at'), updated_at) IS NOT NULL
        AND (COALESCE(public.youfu_safe_timestamptz(data->>'submitted_at'), updated_at) AT TIME ZONE 'Asia/Shanghai')::date
          = (now() AT TIME ZONE 'Asia/Shanghai')::date
    )::int AS today_done,
    COUNT(*) FILTER (
      WHERE (created_at AT TIME ZONE 'Asia/Shanghai')::date
        = (now() AT TIME ZONE 'Asia/Shanghai')::date
    )::int AS today_new
  FROM business_flow_tasks
  WHERE tenant_id = $1
    AND entity_type = 'energy_collection'
    AND (data->>'worker_ref' = $2 OR assignee = $3)`;

/**
 * 一次查询四张表并按任务类型汇总。查询保持顺序执行，全部复用同一个租户事务连接，
 * 避免为了并行而绕过 withTenantClient 的 RLS 上下文。
 */
export async function fetchMeTaskStats(
  client: PoolClient,
  tenantId: string,
  workerId: string,
  workOrder: WorkOrderStatusSets,
): Promise<MeTaskStats> {
  const by_type: Record<MeTaskType, MeStatsCounts> = {
    work_order: EMPTY_COUNTS,
    inspection_task: EMPTY_COUNTS,
    transport_task: EMPTY_COUNTS,
    energy_task: EMPTY_COUNTS,
  };

  by_type.work_order = await runCounts(client, WORK_ORDER_STATS_SQL, [
    tenantId,
    workerId,
    workOrder.active,
    workOrder.success,
    workOrder.terminal,
  ]);

  by_type.inspection_task = await runCounts(client, INSPECTION_STATS_SQL, [
    tenantId,
    workerId,
    [...INSPECTION_ACTIVE_STATUSES],
    [...INSPECTION_SUCCESS_STATUSES],
    [...INSPECTION_TERMINAL_STATUSES],
  ]);

  by_type.transport_task = await runCounts(client, TRANSPORT_STATS_SQL, [
    tenantId,
    workerId,
    [...TRANSPORT_ACTIVE_STATUSES],
    [...TRANSPORT_SUCCESS_STATUSES],
    [...TRANSPORT_TERMINAL_STATUSES],
  ]);

  by_type.energy_task = await runCounts(client, ENERGY_STATS_SQL, [
    tenantId,
    `youfu:${workerId}`,
    workerId,
    [...ENERGY_ACTIVE_STATUSES],
    [...ENERGY_SUCCESS_STATUSES],
    [...ENERGY_TERMINAL_STATUSES],
  ]);

  const total = Object.values(by_type).reduce(addCounts, { ...EMPTY_COUNTS });
  return { total, by_type };
}
