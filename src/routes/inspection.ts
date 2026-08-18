// 巡检模块（批次 B · PRD §6.1）：点位 + 巡检单 + 定位签到 + 异常转工单。
// 风格对齐 config.ts：withTenantClient 注入租户/RLS；写操作 requireConfigRole；占位符防注入。
// 转单复用 services/linkedWorkOrder（巡检异常 → 标准维修工单，进入既有派单流）。
// B1 统一事件总线：关键业务动作 emit domain_event（过程挖掘统一数据源）。
import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requireConfigRole } from '../middleware/role.js';
import { createLinkedWorkOrder } from '../services/linkedWorkOrder.js';
import { emitDomainEvent } from '../db/eventBus.js';
import { getWorkflowDefOrDefault } from '../engine/workflowDef.js';
import { applyEvent, availableTransitions } from '../engine/stateMachine.js';
import { INSPECTION_DEF } from '../engine/themes.js';

/**
 * 状态流转统一走 workflow_def 引擎（红线：所有业务流必须过 workflow_def，不再硬编码状态机）。
 * 读取 inspection_task 当前 status → 用引擎校验 event 合法性 → 写入目标态。
 * 租户无自定义 inspection_task 定义时回退内置 INSPECTION_DEF，保证既有语义（pending→in_progress→done/exception）不变。
 */
async function transitionTask(
  client: any,
  tenantId: string,
  taskId: string,
  event: string,
  extra: Record<string, unknown> = {},
): Promise<any> {
  const cur = await client.query(`SELECT * FROM inspection_task WHERE id = $1 AND tenant_id = $2`, [taskId, tenantId]);
  if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'task not found', 404);
  const t = cur.rows[0];
  const def = await getWorkflowDefOrDefault(client, tenantId, 'inspection_task', INSPECTION_DEF);
  const target = applyEvent(def, t.status, event);
  if (!target) {
    throw new AppError('BAD_STATE', `illegal transition ${t.status} --${event}-->`, 422);
  }
  const extraKeys = Object.keys(extra);
  const filteredKeys = extraKeys.filter((k) => extra[k] !== 'now()');
  const assigns = [
    'status = $3',
    ...filteredKeys.map((k, idx) => `${k} = $${4 + idx}`),
    ...extraKeys.filter((k) => extra[k] === 'now()').map((k) => `${k} = now()`),
  ];
  const values = [taskId, tenantId, target, ...filteredKeys.map((k) => extra[k])];
  const r = await client.query(
    `UPDATE inspection_task SET ${assigns.join(', ')}, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    values,
  );
  await emitDomainEvent(client, { tenantId, entityType: 'inspection_task', entityId: taskId, type: event, actor: 'config_role' });
  return r.rows[0];
}

const router = Router();

// ============ 点位 ============
const pointSchema = z.object({
  name: z.string().min(1),
  code: z.string().optional(),
  lng: z.number().optional(),
  lat: z.number().optional(),
  asset_id: z.string().optional(),
});

router.get('/points', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT id, name, code, lng, lat, asset_id, created_at FROM inspection_point WHERE tenant_id = $1 ORDER BY created_at DESC`,
          [tenantId],
        )
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.post('/points', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = pointSchema.parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const r = await client.query(
        `INSERT INTO inspection_point (tenant_id, name, code, lng, lat, asset_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [tenantId, b.name, b.code ?? null, b.lng ?? null, b.lat ?? null, b.asset_id ?? null],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'inspection_point', entityId: row.id, type: 'create', actor: 'config_role' });
      return row;
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.put('/points/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = pointSchema.partial().parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM inspection_point WHERE id = $1 AND tenant_id = $2`, [
        req.params.id,
        tenantId,
      ]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'point not found', 404);
      const c = cur.rows[0];
      const r = await client.query(
        `UPDATE inspection_point SET name = $3, code = $4, lng = $5, lat = $6, asset_id = $7 WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [req.params.id, tenantId, b.name ?? c.name, b.code ?? c.code, b.lng ?? c.lng, b.lat ?? c.lat, b.asset_id ?? c.asset_id],
      );
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.delete('/points/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const n = await withTenantClient(tenantId, (client) =>
      client
        .query(`DELETE FROM inspection_point WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenantId])
        .then((r) => r.rowCount ?? 0),
    );
    if (n === 0) throw new AppError('NOT_FOUND', 'point not found', 404);
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

// ============ 巡检单 ============
const taskSchema = z.object({
  point_id: z.string().uuid().optional(),
  type: z.enum(['plan', 'free']).default('plan'),
  title: z.string().min(1),
  assignee: z.string().optional(),
  scheduled_at: z.string().optional(),
});

