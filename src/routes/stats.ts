// 报表大屏模块（批次 C）：复用 repo/stats.ticketStats（工单总量/完成/自动派单率/闭环率）
// + 新增 by-catalog 聚合（给大屏"各模块量"）。
// 诚实口径：满意度数据后端暂无，大屏不显示或标注"待满意度模块接入"，禁止编造（见 repo/stats.ts）。
import { Router } from 'express';
import { withTenantClient } from '../db/pool.js';
import { processMetrics, ticketStats, workerLoadDrift, workOrderDurations } from '../repo/stats.js';
import { workbenchStats } from '../repo/workbenchStats.js';
import { AppError } from '../middleware/error.js';
import { qualityReport } from '../services/dataQuality.js';
import { appendTimeoutExclusion } from '../repo/timeoutScope.js';
import { requirePermission } from '../middleware/role.js';
import { requireModule } from '../middleware/moduleGuard.js';
import { parseDepartmentScope } from './departmentScope.js';

const router = Router();

// analytics 是这一整组路由的模块边界：门禁放在 router 自身，任何挂载方都不会漏挂。
// 移动端不使用 /stats*，因此这里可以整组强隔离；work_order 共享端点不在本文件。
router.use(requireModule('analytics'));

// GET /stats —— analytics 模块唯一入口。
// 历史原因它曾同时注册在 workOrderRouter 和 statsRouter；workOrder 先挂载导致
// 模块关闭时仍能从共享路由访问。现在归并到 statsRouter，并由 server.ts 统一挂
// requireModule('analytics')，不再保留第二份。
router.get('/stats', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const stats = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'dashboard.view');
      const base = await ticketStats(client, tenantId);
      const byCatalog = await client.query(
        `SELECT COALESCE(NULLIF(catalog,''),'未分类') AS key, COUNT(*)::int AS count
           FROM work_orders WHERE tenant_id=$1 GROUP BY 1 ORDER BY count DESC`,
        [tenantId],
      );
      const bySource = await client.query(
        `SELECT COALESCE(NULLIF(source,''),'未知') AS key, COUNT(*)::int AS count
           FROM work_orders WHERE tenant_id=$1 GROUP BY 1 ORDER BY count DESC`,
        [tenantId],
      );
      return {
        ...base,
        catalog_distribution: byCatalog.rows,
        source_distribution: bySource.rows,
      };
    });
    return res.json({ ok: true, code: 0, ...stats });
  } catch (e) {
    next(e);
  }
});

// 以下 /stats/by-catalog、/stats/process、/stats/data-quality、/stats/overdue 均为 analytics 管理端点。

// 审查修复（横切⑤⑥ F1）：原四端点零守卫——任意登录角色（含 worker）可拉全租户报表聚合
// （工单分布/过程度量/数据质量/超时预警）。统一挂 dashboard.view，与 workOrder.ts GET /stats
// 同款范式（requirePermission 在 withTenantClient 内调用，租户级覆盖生效；admin 恒放行）。
// 调用面核实：四端点均为 FE 大屏/统计页消费，FE 菜单本就按 dashboard.view 过滤，挂墙零回归。
router.get('/stats/by-catalog', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'dashboard.view');
      return client
        .query(
          `SELECT catalog, COUNT(*)::int AS count FROM work_orders WHERE tenant_id=$1 GROUP BY catalog ORDER BY count DESC`,
          [tenantId],
        )
        .then((r) => r.rows);
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// B2 过程挖掘度量：派单命中率/转派率/SLA/时长分布/瓶颈（飞轮眼睛数据源）
router.get('/stats/process', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const metrics = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'dashboard.view');
      return processMetrics(client, tenantId);
    });
    return res.json({ ok: true, code: 0, metrics });
  } catch (e) {
    next(e);
  }
});

