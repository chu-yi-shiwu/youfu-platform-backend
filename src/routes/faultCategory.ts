// 故障类型/问题目录（主数据字典，租户内 code 唯一，RLS 已建）。
// 风格对齐 catalog.ts：withTenantClient 注入租户/RLS；写操作 requireConfigRole。
// 对齐 UOne 工单「故障类型/问题目录」维度：建单可从目录下拉选择，替代自由文本。
import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requireConfigRole } from '../middleware/role.js';

const router = Router();

const schema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  sort: z.number().int().optional(),
  enabled: z.boolean().optional(),
});

// ============ 故障目录列表（租户内公开读，enabled=true 优先） ============
router.get('/fault-categories', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT * FROM fault_category WHERE tenant_id=$1 ORDER BY sort ASC, created_at ASC`,
          [tenantId],
        )
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// ============ 新建故障分类（配置角色可写） ============
router.post('/fault-categories', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = schema.parse(req.body);
    const item = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `INSERT INTO fault_category (id, tenant_id, code, name, sort, enabled)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [randomUUID(), tenantId, b.code, b.name, b.sort ?? 0, b.enabled ?? true],
        )
        .then((r) => r.rows[0]),
    );
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// ============ 更新故障分类 ============
router.put('/fault-categories/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = schema.partial().parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM fault_category WHERE id=$1 AND tenant_id=$2`, [
        req.params.id,
        tenantId,
      ]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'fault_category not found', 404);
      const c = cur.rows[0];
      const r = await client.query(
        `UPDATE fault_category SET
           code=COALESCE($3,code), name=COALESCE($4,name), sort=COALESCE($5,sort),
           enabled=COALESCE($6,enabled), updated_at=now()
         WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        [req.params.id, tenantId, b.code ?? null, b.name ?? null, b.sort ?? null, b.enabled ?? null],
      );
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// ============ 删除故障分类 ============
router.delete('/fault-categories/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const n = await withTenantClient(tenantId, (client) =>
      client
        .query(`DELETE FROM fault_category WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId])
        .then((r) => r.rowCount ?? 0),
    );
    if (n === 0) throw new AppError('NOT_FOUND', 'fault_category not found', 404);
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

export default router;