router.get('/tasks', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { status, point_id, type, scheduled_from, scheduled_to } = req.query as Record<string, string>;
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      clauses.push(sql.replace('?', `$${params.length}`));
    };
    if (status) add('status = ?', status);
    if (point_id) add('point_id = ?', point_id);
    if (type) add('type = ?', type);
    if (scheduled_from) add('scheduled_at >= ?', scheduled_from);
    if (scheduled_to) add('scheduled_at <= ?', scheduled_to);
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT * FROM inspection_task WHERE ${clauses.join(' AND ')} ORDER BY scheduled_at ASC NULLS LAST, created_at DESC`,
          params,
        )
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// 巡检单详情：返回任务 + 引擎算出的 available（供前端动态渲染动作按钮，不硬编码状态机）。
router.get('/tasks/:id', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM inspection_task WHERE id = $1 AND tenant_id = $2`, [
        req.params.id,
        tenantId,
      ]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'task not found', 404);
      const t = cur.rows[0];
      const def = await getWorkflowDefOrDefault(client, tenantId, 'inspection_task', INSPECTION_DEF);
      const available = availableTransitions(def, t.status);
      return { ...t, available };
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.post('/tasks', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = taskSchema.parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const r = await client.query(
        `INSERT INTO inspection_task (tenant_id, plan_id, point_id, type, title, assignee, scheduled_at, status)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, 'pending') RETURNING *`,
        [tenantId, b.point_id ?? null, b.type, b.title, b.assignee ?? null, b.scheduled_at ?? null],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'inspection_task', entityId: row.id, type: 'create', actor: 'config_role' });
      return row;
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.post('/tasks/:id/checkin', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ geo_lat: z.number().optional(), geo_lng: z.number().optional(), note: z.string().optional() }).parse(req.body);
    const item = await withTenantClient(tenantId, (client) =>
      transitionTask(client, tenantId, req.params.id, 'checkin', {
        geo_lat: b.geo_lat ?? null,
        geo_lng: b.geo_lng ?? null,
        note: b.note ?? null,
      }),
    );
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.post('/tasks/:id/complete', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ note: z.string().optional(), photos: z.array(z.string()).optional() }).parse(req.body);
    const extra: Record<string, unknown> = { done_at: 'now()', note: b.note ?? null };
    if (b.photos) extra.photos = JSON.stringify(b.photos); // photos 为 NOT NULL，仅在提供时写入，避免置空破坏约束
    const item = await withTenantClient(tenantId, (client) =>
      transitionTask(client, tenantId, req.params.id, 'complete', extra),
    );
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.post('/tasks/:id/exception', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ note: z.string().min(1) }).parse(req.body);
    const item = await withTenantClient(tenantId, (client) =>
      transitionTask(client, tenantId, req.params.id, 'exception', { note: b.note }),
    );
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 通用流转端点：复用 transitionTask（引擎校验 + 写库 + 事件记账）。
// 前端按 available 的 event 统一调用，避免为每事件单独硬编码端点（覆盖 cancel 等）。
router.post('/tasks/:id/transition', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const { event, ...fields } = req.body as { event: string; [k: string]: unknown };
    if (!event || typeof event !== 'string') throw new AppError('BAD_REQUEST', 'event is required', 400);
    const item = await withTenantClient(tenantId, (client) =>
      transitionTask(client, tenantId, req.params.id, event, fields),
    );
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 计划生成：批量为若干点位生成 pending 巡检单（纯函数便于单测）
export function generatePlanTasks(
  points: { id: string }[],
  scheduledAt: string | null,
): { point_id: string | null; type: 'plan'; title: string; status: 'pending'; scheduled_at: string | null }[] {
  return points.map((p) => ({
    point_id: p.id,
    type: 'plan' as const,
    title: '计划巡检',
    status: 'pending' as const,
    scheduled_at: scheduledAt,
  }));
}

router.post('/generate', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ point_ids: z.array(z.string().uuid()), scheduled_at: z.string().optional() }).parse(req.body);
    const created = await withTenantClient(tenantId, async (client) => {
      const rows = generatePlanTasks(
        b.point_ids.map((id) => ({ id })),
        b.scheduled_at ?? null,
      );
      const out: unknown[] = [];
      for (const row of rows) {
        const r = await client.query(
          `INSERT INTO inspection_task (tenant_id, plan_id, point_id, type, title, scheduled_at, status)
           VALUES ($1, NULL, $2, 'plan', $3, $4, 'pending') RETURNING *`,
          [tenantId, row.point_id, row.title, row.scheduled_at],
        );
        const ins = r.rows[0];
        await emitDomainEvent(client, { tenantId, entityType: 'inspection_task', entityId: ins.id, type: 'create', actor: 'config_role' });
        out.push(ins);
      }
      return out;
    });
    return res.status(201).json({ ok: true, code: 0, items: created, count: created.length });
  } catch (e) {
    next(e);
  }
});

