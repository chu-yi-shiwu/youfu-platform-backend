// 资产管理模块（批次 C）：资产档案 + 扫码绑定 + 故障转工单 + 关联工单历史。
// 风格对齐批次 B（inspection.ts 转单写法）：withTenantClient 注入租户/RLS；写操作 requireConfigRole。
// 转单复用 services/linkedWorkOrder（资产故障 → 标准维修工单，进入既有派单流）。
// 契约：DB status 枚举 = in_use/repairing/standby/disabled；前端映射中文，禁止中文入库。
import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requireConfigRole } from '../middleware/role.js';
import { createLinkedWorkOrder } from '../services/linkedWorkOrder.js';
import { summarizeLinkedOrders } from '../services/assetHistory.js';

const router = Router();

const ASSET_STATUS = ['in_use', 'repairing', 'standby', 'disabled'] as const;
const assetSchema = z.object({
  name: z.string().min(1),
  model: z.string().optional(),
  pinyin: z.string().optional(),
  location: z.string().optional(),
  status: z.enum(ASSET_STATUS).optional(),
  has_sno: z.boolean().optional(),
  sno: z.string().optional(),
  // P1 资产完整化
  financial_category: z.string().optional(),
  purchase_date: z.string().optional(),
  price: z.number().nonnegative().optional(),
  supplier: z.string().optional(),
});

router.get('/assets', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { name, pinyin, location, status } = req.query as Record<string, string>;
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      clauses.push(sql.replace('?', `$${params.length}`));
    };
    if (name) add('name ILIKE ?', `%${name}%`);
    if (pinyin) add('pinyin ILIKE ?', `%${pinyin}%`);
    if (location) add('location = ?', location);
    if (status) add('status = ?', status);
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT * FROM asset WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params)
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.post('/assets', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = assetSchema.parse(req.body);
    const id = randomUUID();
    const item = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `INSERT INTO asset (tenant_id, asset_no, name, model, pinyin, location, status, has_sno, sno, qr_code, financial_category, purchase_date, price, supplier)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
          [
            tenantId,
            `ASSET-${id.slice(0, 8).toUpperCase()}`, // 建档即生成可读资产编号
            b.name,
            b.model ?? null,
            b.pinyin ?? null,
            b.location ?? null,
            b.status ?? 'in_use',
            b.has_sno ?? false,
            b.sno ?? null,
            `ASSET:${id}`, // 二维码内容（前端展示，扫码真机【部署后补验】）
            b.financial_category ?? null,
            b.purchase_date ?? null,
            b.price ?? null,
            b.supplier ?? null,
          ],
        )
        .then((r) => r.rows[0]),
    );
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.put('/assets/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = assetSchema.partial().parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM asset WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'asset not found', 404);
      const sets: string[] = [];
      const params: unknown[] = [req.params.id, tenantId];
      const set = (col: string, v: unknown) => {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      };
      if (b.name !== undefined) set('name', b.name);
      if (b.model !== undefined) set('model', b.model);
      if (b.pinyin !== undefined) set('pinyin', b.pinyin);
      if (b.location !== undefined) set('location', b.location);
      if (b.status !== undefined) set('status', b.status);
      if (b.has_sno !== undefined) set('has_sno', b.has_sno);
      if (b.sno !== undefined) set('sno', b.sno);
      if (b.financial_category !== undefined) set('financial_category', b.financial_category);
      if (b.purchase_date !== undefined) set('purchase_date', b.purchase_date);
      if (b.price !== undefined) set('price', b.price);
      if (b.supplier !== undefined) set('supplier', b.supplier);
      if (sets.length === 0) return cur.rows[0];
      sets.push('updated_at = now()');
      const r = await client.query(
        `UPDATE asset SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        params,
      );
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.post('/assets/:id/transfer', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ location: z.string().min(1) }).parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM asset WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'asset not found', 404);
      const r = await client.query(
        `UPDATE asset SET location=$3, updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        [req.params.id, tenantId, b.location],
      );
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 故障报修 → 转标准维修工单（进入既有派单流）；同时维护 linked_order_ids 供 history 反查
router.post('/assets/:id/fault', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = z
      .object({
        title: z.string().optional(),
        description: z.string().optional(),
        location: z.string().optional(),
      })
      .parse(req.body);
    const result = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM asset WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'asset not found', 404);
      const a = cur.rows[0];
      const wo = await createLinkedWorkOrder(client, {
        id: randomUUID(),
        tenantId,
        businessType: 'repair',
        catalog: 'repair',
        priority: 'normal',
        title: b.title ?? `资产故障报修·${a.name}`,
        description: b.description ?? `资产(${a.asset_no ?? a.name})故障报修`,
        location: b.location ?? a.location ?? undefined,
        sourceType: 'asset',
        sourceId: a.id,
      });
      const ids: string[] = Array.isArray(a.linked_order_ids) ? a.linked_order_ids : [];
      if (!ids.includes(wo.id)) ids.push(wo.id);
      await client.query(
        `UPDATE asset SET linked_order_ids=$3, status='repairing', updated_at=now() WHERE id=$1 AND tenant_id=$2`,
        [a.id, tenantId, ids],
      );
      return wo;
    });
    return res.json({ ok: true, code: 0, result });
  } catch (e) {
    next(e);
  }
});

// 关联工单历史（只读聚合）：读 work_orders WHERE id = ANY(linked_order_ids)
router.get('/assets/:id/history', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const rows = await withTenantClient(tenantId, async (client) => {
      const a = await client.query(`SELECT linked_order_ids FROM asset WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (a.rowCount === 0) throw new AppError('NOT_FOUND', 'asset not found', 404);
      const ids = a.rows[0].linked_order_ids ?? [];
      if (!Array.isArray(ids) || ids.length === 0) return [];
      const r = await client.query(
        `SELECT id, order_no, business_type, status, created_at FROM work_orders WHERE id = ANY($1) AND tenant_id=$2`,
        [ids, tenantId],
      );
      return r.rows;
    });
    return res.json({ ok: true, code: 0, items: summarizeLinkedOrders(rows) });
  } catch (e) {
    next(e);
  }
});

