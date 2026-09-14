// workflow_def_change 仓储（流程配置「提交→审核」一期，2026-09-12 设计 §3/§5）：
// 每租户每业务流至多一条在途变更（UNIQUE(tenant_id, entity_type) 兜底）。
// 状态机：draft → submitted → live（approve 写 live 边）/ submitted → draft（驳回）。
// live 写边五条（V3-D5 收敛后的事实枚举，原「approve 唯一」已不准确）：
//   approve / rollback（人工，把关人裁量）/ template / auto-tune（系统，operator+reason 强制留痕）/ provision（开通注入）。
// live 表（workflow_def）零改动——读路径零风险；approve 成功后删除本行
// （审计由 workflow_def_history 快照 reason='approve' 承担）。
// V3-D6（2026-09-14）：加 rev 修订号乐观锁——rev 只随内容保存递增（提交/驳回不改），
// 命名刻意避开 base_version（那是 live 锚语义）；baseRev 未传 = 无条件覆盖（FE/mp 零破坏）。
import type { PoolClient } from 'pg';
import { AppError } from '../middleware/error.js';
import type { WorkflowDef } from './stateMachine.js';

/** 在途变更行（snake_case DB 行 → camelCase 视图；def 为解析后的对象）。 */
export interface WorkflowDefChange {
  id: number;
  entityType: string;
  def: WorkflowDef;
  note: string | null;
  status: 'draft' | 'submitted';
  baseVersion: number;
  /** V3-D6：草稿自身修订号（随每次保存 +1；提交/驳回不变）。 */
  rev: number;
  createdBy: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  rejectComment: string | null;
  updatedAt: string;
}

function mapChange(row: any): WorkflowDefChange {
  const raw = row.def;
  return {
    id: row.id,
    entityType: row.entity_type,
    def: (typeof raw === 'string' ? JSON.parse(raw) : raw) as WorkflowDef,
    note: row.note ?? null,
    status: row.status,
    baseVersion: row.base_version,
    rev: Number(row.rev ?? 1),
    createdBy: row.created_by ?? null,
    submittedBy: row.submitted_by ?? null,
    submittedAt: row.submitted_at ?? null,
    rejectComment: row.reject_comment ?? null,
    updatedAt: row.updated_at,
  };
}

/** 当前 live 版本（无定义 0，与 getWorkflowDefVersion 同口径）——draft 占位与 submit 锚点共用。 */
async function liveVersion(client: PoolClient, tenantId: string, entityType: string): Promise<number> {
  const r = await client.query<{ version: number }>(
    'SELECT version FROM workflow_def WHERE tenant_id = $1 AND entity_type = $2',
    [tenantId, entityType],
  );
  return r.rows[0]?.version ?? 0;
}

/**
 * 保存/覆盖草稿（upsert，status 恒回 draft）。
 * - base_version 先占位为当前 live 版本，submit 时以提交时刻为准覆写（防脏写锚点在提交侧）；
 * - 覆盖被驳回的草稿时保留 reject_comment（提交人修改时可继续看到驳回意见）；
 * - 对已 submitted 的行执行本函数 = 撤回改稿（status 回 draft），语义与「保存/覆盖草稿」一致。
 * - V3-D6：opts.baseRev 已传 → 原子条件 upsert（WHERE rev = baseRev，无 TOCTOU）；
 *   0 行返回（他人已先保存）→ 409 DRAFT_REV_CONFLICT；未传 → 无条件覆盖（与旧行为一致，零破坏）。
 *   返回 { rev }（新修订号）。
 */
