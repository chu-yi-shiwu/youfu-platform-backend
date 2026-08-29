// 志愿者模块（批次 B · PRD §6.5）：活动 + 报名记录（状态机 + 服务时长 + 积分）。
// 风格对齐 config.ts；写操作 requireConfigRole；签到/签退/审批走状态机。
// B1 统一事件总线：关键业务动作 emit domain_event（过程挖掘统一数据源）。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requireConfigRole } from '../middleware/role.js';
import { emitDomainEvent } from '../db/eventBus.js';

const router = Router();

// ============ 活动 ============
const activitySchema = z.object({
  title: z.string().min(1),
  batch: z.string().optional(),
  location: z.string().optional(),
  start_at: z.string().optional(),
  end_at: z.string().optional(),
  slots: z.number().int().min(0).default(0),
});

router.get('/activities', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT id, title, batch, location, start_at, end_at, slots, status, created_at FROM volunteer_activity WHERE tenant_id = $1 ORDER BY created_at DESC`,
          [tenantId],
        )
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.post('/activities', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = activitySchema.parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const r = await client.query(
        `INSERT INTO volunteer_activity (tenant_id, title, batch, location, start_at, end_at, slots, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'open') RETURNING *`,
        [tenantId, b.title, b.batch ?? null, b.location ?? null, b.start_at ?? null, b.end_at ?? null, b.slots],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'volunteer_activity', entityId: row.id, type: 'create', actor: 'config_role' });
      return row;
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.get('/activities/:id/records', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT id, activity_id, user_name, status, check_in_at, check_out_at, duration_min, points, created_at
           FROM volunteer_record WHERE tenant_id = $1 AND activity_id = $2 ORDER BY created_at ASC`,
          [tenantId, req.params.id],
        )
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// 报名（普通用户即可，仅登录）
router.post('/activities/:id/signup', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ user_name: z.string().min(1) }).parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const act = await client.query(`SELECT id FROM volunteer_activity WHERE id = $1 AND tenant_id = $2`, [
        req.params.id,
        tenantId,
      ]);
      if (act.rowCount === 0) throw new AppError('NOT_FOUND', 'activity not found', 404);
      const r = await client.query(
        `INSERT INTO volunteer_record (tenant_id, activity_id, user_name, status) VALUES ($1,$2,$3,'registered') RETURNING *`,
        [tenantId, req.params.id, b.user_name],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'volunteer_record', entityId: row.id, type: 'signup', actor: 'user' });
      return row;
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 签退时长/积分计算（纯函数便于单测）：时长向下取整到分钟，积分 = floor(分钟/60)
export function computeCheckout(checkInAt: string | Date, checkOutAt: string | Date): { duration_min: number; points: number } {
  const ms = new Date(checkOutAt).getTime() - new Date(checkInAt).getTime();
  const durationMin = ms > 0 ? Math.floor(ms / 60000) : 0;
  return { duration_min: durationMin, points: Math.floor(durationMin / 60) };
}

router.post('/records/:id/checkin', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM volunteer_record WHERE id = $1 AND tenant_id = $2`, [
        req.params.id,
        tenantId,
      ]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'record not found', 404);
      if (cur.rows[0].status !== 'registered' && cur.rows[0].status !== 'serving') {
        throw new AppError('BAD_STATE', '只能对已报名/服务中的记录签到', 409);
      }
      const r = await client.query(
        `UPDATE volunteer_record SET status = 'checked_in', check_in_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [req.params.id, tenantId],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'volunteer_record', entityId: row.id, type: 'checkin', actor: 'config_role' });
      return row;
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.post('/records/:id/checkout', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM volunteer_record WHERE id = $1 AND tenant_id = $2`, [
        req.params.id,
        tenantId,
      ]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'record not found', 404);
      const rec = cur.rows[0];
      if (!rec.check_in_at) throw new AppError('BAD_STATE', 'must check in before checkout', 409);
      if (rec.status !== 'checked_in') throw new AppError('BAD_STATE', '仅 checked_in 状态可签退', 409);
      const { duration_min, points } = computeCheckout(rec.check_in_at, new Date());
      const r = await client.query(
        `UPDATE volunteer_record SET status = 'checked_out', check_out_at = now(), duration_min = $3, points = $4 WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [req.params.id, tenantId, duration_min, points],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'volunteer_record', entityId: row.id, type: 'checkout', actor: 'config_role' });
      return row;
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.post('/records/:id/approve', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM volunteer_record WHERE id = $1 AND tenant_id = $2`, [
        req.params.id,
        tenantId,
      ]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'record not found', 404);
      const r = await client.query(
        `UPDATE volunteer_record SET status = 'approved' WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [req.params.id, tenantId],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'volunteer_record', entityId: row.id, type: 'approve', actor: 'config_role' });
      return row;
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.get('/stats', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const stats = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT
             COUNT(*) FILTER (WHERE status = 'registered') AS registered_count,
             COUNT(*) FILTER (WHERE status IN ('checked_in','serving','checked_out','approved')) AS served_count,
             COALESCE(SUM(duration_min), 0) AS total_duration_min,
             COALESCE(SUM(points), 0) AS total_points
           FROM volunteer_record WHERE tenant_id = $1`,
          [tenantId],
        )
        .then((r) => r.rows[0]),
    );
    return res.json({ ok: true, code: 0, stats });
  } catch (e) {
    next(e);
  }
});

export default router;
