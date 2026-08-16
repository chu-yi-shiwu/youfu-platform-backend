// ② 主数据补全：商品目录(product_catalog) CRUD。
// 表由 024_master_data_catalog.sql 新建（租户内 code 唯一，RLS 已建）。
// 风格对齐 material.ts：withTenantClient 注入租户/RLS；写操作 requireConfigRole；COALESCE 更新避免误清空。
import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requireConfigRole } from '../middleware/role.js';

const router = Router();

const catalogSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  category: z.string().optional(),
  unit: z.string().optional(),
  price: z.number().nonnegative().optional(),
  enabled: z.boolean().optional(),
  description: z.string().optional(),
});

// ============ 商品目录列表 ============
router.get('/product-catalog', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { code, name, category } = req.query as Record<string, string>;
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      clauses.push(sql.replace('?', `$${params.length}`));
    };
    if (code) add('code ILIKE ?', `%${code}%`);
    if (name) add('name ILIKE ?', `%${name}%`);
    if (category) add('category = ?', category);
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT * FROM product_catalog WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params)
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// ============ 商品目录详情 ============
router.get('/product-catalog/:id', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT * FROM product_catalog WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId])
        .then((r) => r.rows[0] ?? null),
    );
    if (!item) throw new AppError('NOT_FOUND', 'product_catalog not found', 404);
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// ============ 新建商品目录项 ============
router.post('/product-catalog', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = catalogSchema.parse(req.body);
    const item = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `INSERT INTO product_catalog (id, tenant_id, code, name, category, unit, price, enabled, description)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [
            randomUUID(),
            tenantId,
            b.code,
            b.name,
            b.category ?? null,
            b.unit ?? null,
            b.price ?? 0,
            b.enabled ?? true,
            b.description ?? null,
          ],
        )
        .then((r) => r.rows[0]),
    );
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// ============ 更新商品目录项 ============
router.put('/product-catalog/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = catalogSchema.partial().parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM product_catalog WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'product_catalog not found', 404);
      const c = cur.rows[0];
      const r = await client.query(
        `UPDATE product_catalog SET
           code=COALESCE($3,code), name=COALESCE($4,name), category=COALESCE($5,category),
           unit=COALESCE($6,unit), price=COALESCE($7,price), enabled=COALESCE($8,enabled),
           description=COALESCE($9,description), updated_at=now()
         WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        [
          req.params.id,
          tenantId,
          b.code ?? null,
          b.name ?? null,
          b.category ?? null,
          b.unit ?? null,
          b.price ?? null,
          b.enabled ?? null,
          b.description ?? null,
        ],
      );
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// ============ 删除商品目录项（无台账外键约束，直接删；编码唯一保证安全） ============
router.delete('/product-catalog/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const n = await withTenantClient(tenantId, (client) =>
      client
        .query(`DELETE FROM product_catalog WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId])
        .then((r) => r.rowCount ?? 0),
    );
    if (n === 0) throw new AppError('NOT_FOUND', 'product_catalog not found', 404);
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

export default router;
