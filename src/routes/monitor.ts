// 网管监控模块（批次 B · PRD §G）：设备状态 + 告警；告警可转标准工单（不混监控流程）。
// 风格对齐；写操作 requireConfigRole；转单复用 services/linkedWorkOrder。
// B1 统一事件总线：设备新增/告警/解决/转工单 emit domain_event（过程挖掘统一数据源）。
import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requireConfigRole } from '../middleware/role.js';
import { createLinkedWorkOrder } from '../services/linkedWorkOrder.js';
import { emitDomainEvent } from '../db/eventBus.js';

const router = Router();

// ============ 设备 ============
const deviceSchema = z.object({
  name: z.string().min(1),
  ip: z.string().optional(),
  category: z.string().optional(),
  status: z.enum(['online', 'offline', 'warning']).default('online'),
});

router.get('/devices', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { status } = req.query as Record<string, string>;
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    if (status) {
      params.push(status);
      clauses.push(`status = $${params.length}`);
    }
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT * FROM monitor_device WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params)
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.post('/devices', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = deviceSchema.parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const r = await client.query(
        `INSERT INTO monitor_device (tenant_id, name, ip, category, status) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [tenantId, b.name, b.ip ?? null, b.category ?? null, b.status],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'monitor_device', entityId: row.id, type: 'create', actor: 'config_role' });
      return row;
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.put('/devices/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = z
      .object({
        status: z.enum(['online', 'offline', 'warning']).optional(),
        traffic_in: z.number().optional(),
        traffic_out: z.number().optional(),
        last_seen: z.string().optional(),
        note: z.string().optional(),
      })
      .parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM monitor_device WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'device not found', 404);
      const r = await client.query(
        `UPDATE monitor_device SET
           status = COALESCE($3, status),
           traffic_in = COALESCE($4, traffic_in),
           traffic_out = COALESCE($5, traffic_out),
           last_seen = COALESCE($6, last_seen),
           note = COALESCE($7, note)
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [req.params.id, tenantId, b.status ?? null, b.traffic_in ?? null, b.traffic_out ?? null, b.last_seen ?? null, b.note ?? null],
      );
      const row = r.rows[0];
      if (b.status) {
        await emitDomainEvent(client, { tenantId, entityType: 'monitor_device', entityId: row.id, type: 'status_change', actor: 'config_role', payload: { status: b.status } });
      }
      return row;
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// ============ 告警 ============
router.post('/devices/:id/alert', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ level: z.enum(['info', 'warning', 'critical']).default('warning'), message: z.string().min(1) }).parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const dev = await client.query(`SELECT id FROM monitor_device WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenantId]);
      if (dev.rowCount === 0) throw new AppError('NOT_FOUND', 'device not found', 404);
      const r = await client.query(
        `INSERT INTO monitor_alert (tenant_id, device_id, level, message, status) VALUES ($1,$2,$3,$4,'active') RETURNING *`,
        [tenantId, req.params.id, b.level, b.message],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'monitor_alert', entityId: row.id, type: 'alert', actor: 'config_role', payload: { level: b.level, device_id: req.params.id } });
      return row;
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.get('/alerts', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { status, device_id } = req.query as Record<string, string>;
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      clauses.push(sql.replace(/\?/g, `$${params.length}`));
    };
    if (status) add('status = ?', status);
    if (device_id) add('device_id = ?', device_id);
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT * FROM monitor_alert WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params)
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.post('/alerts/:id/resolve', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM monitor_alert WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'alert not found', 404);
      const r = await client.query(
        `UPDATE monitor_alert SET status = 'resolved' WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [req.params.id, tenantId],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'monitor_alert', entityId: row.id, type: 'resolve', actor: 'config_role' });
      return row;
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 告警转工单：复用共享服务（告警 → 标准工单，进入派单流；critical 提级 urgent）
router.post('/alerts/:id/convert', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const result = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(
        `SELECT a.*, d.name AS device_name FROM monitor_alert a JOIN monitor_device d ON d.id = a.device_id
         WHERE a.id = $1 AND a.tenant_id = $2`,
        [req.params.id, tenantId],
      );
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'alert not found', 404);
      const a = cur.rows[0];
      const wo = await createLinkedWorkOrder(client, {
        id: randomUUID(),
        tenantId,
        businessType: 'monitor',
        catalog: 'monitor',
        priority: a.level === 'critical' ? 'urgent' : 'normal',
        title: `监控告警(${a.device_name})`,
        description: a.message,
        location: undefined,
        sourceType: 'monitor',
        sourceId: a.id,
      });
      await emitDomainEvent(client, { tenantId, entityType: 'monitor_alert', entityId: a.id, type: 'convert', actor: 'config_role', payload: { work_order_id: wo.id } });
      return wo;
    });
    return res.json({ ok: true, code: 0, result });
  } catch (e) {
    next(e);
  }
});

export default router;