export async function upsertWorkflowDefDraft(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  def: WorkflowDef,
  opts?: { operator?: string; note?: string; baseRev?: number },
): Promise<{ rev: number }> {
  const baseVersion = await liveVersion(client, tenantId, entityType);
  const baseParams = [tenantId, entityType, JSON.stringify(def), opts?.note ?? null, baseVersion, opts?.operator ?? null];
  const useLock = typeof opts?.baseRev === 'number';
  const sql = useLock
    ? `INSERT INTO workflow_def_change (tenant_id, entity_type, def, note, status, base_version, created_by, rev)
       VALUES ($1,$2,$3,$4,'draft',$5,$6,1)
       ON CONFLICT (tenant_id, entity_type) DO UPDATE
         SET def = EXCLUDED.def, note = EXCLUDED.note, status = 'draft',
             base_version = EXCLUDED.base_version, created_by = EXCLUDED.created_by,
             rev = workflow_def_change.rev + 1, updated_at = now()
       WHERE workflow_def_change.rev = $7
       RETURNING rev`
    : `INSERT INTO workflow_def_change (tenant_id, entity_type, def, note, status, base_version, created_by, rev)
       VALUES ($1,$2,$3,$4,'draft',$5,$6,1)
       ON CONFLICT (tenant_id, entity_type) DO UPDATE
         SET def = EXCLUDED.def, note = EXCLUDED.note, status = 'draft',
             base_version = EXCLUDED.base_version, created_by = EXCLUDED.created_by,
             rev = workflow_def_change.rev + 1, updated_at = now()
       RETURNING rev`;
  const r = await client.query<{ rev: number }>(sql, useLock ? [...baseParams, opts!.baseRev] : baseParams);
  if (useLock && r.rows.length === 0) {
    // 条件 WHERE 未命中 = 草稿 rev 已被并发保存推进 → 409（与 DRAFT_STALE/CHANGE_NOT_DRAFT 同族）。
    // 注意：仅 lock 路径以 0 行为冲突信号；无条件路径真实 PG 恒 RETURNING 1 行，
    // mock 环境返回空行时回退 rev=1（真实库不会走到该回退分支）。
    throw new AppError(
      'DRAFT_REV_CONFLICT',
      `草稿已被他人修改（当前 rev != ${opts?.baseRev}），请刷新草稿后重提`,
      409,
    );
  }
  return { rev: Number(r.rows[0]?.rev ?? 1) };
}

/** 读在途变更行；无则 null。 */
export async function getWorkflowDefChange(
  client: PoolClient,
  tenantId: string,
  entityType: string,
): Promise<WorkflowDefChange | null> {
  const r = await client.query(
    'SELECT * FROM workflow_def_change WHERE tenant_id = $1 AND entity_type = $2',
    [tenantId, entityType],
  );
  return r.rows[0] ? mapChange(r.rows[0]) : null;
}

/**
 * 提交审核（draft→submitted）：记录 submitted_by 与提交时刻的 live 版本（防脏写锚点）。
 * 仅 draft 行可提交（submitted 行返回 null，由路由层区分 NO_DRAFT / CHANGE_NOT_DRAFT）。
 */
export async function submitWorkflowDefChange(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  opts: { submittedBy: string },
): Promise<WorkflowDefChange | null> {
  const baseVersion = await liveVersion(client, tenantId, entityType);
  const r = await client.query(
    `UPDATE workflow_def_change
     SET status = 'submitted', submitted_by = $3, submitted_at = now(), base_version = $4, updated_at = now()
     WHERE tenant_id = $1 AND entity_type = $2 AND status = 'draft'
     RETURNING *`,
    [tenantId, entityType, opts.submittedBy, baseVersion],
  );
  return r.rows[0] ? mapChange(r.rows[0]) : null;
}

/** 驳回（submitted→draft）：回填驳回意见，live 不动。仅 submitted 行可驳回（否则 null）。 */
export async function rejectWorkflowDefChange(
  client: PoolClient,
  tenantId: string,
  entityType: string,
  comment: string,
): Promise<WorkflowDefChange | null> {
  const r = await client.query(
    `UPDATE workflow_def_change
     SET status = 'draft', reject_comment = $3, updated_at = now()
     WHERE tenant_id = $1 AND entity_type = $2 AND status = 'submitted'
     RETURNING *`,
    [tenantId, entityType, comment],
  );
  return r.rows[0] ? mapChange(r.rows[0]) : null;
}

/** 本租户全部在审清单（status='submitted'，按提交时间倒序）——GET /pending 数据源。 */
export async function listSubmittedWorkflowDefChanges(
  client: PoolClient,
  tenantId: string,
): Promise<WorkflowDefChange[]> {
  const r = await client.query(
    `SELECT * FROM workflow_def_change WHERE tenant_id = $1 AND status = 'submitted' ORDER BY submitted_at DESC`,
    [tenantId],
  );
  return r.rows.map(mapChange);
}

/** 删除变更行（approve 生效后调用；审计由 workflow_def_history reason='approve' 承担）。 */
export async function deleteWorkflowDefChange(
  client: PoolClient,
  tenantId: string,
  entityType: string,
): Promise<void> {
  await client.query('DELETE FROM workflow_def_change WHERE tenant_id = $1 AND entity_type = $2', [
    tenantId,
    entityType,
  ]);
}
