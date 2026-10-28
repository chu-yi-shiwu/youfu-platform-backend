// 服务台模块（批次 C）：服务台管理（GET/POST /service-desks、PUT /service-desks/:id）。
// 风格对齐既有路由：withTenantClient 注入租户/RLS；写操作 requirePermission('servicedesk.manage')。
// 🔴 原「客服人员编排」3 个端点与「代申告」POST /tickets 均已于 2026-10-28 下线（见下方留痕）。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requirePermission } from '../middleware/role.js';

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

// 🔴 代申告（原 POST /tickets）已于 2026-10-28 下线（初一**改判**，与坐席同批）。
//   为什么删（三条实测事实推翻了原先「保留只改措辞」的前提）：
//     ① **前端零调用方** —— 其唯一专属字段 callerName 在前端 src/ **零命中**，纯后端端点；
//     ② **它不触发自动派单** —— 建单走 repo.createWithIdem，不调用 autoDispatchAfterCreate，
//        且 status 硬编码 'draft' ⇒ 单停在初态，**必须有人手动派**；
//     ③ **生产零代申告单** —— 没人用过。
//   ⇒ 它就是「值班接电话 → 手动建单 → 手动派单」的功能实体，与「工单自动流转、
//     业务流程不许非得加一个人去派单」正面冲突。
// ⚠️ 小程序仓 pages/operator/accept 里的「代申告」是**同名不同物**：它走
//    POST /public/repair-report（公开报修），**不是**本端点，不在本批范围。
// 🔴 回退：revert 本 commit 即恢复端点（无数据迁移）。

export default router;
