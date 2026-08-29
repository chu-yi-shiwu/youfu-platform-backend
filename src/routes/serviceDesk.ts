// 服务台模块（批次 C）：服务台管理 + 客服人员 + 来电弹屏代申告。
// 风格对齐既有路由：withTenantClient 注入租户/RLS；写操作 requireConfigRole。
// 代申告复用 repo.createWithIdem（不强制全局幂等，仅 sessionId 防双击，见 services/serviceDeskTicket.ts）。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requireConfigRole } from '../middleware/role.js';
import { createWithIdem } from '../repo/ticket.js';
import { buildServiceDeskTicket } from '../services/serviceDeskTicket.js';

const router = Router();

const deskSchema = z.object({
  name: z.string().min(1),
  template: z.string().optional(),
});

router.get('/service-desks', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT * FROM service_desk WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100`, [tenantId])
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.post('/service-desks', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = deskSchema.parse(req.body);
    const item = await withTenantClient(tenantId, (client) =>
      client
        .query(`INSERT INTO service_desk (tenant_id, name, template) VALUES ($1,$2,$3) RETURNING *`, [
          tenantId,
          b.name,
          b.template ?? null,
        ])
        .then((r) => r.rows[0]),
    );
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.put('/service-desks/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = deskSchema.partial().parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM service_desk WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'service desk not found', 404);
      const r = await client.query(
        `UPDATE service_desk SET name=COALESCE($3,name), template=COALESCE($4,template), updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        [req.params.id, tenantId, b.name ?? null, b.template ?? null],
      );
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.get('/service-desks/:id/agents', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT * FROM service_desk_agent WHERE tenant_id=$1 AND desk_id=$2 ORDER BY created_at ASC LIMIT 200`, [tenantId, req.params.id])
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.post('/service-desks/:id/agents', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ user_id: z.string().min(1), name: z.string().min(1) }).parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const desk = await client.query(`SELECT id FROM service_desk WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (desk.rowCount === 0) throw new AppError('NOT_FOUND', 'service desk not found', 404);
      const r = await client.query(
        `INSERT INTO service_desk_agent (tenant_id, desk_id, user_id, name) VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, desk_id, user_id) DO UPDATE SET name=EXCLUDED.name RETURNING *`,
        [tenantId, req.params.id, b.user_id, b.name],
      );
      return r.rows[0];
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.delete('/service-desks/:id/agents/:agentId', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const n = await withTenantClient(tenantId, (client) =>
      client
        .query(`DELETE FROM service_desk_agent WHERE tenant_id=$1 AND desk_id=$2 AND id=$3`, [tenantId, req.params.id, req.params.agentId])
        .then((r) => r.rowCount ?? 0),
    );
    if (n === 0) throw new AppError('NOT_FOUND', 'agent not found', 404);
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

// 来电弹屏代申告：生成标准工单进入派单流（坐席角色即可，不强制 admin；需登录由 authMiddleware 保证）
router.post('/tickets', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = z
      .object({
        deskId: z.string().uuid(),
        callerName: z.string().min(1),
        catalog: z.string().min(1), // 维修/运送/陪检/其他 → business_type
        description: z.string().min(1),
        location: z.string().optional(),
        sessionId: z.string().optional(),
      })
      .parse(req.body);
    const dto = buildServiceDeskTicket({
      tenantId,
      deskId: b.deskId,
      callerName: b.callerName,
      catalog: b.catalog,
      description: b.description,
      location: b.location,
      sessionId: b.sessionId,
    });
    const item = await withTenantClient(tenantId, async (client) => {
      const desk = await client.query(`SELECT id FROM service_desk WHERE id=$1 AND tenant_id=$2`, [b.deskId, tenantId]);
      if (desk.rowCount === 0) throw new AppError('NOT_FOUND', 'service desk not found', 404);
      const r = await createWithIdem(client, dto);
      return r.row;
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

export default router;
