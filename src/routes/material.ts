// 仓库物资模块（批次 C）：材料档案 + 库存台账 + 入库/出库/流水。
// 风格对齐 config.ts / volunteer.ts：withTenantClient 注入租户/RLS；写操作 requireConfigRole；占位符防注入。
// 出库防超卖靠 SELECT ... FOR UPDATE（事务内），并发正确性【部署后补验：并发出库实测】。
import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requireConfigRole } from '../middleware/role.js';
import { applyStockAction } from '../services/inventory.js';

const router = Router();

// ============ 材料档案 ============
const materialSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  category: z.string().optional(),
  spec: z.string().optional(),
  unit: z.string().optional(),
  price: z.number().nonnegative().optional(),
  enabled: z.boolean().optional(),
});

router.get('/materials', async (req, res, next) => {
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
        .query(`SELECT * FROM material WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params)
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.post('/materials', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = materialSchema.parse(req.body);
    const item = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `INSERT INTO material (tenant_id, code, name, category, spec, unit, price, enabled)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [tenantId, b.code, b.name, b.category ?? null, b.spec ?? null, b.unit ?? null, b.price ?? 0, b.enabled ?? true],
        )
        .then((r) => r.rows[0]),
    );
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.put('/materials/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = materialSchema.partial().parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM material WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'material not found', 404);
      const c = cur.rows[0];
      const r = await client.query(
        `UPDATE material SET code=COALESCE($3,code), name=COALESCE($4,name), category=COALESCE($5,category),
           spec=COALESCE($6,spec), unit=COALESCE($7,unit), price=COALESCE($8,price), enabled=COALESCE($9,enabled), updated_at=now()
         WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        [req.params.id, tenantId, b.code ?? null, b.name ?? null, b.category ?? null, b.spec ?? null, b.unit ?? null, b.price ?? null, b.enabled ?? null],
      );
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.delete('/materials/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const n = await withTenantClient(tenantId, async (client) => {
      const inv = await client.query(`SELECT 1 FROM inventory WHERE material_id=$1 AND tenant_id=$2 LIMIT 1`, [req.params.id, tenantId]);
      if (inv.rowCount && inv.rowCount > 0) throw new AppError('CONFLICT', '该材料仍有库存台账，禁止删除', 409);
      const log = await client.query(`SELECT 1 FROM inventory_log WHERE material_id=$1 AND tenant_id=$2 LIMIT 1`, [req.params.id, tenantId]);
      if (log.rowCount && log.rowCount > 0) throw new AppError('CONFLICT', '该材料仍有出入库流水，禁止删除', 409);
      const r = await client.query(`DELETE FROM material WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      return r.rowCount ?? 0;
    });
    if (n === 0) throw new AppError('NOT_FOUND', 'material not found', 404);
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

// ============ 库存台账 + 出入库 ============
const stockSchema = z.object({
  material_id: z.string().uuid(),
  warehouse: z.string().optional(),
  qty: z.number().int().positive(),
  ref_no: z.string().optional(),
  note: z.string().optional(),
});

router.get('/inventory', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { material_id, warehouse, low } = req.query as Record<string, string>;
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      clauses.push(sql.replace('?', `$${params.length}`));
    };
    if (material_id) add('material_id = ?', material_id);
    if (warehouse) add('warehouse = ?', warehouse);
    if (low === '1') clauses.push('qty < min_qty');
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT * FROM inventory WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC`, params)
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.post('/inventory/in', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = stockSchema.parse(req.body);
    const who = res.locals.auth.userId ?? res.locals.auth.role ?? 'system';
    const result = await withTenantClient(tenantId, async (client) => {
      const mat = await client.query(`SELECT id FROM material WHERE id=$1 AND tenant_id=$2`, [b.material_id, tenantId]);
      if (mat.rowCount === 0) throw new AppError('NOT_FOUND', 'material not found', 404);
      const wh = b.warehouse ?? '中心库';
      const lock = await client.query(
        `SELECT qty FROM inventory WHERE tenant_id=$1 AND material_id=$2 AND warehouse=$3 FOR UPDATE`,
        [tenantId, b.material_id, wh],
      );
      let nextQty: number;
      if (lock.rowCount === 0) {
        nextQty = applyStockAction(0, { type: 'in', qty: b.qty }).next;
        await client.query(
          `INSERT INTO inventory (tenant_id, material_id, warehouse, qty, updated_at) VALUES ($1,$2,$3,$4, now())`,
          [tenantId, b.material_id, wh, nextQty],
        );
      } else {
        const calc = applyStockAction(Number(lock.rows[0].qty), { type: 'in', qty: b.qty });
        nextQty = calc.next;
        await client.query(
          `UPDATE inventory SET qty=$3, updated_at=now() WHERE tenant_id=$1 AND material_id=$2 AND warehouse=$4`,
          [tenantId, b.material_id, nextQty, wh],
        );
      }
      await client.query(
        `INSERT INTO inventory_log (tenant_id, material_id, type, qty, ref_no, note, created_by)
         VALUES ($1,$2,'in',$3,$4,$5,$6)`,
        [tenantId, b.material_id, b.qty, b.ref_no ?? null, b.note ?? null, who],
      );
      return { qty: nextQty };
    });
    return res.json({ ok: true, code: 0, result });
  } catch (e) {
    next(e);
  }
});

router.post('/inventory/out', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = stockSchema.parse(req.body);
    const who = res.locals.auth.userId ?? res.locals.auth.role ?? 'system';
    const result = await withTenantClient(tenantId, async (client) => {
      const mat = await client.query(`SELECT id FROM material WHERE id=$1 AND tenant_id=$2`, [b.material_id, tenantId]);
      if (mat.rowCount === 0) throw new AppError('NOT_FOUND', 'material not found', 404);
      const wh = b.warehouse ?? '中心库';
      const lock = await client.query(
        `SELECT qty FROM inventory WHERE tenant_id=$1 AND material_id=$2 AND warehouse=$3 FOR UPDATE`,
        [tenantId, b.material_id, wh],
      );
      if (lock.rowCount === 0) throw new AppError('BAD_REQUEST', '库存台账不存在', 400);
      const calc = applyStockAction(Number(lock.rows[0].qty), { type: 'out', qty: b.qty });
      if (!calc.ok) throw new AppError('BAD_REQUEST', '库存不足', 400);
      await client.query(
        `UPDATE inventory SET qty=$3, updated_at=now() WHERE tenant_id=$1 AND material_id=$2 AND warehouse=$4`,
        [tenantId, b.material_id, calc.next, wh],
      );
      await client.query(
        `INSERT INTO inventory_log (tenant_id, material_id, type, qty, ref_no, note, created_by)
         VALUES ($1,$2,'out',$3,$4,$5,$6)`,
        [tenantId, b.material_id, b.qty, b.ref_no ?? null, b.note ?? null, who],
      );
      return { qty: calc.next };
    });
    return res.json({ ok: true, code: 0, result });
  } catch (e) {
    next(e);
  }
});

router.get('/inventory/logs', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { material_id, type } = req.query as Record<string, string>;
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      clauses.push(sql.replace('?', `$${params.length}`));
    };
    if (material_id) add('material_id = ?', material_id);
    if (type) add('type = ?', type);
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT * FROM inventory_log WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params)
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

export default router;