// ============ P1：CSV 导入导出 ============
function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\r') { /* skip */ }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  if (rows.length && rows[0][0] && rows[0][0].startsWith('﻿')) rows[0][0] = rows[0][0].slice(1);
  return rows;
}
const ASSET_CSV_HEADER = ['asset_no', 'name', 'model', 'location', 'status', 'financial_category', 'purchase_date', 'price', 'supplier', 'sno'];

router.get('/assets/export', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client.query(`SELECT * FROM asset WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId]).then((r) => r.rows),
    );
    const lines = [ASSET_CSV_HEADER.join(',')];
    for (const row of items) lines.push(ASSET_CSV_HEADER.map((h) => csvCell(row[h])).join(','));
    const csv = '﻿' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="assets_${Date.now()}.csv"`);
    return res.send(csv);
  } catch (e) { next(e); }
});

router.post('/assets/import', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const csv = (req.body?.csv as string) || '';
    const rows = parseCsv(csv);
    if (rows.length < 2) throw new AppError('EMPTY', 'CSV 无数据行', 400);
    const header = rows[0].map((h) => h.trim());
    if (!header.includes('name')) throw new AppError('HEADER', '缺少必填列: name', 400);
    let inserted = 0;
    for (const r of rows.slice(1)) {
      if (r.every((c) => !c.trim())) continue;
      const obj: Record<string, string> = {};
      header.forEach((h, i) => { obj[h] = (r[i] ?? '').trim(); });
      if (!obj.name) continue;
      const id = randomUUID();
      await withTenantClient(tenantId, (client) =>
        client.query(
          `INSERT INTO asset (tenant_id, asset_no, name, model, location, status, financial_category, purchase_date, price, supplier, qr_code)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            tenantId,
            obj.asset_no || `ASSET-${id.slice(0, 8).toUpperCase()}`,
            obj.name,
            obj.model || null,
            obj.location || null,
            obj.status || 'in_use',
            obj.financial_category || null,
            obj.purchase_date || null,
            obj.price ? Number(obj.price) : null,
            obj.supplier || null,
            `ASSET:${id}`,
          ],
        ),
      );
      inserted++;
    }
    return res.json({ ok: true, code: 0, inserted });
  } catch (e) { next(e); }
});

// ============ P1：维保历史 ============
router.get('/assets/:id/maintenance', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT * FROM asset_maintenance WHERE tenant_id=$1 AND asset_id=$2 ORDER BY maintain_date DESC NULLS LAST`, [tenantId, req.params.id])
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) { next(e); }
});

router.post('/assets/:id/maintenance', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({
      maintain_date: z.string().optional(),
      type: z.string().optional(),
      cost: z.number().nonnegative().optional(),
      vendor: z.string().optional(),
      note: z.string().optional(),
    }).parse(req.body);
    const id = randomUUID();
    const item = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `INSERT INTO asset_maintenance (id, tenant_id, asset_id, maintain_date, type, cost, vendor, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [id, tenantId, req.params.id, b.maintain_date ?? null, b.type ?? null, b.cost ?? null, b.vendor ?? null, b.note ?? null],
        )
        .then((r) => r.rows[0]),
    );
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) { next(e); }
});

router.put('/assets/maintenance/:mid', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({
      maintain_date: z.string().optional(),
      type: z.string().optional(),
      cost: z.number().nonnegative().optional(),
      vendor: z.string().optional(),
      note: z.string().optional(),
    }).partial().parse(req.body);
    const sets: string[] = [];
    const params: unknown[] = [req.params.mid, tenantId];
    const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
    if (b.maintain_date !== undefined) set('maintain_date', b.maintain_date);
    if (b.type !== undefined) set('type', b.type);
    if (b.cost !== undefined) set('cost', b.cost);
    if (b.vendor !== undefined) set('vendor', b.vendor);
    if (b.note !== undefined) set('note', b.note);
    sets.push('updated_at = now()');
    const item = await withTenantClient(tenantId, (client) =>
      client.query(`UPDATE asset_maintenance SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING *`, params).then((r) => r.rows[0] ?? null),
    );
    if (!item) throw new AppError('NOT_FOUND', 'maintenance not found', 404);
    return res.json({ ok: true, code: 0, item });
  } catch (e) { next(e); }
});

router.delete('/assets/maintenance/:mid', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const r = await withTenantClient(tenantId, (client) =>
      client.query(`DELETE FROM asset_maintenance WHERE id=$1 AND tenant_id=$2`, [req.params.mid, tenantId]),
    );
    if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'maintenance not found', 404);
    return res.json({ ok: true, code: 0 });
  } catch (e) { next(e); }
});

export default router;
