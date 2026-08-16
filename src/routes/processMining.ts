// ⑦P0 过程挖掘看板 —— API 路由（飞轮"眼睛"数据接口）。
// GET /api/v1/process-mining?entityType=work_order&days=30&limit=50000
// 复用 withTenantClient（SET LOCAL app.tenant_id + SET ROLE youfu_app → RLS 生效）。
import { Router } from 'express';
import { withTenantClient } from '../db/pool.js';
import { processMining } from '../repo/processMining.js';

const router = Router();

router.get('/process-mining', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const entityType = typeof req.query.entityType === 'string' ? req.query.entityType : undefined;
    const days = typeof req.query.days === 'string' ? Number(req.query.days) : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    // 优化（自我测试后加固）：非有限数值（如 days=abc）→ 明确 400，避免 NaN 静默返回空结果。
    if (req.query.days !== undefined && !Number.isFinite(days)) {
      return res.status(400).json({ ok: false, code: 'BAD_PARAM', message: 'days must be a finite number' });
    }
    if (req.query.limit !== undefined && !Number.isFinite(limit)) {
      return res.status(400).json({ ok: false, code: 'BAD_PARAM', message: 'limit must be a finite number' });
    }
    const result = await withTenantClient(tenantId, (client) =>
      processMining(client, tenantId, { entityType, days, limit }),
    );
    return res.json({ ok: true, code: 0, result });
  } catch (e) {
    next(e);
  }
});

export default router;
