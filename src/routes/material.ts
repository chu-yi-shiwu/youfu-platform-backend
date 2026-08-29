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
import { emitDomainEvent } from '../db/eventBus.js';
import { parseCsv, csvEscape } from '../services/csvUtil.js';

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
  doc: z.string().optional(), // 文档（UOne B 耗材文档）
});

router.get('/materials', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { code, name, category } = req.query as Record<string, string>;
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      clauses.push(sql.replace(/\?/g, `$${params.length}`));
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
          `INSERT INTO material (tenant_id, code, name, category, spec, unit, price, enabled, doc)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [tenantId, b.code, b.name, b.category ?? null, b.spec ?? null, b.unit ?? null, b.price ?? 0, b.enabled ?? true, b.doc ?? null],
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
           spec=COALESCE($6,spec), unit=COALESCE($7,unit), price=COALESCE($8,price), enabled=COALESCE($9,enabled), doc=COALESCE($10,doc), updated_at=now()
         WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        [req.params.id, tenantId, b.code ?? null, b.name ?? null, b.category ?? null, b.spec ?? null, b.unit ?? null, b.price ?? null, b.enabled ?? null, b.doc ?? null],
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
  // 物料×工单 关联（工单维修领料）：order_no → 服务端解析为 work_order_id（校验租户）
  work_order_no: z.string().optional(),
});

router.get('/inventory', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { material_id, warehouse, low } = req.query as Record<string, string>;
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      clauses.push(sql.replace(/\?/g, `$${params.length}`));
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
      // R23-001 修复：并发首存入库竞态——SELECT ... FOR UPDATE 不会锁「不存在的行」，
      // 两个并发首存会对同一 (tenant_id,material_id,warehouse) 各 INSERT 一条 → 重复台账行 / 库存翻倍。
      // 改用唯一约束 + ON CONFLICT DO UPDATE 原子 upsert（依赖 061_inventory_unique.sql 的唯一约束）。
      const ups = await client.query(
        `INSERT INTO inventory (tenant_id, material_id, warehouse, qty, updated_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (tenant_id, material_id, warehouse)
         DO UPDATE SET qty = inventory.qty + EXCLUDED.qty, updated_at = now()
         RETURNING qty`,
        [tenantId, b.material_id, wh, b.qty],
      );
      const nextQty = Number(ups.rows[0].qty);
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
      // 物料×工单 关联：order_no → work_order_id（校验租户；不存在则忽略，不阻断出库）
      let woId: string | null = null;
      if (b.work_order_no) {
        const wo = await client.query('SELECT id FROM work_orders WHERE tenant_id=$1 AND order_no=$2 LIMIT 1', [tenantId, b.work_order_no.trim()]);
        if (wo.rows.length > 0) woId = wo.rows[0].id;
      }
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
        `INSERT INTO inventory_log (tenant_id, material_id, type, qty, ref_no, note, created_by, work_order_id)
         VALUES ($1,$2,'out',$3,$4,$5,$6,$7)`,
        [tenantId, b.material_id, b.qty, b.ref_no ?? null, b.note ?? null, who, woId],
      );
      // P0 飞轮：材料领料/换件事件（挂工单 id，供工单上下文特征与归因）
      await emitDomainEvent(client, { tenantId, entityType: 'material', entityId: b.material_id, type: 'material_consumed', actor: who, payload: { qty: b.qty, ref_no: b.ref_no ?? null, warehouse: wh, work_order_id: woId } });
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
      clauses.push(sql.replace(/\?/g, `$${params.length}`));
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

// ============ 耗材 CSV 导出 / 导入 ============
const MAT_CSV_COLS = ['code', 'name', 'category', 'spec', 'unit', 'price', 'doc'];
router.get('/materials/export', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client.query(`SELECT * FROM material WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId]).then((r) => r.rows),
    );
    const lines = [MAT_CSV_COLS.join(',')];
    for (const row of items) lines.push(MAT_CSV_COLS.map((h) => csvEscape(row[h])).join(','));
    const csv = '﻿' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="material.csv"');
    return res.send(csv);
  } catch (e) {
    next(e);
  }
});

router.post('/materials/import', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const text = typeof req.body === 'string' ? req.body : (req.body as any)?.csv;
    if (!text || typeof text !== 'string') throw new AppError('BAD_INPUT', 'csv text required', 400);
    const rows = parseCsv(text);
    if (rows.length < 2) return res.json({ ok: true, code: 0, inserted: 0 });
    const headers = rows[0].map((h) => h.trim());
    const dataRows = rows.slice(1);
    let inserted = 0;
    await withTenantClient(tenantId, async (client) => {
      for (const r of dataRows) {
        const obj: Record<string, unknown> = {};
        headers.forEach((h, i) => { if (MAT_CSV_COLS.includes(h)) obj[h] = r[i] ?? null; });
        if (!obj.code || !obj.name) continue;
        const id = randomUUID();
        const cols = ['id', 'tenant_id', ...MAT_CSV_COLS];
        const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
        const vals = [id, tenantId, ...MAT_CSV_COLS.map((c) => obj[c] ?? null)];
        await client.query(`INSERT INTO material (${cols.join(', ')}) VALUES (${ph})`, vals);
        inserted++;
      }
    });
    return res.json({ ok: true, code: 0, inserted });
  } catch (e) {
    next(e);
  }
});

export default router;