// 异常转工单：复用共享服务（巡检异常 → 标准维修工单，进入派单流）
router.post('/tasks/:id/convert', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const result = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM inspection_task WHERE id = $1 AND tenant_id = $2`, [
        req.params.id,
        tenantId,
      ]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'task not found', 404);
      const t = cur.rows[0];
      if (t.status !== 'exception') throw new AppError('BAD_STATE', 'only exception task can convert', 409);
      const wo = await createLinkedWorkOrder(client, {
        id: randomUUID(),
        tenantId,
        businessType: 'inspection',
        catalog: 'inspection',
        priority: 'normal',
        title: `巡检异常(${t.title})`,
        description: t.note ?? '',
        location: undefined,
        sourceType: 'inspection',
        sourceId: t.id,
      });
      await client.query(`UPDATE inspection_task SET linked_wo_id = $2, updated_at = now() WHERE id = $1`, [t.id, wo.id]);
      await emitDomainEvent(client, { tenantId, entityType: 'inspection_task', entityId: t.id, type: 'convert', actor: 'config_role', payload: { work_order_id: wo.id } });
      return wo;
    });
    return res.json({ ok: true, code: 0, result });
  } catch (e) {
    next(e);
  }
});

// ============ 统计报表（P2：闭合巡检“缺报表/统计”缺口） ============
// 汇总：总量、按状态分布、今日计划数、完成率、异常率、热点点位 Top5。
router.get('/stats', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const stats = await withTenantClient(tenantId, async (client) => {
      const byStatus = await client
        .query(
          `SELECT status, COUNT(*)::int AS c FROM inspection_task WHERE tenant_id=$1 GROUP BY status`,
          [tenantId],
        )
        .then((r) => r.rows);
      const total = byStatus.reduce((s, x) => s + Number(x.c), 0);
      const byStatusMap: Record<string, number> = {};
      for (const x of byStatus) byStatusMap[x.status] = Number(x.c);
      const done = byStatusMap['done'] ?? 0;
      const exception = byStatusMap['exception'] ?? 0;
      const pending = byStatusMap['pending'] ?? 0;
      const inProgress = byStatusMap['in_progress'] ?? 0;
      const today = await client
        .query(
          `SELECT COUNT(*)::int AS c FROM inspection_task WHERE tenant_id=$1 AND DATE(COALESCE(scheduled_at, created_at)) = CURRENT_DATE`,
          [tenantId],
        )
        .then((r) => Number(r.rows[0].c));
      const byPoint = await client
        .query(
          `SELECT p.name AS point_name, COUNT(*)::int AS c
           FROM inspection_task t LEFT JOIN inspection_point p ON p.id = t.point_id
           WHERE t.tenant_id=$1 AND t.point_id IS NOT NULL
           GROUP BY p.name ORDER BY c DESC LIMIT 5`,
          [tenantId],
        )
        .then((r) => r.rows.map((x: any) => ({ point_name: x.point_name, count: Number(x.c) })));
      return {
        total,
        by_status: byStatusMap,
        pending,
        in_progress: inProgress,
        done,
        exception,
        completion_rate: total ? Math.round((done / total) * 1000) / 10 : 0,
        exception_rate: total ? Math.round((exception / total) * 1000) / 10 : 0,
        today_count: today,
        by_point_top: byPoint,
      };
    });
    return res.json({ ok: true, code: 0, stats });
  } catch (e) {
    next(e);
  }
});

// 巡检月报 CSV 导出（含点位名、完成时间）。text/csv + BOM，前端直接下载。
router.get('/export', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { month } = req.query as Record<string, string>;
    const rows = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT t.id, t.title, t.type, t.status, t.assignee, p.name AS point_name,
                  t.scheduled_at, t.done_at, t.created_at
           FROM inspection_task t LEFT JOIN inspection_point p ON p.id = t.point_id
           WHERE t.tenant_id=$1 ${month ? 'AND TO_CHAR(COALESCE(t.scheduled_at, t.created_at), \'YYYY-MM\') = $2' : ''}
           ORDER BY t.scheduled_at ASC NULLS LAST, t.created_at DESC`,
          month ? [tenantId, month] : [tenantId],
        )
        .then((r) => r.rows),
    );
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['工单ID', '标题', '类型', '状态', '负责人', '点位', '计划时间', '完成时间', '创建时间'];
    const lines = rows.map((r: any) =>
      [
        r.id,
        r.title,
        r.type === 'free' ? '自由巡检' : '计划巡检',
        r.status,
        r.assignee ?? '',
        r.point_name ?? '',
        r.scheduled_at ?? '',
        r.done_at ?? '',
        r.created_at ?? '',
      ]
        .map(esc)
        .join(','),
    );
    const csv = '﻿' + [header.join(','), ...lines].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="inspection_report_${month || 'all'}.csv"`);
    return res.send(csv);
  } catch (e) {
    next(e);
  }
});

export default router;