// C2 数据质量治理：租户事件/工单数据质量评分与问题分布（诚实：无数据返回 1.0 + note）
router.get('/stats/data-quality', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const report = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'dashboard.view');
      return qualityReport(client, tenantId);
    });
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
    const { departmentId, departmentUnassigned } = parseDepartmentScope(req.query);
    const out = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'dashboard.view');
      // 与工作台 timeout/list 共用同一「按 def_version 排除终态」口径，避免两个超时数字打架。
      const params: unknown[] = [tenantId];
      const timeoutCond = await appendTimeoutExclusion(client, tenantId, params, 'wo');
      const deptCond = departmentUnassigned
        ? 'AND department_id IS NULL'
        : departmentId
          ? `AND department_id::text = $${params.push(departmentId)}`
          : '';
      const r = await client.query(
        `SELECT
           COUNT(*)::int AS overdue_total,
           COALESCE(MIN(sla_due_at), NULL)::text AS earliest_due,
           COALESCE(AVG(EXTRACT(EPOCH FROM (now() - sla_due_at)) / 60)::int, 0) AS avg_overdue_min,
           COUNT(*) FILTER (WHERE now() - sla_due_at <= interval '1 hour')::int AS age_lt_1h,
           COUNT(*) FILTER (WHERE now() - sla_due_at > interval '1 hour' AND now() - sla_due_at <= interval '4 hours')::int AS age_1_4h,
           COUNT(*) FILTER (WHERE now() - sla_due_at > interval '4 hours' AND now() - sla_due_at <= interval '24 hours')::int AS age_4_24h,
           COUNT(*) FILTER (WHERE now() - sla_due_at > interval '24 hours')::int AS age_gt_24h
         FROM work_orders wo
         WHERE tenant_id = $1 AND ${timeoutCond}
           ${deptCond}`,
        params,
      );
      const row = r.rows[0];
      const byCatalogParams: unknown[] = [tenantId];
      const byCatalogTimeoutCond = await appendTimeoutExclusion(client, tenantId, byCatalogParams, 't');
      const byCatalogDeptCond = departmentUnassigned
        ? 'AND t.department_id IS NULL'
        : departmentId
          ? `AND t.department_id::text = $${byCatalogParams.push(departmentId)}`
          : '';
      const byCatalog = await client.query(
        `SELECT COALESCE(NULLIF(fc.name, ''), NULLIF(t.catalog, ''), '未分类') AS catalog, COUNT(*)::int AS count
         FROM work_orders t
         LEFT JOIN fault_category fc ON fc.tenant_id = t.tenant_id AND (fc.code = t.catalog OR fc.id::text = t.catalog)
         WHERE t.tenant_id = $1 AND ${byCatalogTimeoutCond}
           ${byCatalogDeptCond}
         GROUP BY 1 ORDER BY count DESC, 1 LIMIT 5`,
        byCatalogParams,
      );
      return {
        overdue_total: row ? Number(row.overdue_total) : 0,
        earliest_due: row ? row.earliest_due : null,
        avg_overdue_min: row ? Number(row.avg_overdue_min) : 0,
        age_buckets: {
          lt_1h: row ? Number(row.age_lt_1h) : 0,
          h1_4: row ? Number(row.age_1_4h) : 0,
          h4_24: row ? Number(row.age_4_24h) : 0,
          gt_24h: row ? Number(row.age_gt_24h) : 0,
        },
        by_catalog: byCatalog.rows.map((x) => ({ catalog: x.catalog, count: Number(x.count) })),
      };
    });
    return res.json({ ok: true, code: 0, overdue: out });
  } catch (e) {
    next(e);
  }
});

// worker.load 漂移对账（2026-10-19 · 只读诊断端点）
// load 是派单负载均衡的**唯一输入**，历史上出现过与真实在身单长期背离（存量脏数据）。
// 这里只**读**不写：把每位工人的「系统记的在身数 vs 真实在身单数」摆出来，
// 让失真可见、可复核。校正（写库）不在本端点职责内，须人工批准另做。
// GET /stats/workbench —— 工作台统一统计（列表/卡片同一 scope）
router.get('/stats/workbench', async (req, res, next) => {
  try {
    const qstr = (k: string): string | undefined => {
      const v = req.query[k];
      return typeof v === 'string' && v ? v : undefined;
    };
    const bucket = qstr('bucket');
    const status = qstr('status');
    if (bucket && status) {
      throw new AppError('BAD_PARAM', 'bucket 与 status 互斥，不能同时传', 400);
    }
    const { departmentId, departmentUnassigned } = parseDepartmentScope(req.query);

    const tenantId = res.locals.auth.tenantId;
    const stats = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'dashboard.view');
      return workbenchStats(client, tenantId, {
        bucket,
        status,
        departmentId,
        departmentUnassigned,
        priority: qstr('priority'),
        source: qstr('source'),
        businessType: qstr('business_type'),
      });
    });
    return res.json({ ok: true, code: 0, ...stats });
  } catch (e) {
    next(e);
  }
});

router.get('/stats/worker-load-drift', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { departmentId, departmentUnassigned } = parseDepartmentScope(req.query);
    const items = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'dashboard.view');
      return workerLoadDrift(client, tenantId, { departmentId, departmentUnassigned });
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// 工单阶段时长 P50/P90：管理大屏用，部门口径与 KPI/列表共用 parseDepartmentScope。
router.get('/stats/work-order-durations', async (req, res, next) => {
  try {
    const { departmentId, departmentUnassigned } = parseDepartmentScope(req.query);
    const rawDays = req.query.days;
    const days = typeof rawDays === 'string' ? Number(rawDays) : undefined;
    if (rawDays !== undefined && (!Number.isFinite(days) || (days as number) < 1)) {
      throw new AppError('BAD_PARAM', 'days must be a positive finite number', 400);
    }
    const tenantId = res.locals.auth.tenantId;
    const out = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'dashboard.view');
      return workOrderDurations(client, tenantId, { days, departmentId, departmentUnassigned });
    });
    return res.json({ ok: true, code: 0, ...out });
  } catch (e) {
    next(e);
  }
});

export default router;
