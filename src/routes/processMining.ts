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
    const result = await withTenantClient(tenantId, (client) =>
      processMining(client, tenantId, { entityType, days, limit }),
    );
    return res.json({ ok: true, code: 0, result });
  } catch (e) {
    next(e);
  }
});

export default router;
