// E2 效果回写服务：应用模板 7/30 天后自动拉取 after 指标并评分（V3 双轮飞轮闭环）。
// R7 诚实：样本 ≥30 单且 before 指标存在才评 effect_rating，否则标 null。
import pool from '../db/pool.js';
import { withTenantClient } from '../db/pool.js';

/** 刷新单条 apply 的 after 指标 + 效果评分（幂等，可重复调用）。 */
export async function refreshApplyEffect(applyId: string): Promise<{ refreshed: boolean; effect_rating: number | null; note: string }> {
  const ap = await pool.query(`SELECT * FROM platform_template_apply WHERE id = $1`, [applyId]);
  if (ap.rowCount === 0) return { refreshed: false, effect_rating: null, note: 'apply record not found' };
  const row = ap.rows[0];
  const m = await withTenantClient(row.tenant_id, async (client) =>
    client.query(
      `SELECT
         count(*) FILTER (WHERE status IN ('completed','closed','evaluated'))::numeric / nullif(count(*),0) AS close_rate,
         count(*) FILTER (WHERE status NOT IN ('completed','closed','evaluated','cancelled')
           AND sla_due_at IS NOT NULL AND sla_due_at < now())::numeric / nullif(count(*),0) AS overdue_rate,
         count(*) AS total
       FROM work_orders WHERE tenant_id = $1`,
      [row.tenant_id],
    ).then((r) => r.rows[0]),
  );
  const after = { close_rate: m?.close_rate ?? null, overdue_rate: m?.overdue_rate ?? null, total: Number(m?.total ?? 0) };
  let effect: number | null = null;
  const before = row.before_metrics && typeof row.before_metrics === 'object' ? row.before_metrics : {};
  if (after.total >= 30 && after.close_rate !== null && before.close_rate !== null) {
    effect = Number((after.close_rate - Number(before.close_rate)).toFixed(4));
  }
  await pool.query(
    `UPDATE platform_template_apply SET after_metrics = $1, effect_rating = $2 WHERE id = $3`,
    [JSON.stringify(after), effect, applyId],
  );
  const note = effect === null ? '样本不足 30 单或指标缺失，暂不评分（R7 诚实）' : `闭环率变化 ${effect >= 0 ? '+' : ''}${effect}`;
  return { refreshed: true, effect_rating: effect, note };
}

/** 扫描到期未回写的 apply（applied_at ≥7 天且未回写）并逐条刷新；返回处理条数。 */
export async function runDueEffectRefreshes(): Promise<number> {
  // 未回写 = after_metrics 为空对象 或 effect_rating 为 null（且应用已满 7 天）
  const r = await pool.query(
    `SELECT id FROM platform_template_apply
     WHERE status = 'applied'
       AND applied_at <= now() - interval '7 days'
       AND (after_metrics = '{}'::jsonb OR effect_rating IS NULL)
     ORDER BY applied_at ASC
     LIMIT 20`,
  );
  let done = 0;
  for (const row of r.rows) {
    try {
      const res = await refreshApplyEffect(row.id);
      if (res.refreshed) done++;
    } catch (e) {
      // 单条失败不阻断批量（记录后继续）
      console.error('[template-effects] refresh failed:', row.id, e instanceof Error ? e.message : String(e));
    }
  }
  return done;
}
