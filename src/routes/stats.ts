// 报表大屏模块（批次 C）：复用 repo/stats.ticketStats（工单总量/完成/自动派单率/闭环率）
// + 新增 by-catalog 聚合（给大屏"各模块量"）。
// 诚实口径：满意度数据后端暂无，大屏不显示或标注"待满意度模块接入"，禁止编造（见 repo/stats.ts）。
import { Router } from 'express';
import { withTenantClient } from '../db/pool.js';
import { ticketStats, processMetrics } from '../repo/stats.js';
import { qualityReport } from '../services/dataQuality.js';

const router = Router();

router.get('/stats', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const stats = await withTenantClient(tenantId, (client) => ticketStats(client, tenantId));
    return res.json({ ok: true, code: 0, stats });
  } catch (e) {
    next(e);
  }
});

router.get('/stats/by-catalog', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT catalog, COUNT(*)::int AS count FROM work_orders WHERE tenant_id=$1 GROUP BY catalog ORDER BY count DESC`,
          [tenantId],
        )
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// B2 过程挖掘度量：派单命中率/转派率/SLA/时长分布/瓶颈（飞轮眼睛数据源）
router.get('/stats/process', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const metrics = await withTenantClient(tenantId, (client) => processMetrics(client, tenantId));
    return res.json({ ok: true, code: 0, metrics });
  } catch (e) {
    next(e);
  }
});

// C2 数据质量治理：租户事件/工单数据质量评分与问题分布（诚实：无数据返回 1.0 + note）
router.get('/stats/data-quality', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const report = await withTenantClient(tenantId, (client) => qualityReport(client, tenantId));
    return res.json({ ok: true, code: 0, quality: report });
  } catch (e) {
    next(e);
  }
});

export default router;
