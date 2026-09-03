// 报表大屏模块（批次 C）：复用 repo/stats.ticketStats（工单总量/完成/自动派单率/闭环率）
// + 新增 by-catalog 聚合（给大屏"各模块量"）。
// 诚实口径：满意度数据后端暂无，大屏不显示或标注"待满意度模块接入"，禁止编造（见 repo/stats.ts）。
import { Router } from 'express';
import { withTenantClient } from '../db/pool.js';
import { processMetrics } from '../repo/stats.js';
import { qualityReport } from '../services/dataQuality.js';
import { getWorkflowDef } from '../engine/workflowDef.js';
import { doneStates } from '../engine/stateMachine.js';

const router = Router();

// GET /stats 死路由已删除（P1-4）：与 workOrder.ts 的 GET /stats 双注册，
// 按挂载序（server.ts:152 workOrderRouter 先于 :168 statsRouter）workOrder 版生效，此处原为永久死代码。
// 本文件的 /stats/by-catalog、/stats/process、/stats/data-quality、/stats/overdue 为独有端点，保持不变。

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

// §12.4 超时预警（管理端红色卡）：sla_due_at 已过期且未进入完成态的工单，
// 按 catalog 排行 + 最早超时。诚实口径：无 SLA 的工单不计入（sla_due_at IS NULL 过滤）。
router.get('/stats/overdue', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const out = await withTenantClient(tenantId, async (client) => {
      const def = await getWorkflowDef(client, tenantId, 'work_order');
      const done = doneStates(def);
      const r = await client.query(
        `SELECT
           COUNT(*)::int AS overdue_total,
           COALESCE(MAX(sla_due_at), NULL)::text AS earliest_due,
           COALESCE(AVG(EXTRACT(EPOCH FROM (now() - sla_due_at)) / 60)::int, 0) AS avg_overdue_min
         FROM work_orders
         WHERE tenant_id = $1 AND sla_due_at IS NOT NULL AND sla_due_at < now() AND NOT (status = ANY($2::text[]))`,
        [tenantId, done],
      );
      const row = r.rows[0];
      const byCatalog = await client.query(
        `SELECT COALESCE(NULLIF(fc.name, ''), NULLIF(t.catalog, ''), '未分类') AS catalog, COUNT(*)::int AS count
         FROM work_orders t
         LEFT JOIN fault_category fc ON fc.tenant_id = t.tenant_id AND (fc.code = t.catalog OR fc.id::text = t.catalog)
         WHERE t.tenant_id = $1 AND t.sla_due_at IS NOT NULL AND t.sla_due_at < now() AND NOT (t.status = ANY($2::text[]))
         GROUP BY 1 ORDER BY count DESC, 1 LIMIT 5`,
        [tenantId, done],
      );
      return {
        overdue_total: row ? Number(row.overdue_total) : 0,
        earliest_due: row ? row.earliest_due : null,
        avg_overdue_min: row ? Number(row.avg_overdue_min) : 0,
        by_catalog: byCatalog.rows.map((x) => ({ catalog: x.catalog, count: Number(x.count) })),
      };
    });
    return res.json({ ok: true, code: 0, overdue: out });
  } catch (e) {
    next(e);
  }
});

export default router;
