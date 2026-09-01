// services/k2Shadow.ts —— K2 影子模式（R34 · 智能体兑现三步②）
// ─────────────────────────────────────────────────────────────────────────────
// 定位：K2 语义检索以「只读建议」进主链路——绝不参与业务决策（不回写工单
// 字段、不改变流转、不自动派单）。唯一目的：积累「K2 建议 vs 人工实际」
// 配对数据，量化评估 MODEL_AUTO_TUNE 开启条件（DMR：先数据后模型）。
//
// 两条影子：
//   category 影子：建单嵌入成功时，同一向量检索相似历史单 → category 多数票
//                 → 与工单最终分类立即对比（matched 可当场判定）。
//   dispatch 影子：相似单的 assignee 多数票 → 派单/改派发生时回填 actual。
//
// 诚实边界：所有函数 best-effort，异常仅告警，绝不影响主链路（建单/流转）。
// ─────────────────────────────────────────────────────────────────────────────

import type { PoolClient } from 'pg';

/** 余弦相似度；长度不等视为不可比（返回 NaN，由调用方过滤）。 */
export function cosineSim(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return NaN;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return NaN;
  return dot / Math.sqrt(na * nb);
}

// 与 K2 检索护栏同量级：候选拉取上限，防大租户全表载入内存。
const CANDIDATE_LIMIT = 500;
const TOP_K = 3;

export interface ShadowCandidate {
  refId: string;
  category: string;
  sim: number;
}

/** 多数投票（平票取首个达到最高票的键，遍历顺序稳定 → 结果可复现）。 */
export function majorityVote(votes: string[]): string {
  const tally = new Map<string, number>();
  for (const v of votes) if (v) tally.set(v, (tally.get(v) ?? 0) + 1);
  let best = '';
  let bestN = 0;
  for (const [k, n] of tally) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

/**
 * 建单嵌入成功后调用（ticket.ts 异步 best-effort 块内）：
 * 同一向量检索相似历史单 → 落 category（当场判 matched）+ dispatch（待回填）两条影子行。
 * @param finalCategory 工单最终分类口径（与嵌入表 category 同源：businessType || catalog）
 */
export async function recordShadowSuggestions(
  client: PoolClient,
  tenantId: string,
  workOrderId: string,
  vec: number[],
  finalCategory: string,
): Promise<void> {
  // R12-F1 数据稀疏修正：LEFT JOIN work_orders 带出 assignee_id——
  // dispatch 投票只在「有派单记录」的候选内进行（R15 live 诊断：全量候选中大量
  // draft/无 assignee 单稀释 TOP-K 投票，导致 dispatch 影子行几乎不落）。
  const cand = await client.query<{ ref_id: string; category: string; embedding: number[]; assignee_id: string | null }>(
    `SELECT e.ref_id, e.category, e.embedding, w.assignee_id
     FROM ai_case_embeddings e
     LEFT JOIN work_orders w ON w.tenant_id = e.tenant_id AND w.id::text = e.ref_id
     WHERE e.tenant_id = $1 AND e.ref_type = 'work_order' AND e.ref_id <> $2
     LIMIT ${CANDIDATE_LIMIT}`,
    [tenantId, String(workOrderId)],
  );
  const scored: (ShadowCandidate & { assigneeId: string | null })[] = cand.rows
    .map((r) => ({ refId: String(r.ref_id), category: r.category || '', sim: cosineSim(vec, r.embedding), assigneeId: r.assignee_id }))
    .filter((r) => Number.isFinite(r.sim) && r.sim > 0)
    .sort((a, b) => b.sim - a.sim);
  if (scored.length === 0) return;

  // ① category 影子：相似单多数票 vs 工单最终分类（当场可判）
  const catVote = majorityVote(scored.slice(0, TOP_K).map((s) => s.category));
  if (catVote) {
    await client.query(
      `INSERT INTO ai_shadow_suggestions (tenant_id, work_order_id, kind, suggested, actual, matched, detail)
       VALUES ($1, $2, 'category', $3, $4, $5, $6)`,
      [
        tenantId,
        String(workOrderId),
        catVote,
        finalCategory || null,
        finalCategory ? catVote === finalCategory : null,
        JSON.stringify({ top_k: scored.slice(0, TOP_K).map(({ assigneeId: _a, ...rest }) => rest), vec_dims: vec.length }),
      ],
    );
  }

  // ② dispatch 影子：在有 assignee 的候选中取相似度 TOP_K 多数票（actual 留空，派单时回填）
  const withAsg = scored.filter((s) => s.assigneeId).slice(0, TOP_K);
  const workerVote = majorityVote(withAsg.map((s) => s.assigneeId || ''));
  if (workerVote) {
    await client.query(
      `INSERT INTO ai_shadow_suggestions (tenant_id, work_order_id, kind, suggested, detail)
       VALUES ($1, $2, 'dispatch', $3, $4)`,
      [tenantId, String(workOrderId), workerVote, JSON.stringify({ top_k: withAsg.map(({ assigneeId, ...rest }) => ({ ...rest, has_assignee: !!assigneeId })) })],
    );
  }

  // R12-F1 补强（自愈回填）：建单自动派单（同步）先于本函数（嵌入异步后）执行，
  // 派单路径的 resolveDispatchShadow 会扑空于「影子行尚未 INSERT」的时序竞态。
  // 故此处补查工单当前 assignee：已有则立即回填 actual，确定性消除竞态。
  if (workerVote) {
    try {
      const cur = await client.query<{ assignee_id: string | null }>(
        'SELECT assignee_id FROM work_orders WHERE tenant_id = $1 AND id = $2',
        [tenantId, String(workOrderId)],
      );
      const actual = cur.rows[0]?.assignee_id;
      if (actual) await resolveDispatchShadow(client, tenantId, String(workOrderId), actual);
    } catch (e) {
      console.warn('[shadow self-heal] fail:', (e as Error).message);
    }
  }
}

/**
 * 派单/改派发生时回填 dispatch 影子（ticket.ts transition 内调用）。
 * 旁路自我隔离：内部吞错仅告警——影子失败绝不允许炸主流转事务。
 */
export async function resolveDispatchShadow(
  client: PoolClient,
  tenantId: string,
  workOrderId: string,
  actualWorkerId: string,
): Promise<void> {
  try {
    await client.query(
      `UPDATE ai_shadow_suggestions
       SET actual = $3, matched = (suggested = $3), resolved_at = now()
       WHERE tenant_id = $1 AND work_order_id = $2 AND kind = 'dispatch' AND resolved_at IS NULL`,
      [tenantId, String(workOrderId), actualWorkerId],
    );
  } catch (e) {
    console.warn('[shadow resolve] fail:', (e as Error).message);
  }
}
