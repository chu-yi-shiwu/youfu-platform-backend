// 设备管理模块（P4）：设备 / 设备类型 / 设备厂商 三类主数据。
// 通用 CRUD + CSV 导入导出；RLS 铁底线（withTenantClient 注入 tenant_id）；写操作 requireConfigRole。
// 契约形态对齐 basicData.ts（{ ok, code, items / item }），与前端 EquipmentPage.tsx 配套。
// 对齐 UOne C 族（equipment / type / company）。
import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requireConfigRole } from '../middleware/role.js';

const router = Router();

type FieldDef = { key: string; label: string };
type TypeDef = {
  table: string;
  columns: string[];
  insertCols: string[];
  fields: FieldDef[];
  schema: z.ZodType<any>;
};

const TYPES: Record<string, TypeDef> = {
  // 设备档案：引用 类型/厂商（UUID 以字符串透传）
  equipment: {
    table: 'equipment',
    columns: [
      'id', 'tenant_id', 'name', 'code', 'type_id', 'vendor_id', 'model', 'sn',
      'location', 'status', 'purchase_date', 'price', 'responsible', 'remark',
      'created_at', 'updated_at',
    ],
    insertCols: [
      'name', 'code', 'type_id', 'vendor_id', 'model', 'sn',
      'location', 'status', 'purchase_date', 'price', 'responsible', 'remark',
    ],
    fields: [
      { key: 'name', label: '设备名称' },
      { key: 'code', label: '设备编号' },
      { key: 'type_id', label: '设备类型' },
      { key: 'vendor_id', label: '设备厂商' },
      { key: 'model', label: '型号' },
      { key: 'sn', label: '序列号' },
      { key: 'location', label: '安装位置' },
      { key: 'status', label: '状态' },
      { key: 'purchase_date', label: '购置日期' },
      { key: 'price', label: '购置金额' },
      { key: 'responsible', label: '责任人' },
      { key: 'remark', label: '备注' },
    ],
    schema: z.object({
      name: z.string().min(1),
      code: z.string().optional(),
      type_id: z.string().optional(),
      vendor_id: z.string().optional(),
      model: z.string().optional(),
      sn: z.string().optional(),
      location: z.string().optional(),
      status: z.string().optional(),
      purchase_date: z.string().optional(),
      price: z.union([z.number(), z.string()]).optional(),
      responsible: z.string().optional(),
      remark: z.string().optional(),
    }),
  },
  // 设备类型（字典）
  type: {
    table: 'equipment_type',
    columns: ['id', 'tenant_id', 'code', 'name', 'remark', 'created_at', 'updated_at'],
    insertCols: ['code', 'name', 'remark'],
    fields: [
      { key: 'code', label: '编码' },
      { key: 'name', label: '类型名称' },
      { key: 'remark', label: '备注' },
    ],
    schema: z.object({
      code: z.string().min(1),
      name: z.string().min(1),
      remark: z.string().optional(),
    }),
  },
  // 设备厂商（字典）
  vendor: {
    table: 'equipment_vendor',
    columns: ['id', 'tenant_id', 'code', 'name', 'contact_person', 'phone', 'address', 'remark', 'created_at', 'updated_at'],
    insertCols: ['code', 'name', 'contact_person', 'phone', 'address', 'remark'],
    fields: [
      { key: 'code', label: '编码' },
      { key: 'name', label: '厂商名称' },
      { key: 'contact_person', label: '联系人' },
      { key: 'phone', label: '电话' },
      { key: 'address', label: '地址' },
      { key: 'remark', label: '备注' },
    ],
    schema: z.object({
      code: z.string().min(1),
      name: z.string().min(1),
      contact_person: z.string().optional(),
      phone: z.string().optional(),
      address: z.string().optional(),
      remark: z.string().optional(),
    }),
  },
};

