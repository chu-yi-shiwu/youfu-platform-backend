// 工作台状态桶（单一事实源）。
//
// 不从前端 PENDING/ACTIVE/DONE 硬编码推导：activeStates 的语义是“非完成/非终态/非挂起”，
// 推不出业务要的“待处理/进行中”。这里显式声明，并允许 workflow_def.config.workbenchBuckets 覆盖。
import type { WorkflowDef } from './stateMachine.js';

export type WorkbenchBucket = 'pending' | 'hall' | 'active' | 'done' | 'cancelled' | 'other';

export type WorkbenchBucketMap = Record<Exclude<WorkbenchBucket, 'other'>, string[]>;

export const DEFAULT_WORKBENCH_BUCKETS: WorkbenchBucketMap = {
  pending: ['draft', 'created', 'pending_dispatch', 'assigned'],
  hall: ['claim_hall'],
  active: [
    'arrived', 'processing', 'paused', 'suspended',
    'pending_review', 'review_passed',
    'transporting', 'accompanying', 'auditing', 'review',
  ],
  done: ['completed', 'closed', 'evaluated', 'done'],
  cancelled: ['cancelled'],
};

function cleanList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return Array.from(new Set(v.filter((x): x is string => typeof x === 'string' && x.length > 0)));
}

/**
 * 取状态桶映射：
 *   - workflow_def.config.workbenchBuckets 优先（显式配置）；
 *   - 未配置时用内置默认桶；
 *   - 同一状态出现在多个桶时，按 pending→hall→active→done→cancelled 先到先得，
 *     后续桶自动去掉，保证 sum(buckets)=total。
 */
export function resolveWorkbenchBuckets(def?: WorkflowDef | null): WorkbenchBucketMap {
  const cfg = (def?.config as Record<string, unknown> | undefined)?.workbenchBuckets as
    | Record<string, unknown>
    | undefined;
  const source = cfg && typeof cfg === 'object' ? cfg : {};
  const raw: WorkbenchBucketMap = {
    pending: cleanList(source.pending) .length ? cleanList(source.pending) : DEFAULT_WORKBENCH_BUCKETS.pending,
    hall: cleanList(source.hall).length ? cleanList(source.hall) : DEFAULT_WORKBENCH_BUCKETS.hall,
    active: cleanList(source.active).length ? cleanList(source.active) : DEFAULT_WORKBENCH_BUCKETS.active,
    done: cleanList(source.done).length ? cleanList(source.done) : DEFAULT_WORKBENCH_BUCKETS.done,
    cancelled: cleanList(source.cancelled).length ? cleanList(source.cancelled) : DEFAULT_WORKBENCH_BUCKETS.cancelled,
  };

  const seen = new Set<string>();
  const out: WorkbenchBucketMap = { pending: [], hall: [], active: [], done: [], cancelled: [] };
  for (const key of ['pending', 'hall', 'active', 'done', 'cancelled'] as const) {
    for (const status of raw[key]) {
      if (seen.has(status)) continue;
      seen.add(status);
      out[key].push(status);
    }
  }
  return out;
}

export function bucketForStatus(status: string, buckets: WorkbenchBucketMap): WorkbenchBucket {
  for (const key of ['pending', 'hall', 'active', 'done', 'cancelled'] as const) {
    if (buckets[key].includes(status)) return key;
  }
  return 'other';
}
