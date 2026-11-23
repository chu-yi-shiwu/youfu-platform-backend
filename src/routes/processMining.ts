// ⑦P0 过程挖掘看板 —— API 路由（飞轮"眼睛"数据接口）。
// GET /api/v1/process-mining?entityType=work_order&days=30&limit=50000
// 复用 withTenantClient（SET LOCAL app.tenant_id + SET LOCAL ROLE youfu_app → RLS 生效）。
import { Router } from 'express';
import type { PoolClient } from 'pg';
import { withTenantClient } from '../db/pool.js';

// 过程挖掘走 dash cookie 同域导航，不在 JWT authMiddleware 内；显式 system scope。
function withSystemTenantClient<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTenantClient(tenantId, fn, { system: true });
}
import { processMining } from '../repo/processMining.js';
import { parseDepartmentScope } from './departmentScope.js';

const router = Router();

router.get('/process-mining', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const entityType = typeof req.query.entityType === 'string' ? req.query.entityType : undefined;
    const { departmentId, departmentUnassigned } = parseDepartmentScope(req.query);
    // 部门过滤只对 work_order 有语义；其他实体没有 department_id，必须显式拒绝而不是静默忽略。
    if ((departmentId || departmentUnassigned) && (entityType ?? 'work_order') !== 'work_order') {
      return res.status(400).json({
        ok: false,
        code: 'BAD_PARAM',
        message: 'department filters only support entityType=work_order',
      });
    }
    const days = typeof req.query.days === 'string' ? Number(req.query.days) : undefined;
    // P-3：limit 强制上限（默认由 repo 取 50000 用于挖掘；显式传参封顶 200000，防滥用）。
    const limit = typeof req.query.limit === 'string' ? Math.min(Math.max(1, Number(req.query.limit)), 200000) : undefined;
    // 优化（自我测试后加固）：非有限数值（如 days=abc）→ 明确 400，避免 NaN 静默返回空结果。
    if (req.query.days !== undefined && !Number.isFinite(days)) {
      return res.status(400).json({ ok: false, code: 'BAD_PARAM', message: 'days must be a finite number' });
    }
    if (req.query.limit !== undefined && !Number.isFinite(limit)) {
      return res.status(400).json({ ok: false, code: 'BAD_PARAM', message: 'limit must be a finite number' });
    }
    const result = await withSystemTenantClient(tenantId, (client) =>
      processMining(client, tenantId, { entityType, days, limit, departmentId, departmentUnassigned }),
    );
    return res.json({ ok: true, code: 0, result });
  } catch (e) {
    next(e);
  }
});

export default router;