function getType(t: string): TypeDef {
  const d = TYPES[t];
  if (!d) throw new AppError('BAD_TYPE', `unknown equipment type: ${t}`, 400);
  return d;
}

// ============ 列表（支持名称/关键字搜索）============
router.get('/equipment/:type', async (req, res, next) => {
  try {
    const def = getType(req.params.type);
    const tenantId = res.locals.auth.tenantId;
    const q = (req.query.q as string) || '';
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    if (q) {
      const like = `%${q}%`;
      const searchCols = def.fields.map((f) => f.key);
      const ors = searchCols.map((c) => `${c} ILIKE $${params.length + 1}`).join(' OR ');
      params.push(like);
      clauses.push(`(${ors})`);
    }
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT * FROM ${def.table} WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params)
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// ============ 新建 ============
router.post('/equipment/:type', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const def = getType(req.params.type);
    const tenantId = res.locals.auth.tenantId;
    const b = def.schema.parse(req.body);
    const id = randomUUID();
    const cols = ['id', 'tenant_id', ...def.insertCols];
    const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
    const vals = [id, tenantId, ...def.insertCols.map((c) => (b as any)[c] ?? null)];
    const item = await withTenantClient(tenantId, (client) =>
      client
        .query(`INSERT INTO ${def.table} (${cols.join(', ')}) VALUES (${ph}) RETURNING *`, vals)
        .then((r) => r.rows[0]),
    );
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// ============ 更新 ============
router.put('/equipment/:type/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const def = getType(req.params.type);
    const tenantId = res.locals.auth.tenantId;
    const b = (def.schema as z.ZodObject<any>).partial().parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM ${def.table} WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', `${def.table} not found`, 404);
      const sets: string[] = [];
      const params: unknown[] = [req.params.id, tenantId];
      const set = (col: string, v: unknown) => {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      };
      for (const c of def.insertCols) {
        const v = (b as any)[c];
        if (v !== undefined) set(c, v);
      }
      if (sets.length === 0) return cur.rows[0];
      sets.push('updated_at = now()');
      const r = await client.query(
        `UPDATE ${def.table} SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        params,
      );
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// ============ 删除 ============
router.delete('/equipment/:type/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const def = getType(req.params.type);
    const tenantId = res.locals.auth.tenantId;
    const r = await withTenantClient(tenantId, (client) =>
      client.query(`DELETE FROM ${def.table} WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]),
    );
    if (r.rowCount === 0) throw new AppError('NOT_FOUND', `${def.table} not found`, 404);
    return res.json({ ok: true, code: 0, deleted: r.rowCount });
  } catch (e) {
    next(e);
  }
});

// ============ CSV 导出 ============
router.get('/equipment/:type/export', async (req, res, next) => {
  try {
    const def = getType(req.params.type);
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client.query(`SELECT * FROM ${def.table} WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId]).then((r) => r.rows),
    );
    const headers = def.insertCols;
    const escape = (v: unknown) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(',')];
    for (const row of items) lines.push(headers.map((h) => escape(row[h])).join(','));
    const csv = '﻿' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${def.table}.csv"`);
    return res.send(csv);
  } catch (e) {
    next(e);
  }
});

// ============ CSV 导入 ============
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

router.post('/equipment/:type/import', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const def = getType(req.params.type);
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
        headers.forEach((h, i) => {
          if (def.insertCols.includes(h)) obj[h] = r[i] ?? null;
        });
        if (!obj.name) continue; // 名称必填，跳过空行
        const id = randomUUID();
        const cols = ['id', 'tenant_id', ...def.insertCols];
        const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
        const vals = [id, tenantId, ...def.insertCols.map((c) => obj[c] ?? null)];
        await client.query(`INSERT INTO ${def.table} (${cols.join(', ')}) VALUES (${ph})`, vals);
        inserted++;
      }
    });
    return res.json({ ok: true, code: 0, inserted });
  } catch (e) {
    next(e);
  }
});

export default router;
