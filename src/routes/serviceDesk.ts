// 服务台模块（批次 C）：服务台管理 + 服务台人员代报修（POST /tickets）。
// 风格对齐既有路由：withTenantClient 注入租户/RLS；写操作 requirePermission('servicedesk.manage')。
// 代报修复用 repo.createWithIdem（不强制全局幂等，仅 sessionId 防双击，见 services/serviceDeskTicket.ts）。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requirePermission } from '../middleware/role.js';
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
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'servicedesk.manage');
      const b = deskSchema.parse(req.body);
      return client
        .query(`INSERT INTO service_desk (tenant_id, name, template) VALUES ($1,$2,$3) RETURNING *`, [
          tenantId,
          b.name,
          b.template ?? null,
        ])
        .then((r) => r.rows[0]);
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.put('/service-desks/:id', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'servicedesk.manage');
      const b = deskSchema.partial().parse(req.body);
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

// 坐席（service_desk_agent）已于 2026-10-28 下线（决策：初一「取消坐席」，只删坐席、服务台保留）。
// 原 3 个端点 GET/POST /service-desks/:id/agents 与 DELETE /service-desks/:id/agents/:agentId
// 已删除；表 service_desk_agent 由后续迁移 105 删除（本批只下代码，先观察，再删表）。
// 🔴 回退：revert 本 commit 即恢复端点；表若已 DROP，需另跑 rollback/105_drop_service_desk_agent_down.sql
//    重建空表——**结构可恢复，数据不可恢复**（唯一那 1 行已留档，见骨架仓
//    docs/00_现行/_archive/service_desk_agent_备份_20261028.sql）。

// 服务台人员代报修：生成标准工单进入派单流（服务台人员即可，不强制 admin；需登录由 authMiddleware 保证）
// 决策 #5 豁免说明：本路径天然绑定 deskId（deskId 为必填且已做存在性校验），
// 租户开启 ticket_require_service_desk 严格开关时无需也不应重复校验——代报修本身即"有服务台"的建单通道。
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
      // R35 接线：登录态建单纳入 intake.create 权限点（公开报修 /public/* 不受影响，走独立匿名链路）
      await requirePermission(res.locals.auth, client, 'intake.create');
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
