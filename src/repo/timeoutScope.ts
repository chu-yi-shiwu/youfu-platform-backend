import type { PoolClient } from 'pg';
import { getDefEntriesAcrossAllVersions } from '../engine/workflowDef.js';
import { DEFAULT_WORK_ORDER_DEF, doneStates, terminalStates } from '../engine/stateMachine.js';

/**
 * 统一的「超时且未进入完成/终态」SQL 条件。
 *
 * 为什么必须共享：工单可存在多个 workflow_def 版本，终态集合随 def_version 不同。
 * 工作台列表、超时 KPI、超时预警必须按每行 def_version 取自己的终态集合，否则
 * `/stats/workbench.timeout` 与 `/stats/overdue.overdue_total` 会给出两个数。
 *
 * 调用方传入自己的 params 数组；本函数会按顺序追加版本/终态参数并返回可直接拼进
 * WHERE 的条件片段（默认别名 wo，可指定 t）。
 */
export async function appendTimeoutExclusion(
  client: PoolClient,
  tenantId: string,
  params: unknown[],
  alias = 'wo',
): Promise<string> {
  const entries = await getDefEntriesAcrossAllVersions(
    client,
    tenantId,
    'work_order',
    'work_orders',
    DEFAULT_WORK_ORDER_DEF,
  );
  const whens: string[] = [];
  for (const { version, def } of entries) {
    const terminals = Array.from(new Set<string>([...doneStates(def), ...terminalStates(def)]));
    params.push(version);
    const vIdx = params.length;
    params.push(terminals);
    whens.push(`WHEN $${vIdx} THEN $${params.length}::text[]`);
  }
  const exclude = whens.length
    ? `CASE ${alias}.def_version ${whens.join(' ')} ELSE '{}'::text[] END`
    : `'{}'::text[]`;
  return `${alias}.sla_due_at IS NOT NULL AND ${alias}.sla_due_at < now() AND ${alias}.status <> ALL(${exclude})`;
}
