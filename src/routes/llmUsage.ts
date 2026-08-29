// K1 成本/审计查看端点：GET /api/v1/llm/usage
// 仅 admin 可看；汇总本租户（含 system 级）LLM 网关调用的 tokens / 成本 / 成功率。
import { Router } from 'express';
import { withTenantClient } from '../db/pool.js';

const router = Router();

router.get('/usage', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    if (auth.role !== 'admin') {
      return res.status(403).json({ ok: false, code: 'FORBIDDEN', message: '需要管理员权限' });
    }
    const rows = await withTenantClient(auth.tenantId, async (client) => {
      const r = await client.query(
        `SELECT provider, model,
                COUNT(*)                                  AS calls,
                SUM(prompt_tokens)                       AS prompt_tokens,
                SUM(completion_tokens)                   AS completion_tokens,
                COALESCE(SUM(cost_usd), 0)               AS cost_usd,
                SUM(latency_ms)                          AS latency_ms,
                SUM(CASE WHEN ok THEN 0 ELSE 1 END)      AS failures
         FROM llm_call_log
         WHERE tenant_id = $1 OR tenant_id = 'system'
         GROUP BY provider, model
         ORDER BY cost_usd DESC NULLS LAST`,
        [auth.tenantId],
      );
      return r.rows;
    });
    return res.json({ ok: true, code: 0, rows });
  } catch (e) {
    next(e);
  }
});

export default router;
