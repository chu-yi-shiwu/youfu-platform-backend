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
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM inspection_task WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'task not found', 404);
      const r = await client.query(
        `UPDATE inspection_task SET status = 'in_progress', geo_lat = $3, geo_lng = $4, note = COALESCE($5, note), updated_at = now()
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [req.params.id, tenantId, b.geo_lat ?? null, b.geo_lng ?? null, b.note ?? null],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'inspection_task', entityId: row.id, type: 'checkin', actor: 'config_role' });
      return row;
    });
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
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM inspection_task WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'task not found', 404);
      const r = await client.query(
        `UPDATE inspection_task SET status = 'done', done_at = now(), note = COALESCE($3, note), photos = COALESCE($4, photos), updated_at = now()
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [req.params.id, tenantId, b.note ?? null, b.photos ? JSON.stringify(b.photos) : null],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'inspection_task', entityId: row.id, type: 'complete', actor: 'config_role' });
      return row;
    });
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
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM inspection_task WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'task not found', 404);
      const r = await client.query(
        `UPDATE inspection_task SET status = 'exception', note = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [req.params.id, tenantId, b.note],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'inspection_task', entityId: row.id, type: 'exception', actor: 'config_role' });
      return row;
    });
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

export default router;
