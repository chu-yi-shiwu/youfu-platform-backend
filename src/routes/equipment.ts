// 设备管理模块（P4）：设备 / 设备类型 / 设备厂商 三类主数据。
// 通用 CRUD + CSV 导入导出；RLS 铁底线（withTenantClient 注入 tenant_id）；
// 写操作 requirePermission('equipment.manage')（T8 第三批：由角色白名单收敛到权限点）。
// 契约形态对齐 basicData.ts（{ ok, code, items / item }），与前端 EquipmentPage.tsx 配套。
// 对齐 UOne C 族（equipment / type / company）。
import { Router } from 'express';
import { withRowSavepoint } from '../services/rowSavepoint.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requirePermission } from '../middleware/role.js';
import { parseCsv, csvHeader, csvRowLine, csvHeaderMap, csvParseRow, csvDateOnly, type CsvField } from '../services/csvUtil.js';

const router = Router();

type FieldDef = {
  key: string;
  label: string;
  /**
   * 列类型提示（仅用于搜索表达式生成，默认 text）。
   * P0-8（2026-11-07）：equipment.type_id/vendor_id 是 UUID、purchase_date 是 DATE、price 是
   * NUMERIC，旧实现对所有字段一律 `${col} ILIKE $n` → PostgreSQL 报
   * `operator does not exist: uuid ~~* unknown`，用户一点搜索就 500。
   * 非文本列先 ::text 再 ILIKE，既保留模糊搜索能力，又不依赖隐式转换。
   */
  kind?: 'text' | 'uuid' | 'date' | 'numeric';
};
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
      { key: 'type_id', label: '设备类型', kind: 'uuid' },
      { key: 'vendor_id', label: '设备厂商', kind: 'uuid' },
      { key: 'model', label: '型号' },
      { key: 'sn', label: '序列号' },
      { key: 'location', label: '安装位置' },
      { key: 'status', label: '状态' },
      { key: 'purchase_date', label: '购置日期', kind: 'date' },
      { key: 'price', label: '购置金额', kind: 'numeric' },
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
      status: z.string().optional().default('in_use'), // 与 DB NOT NULL DEFAULT 'in_use' 对齐，避免未传时显式写入 NULL 触发 23502
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

/**
 * 生成单列搜索表达式（P0-8，单一事实源）。
 * 文本列直接 ILIKE；uuid/date/numeric 先 ::text 再 ILIKE，避免
 * `operator does not exist: uuid ~~* unknown` 之类的类型错误（用户搜索即 500）。
 */
export function equipmentSearchExpr(f: FieldDef, paramRef: string): string {
  const cast = f.kind && f.kind !== 'text' ? '::text' : '';
  return `${f.key}${cast} ILIKE ${paramRef}`;
}

/**
 * 计算应插入的列：仅保留「已提供且非空」的列，省略未提供/空值列，
 * 让 DB 的 DEFAULT / NOT NULL DEFAULT（如 equipment.status 默认 'in_use'）生效。
 * 避免对 NOT NULL 列强行写 NULL 触发 23502，也与 basicData.ts 导入逻辑保持一致。
 * POST 单条创建与 CSV 批量导入共用此函数（单一真相源）。
 */
export function resolveInsertColumns(def: TypeDef, src: Record<string, unknown>): string[] {
  return def.insertCols.filter((c) => src[c] !== undefined && src[c] !== null && src[c] !== '');
}

// ============ 设备维保（P3b）：按设备挂维保计划与记录 ============
// 注意：维保路由必须在通用 /equipment/:type/:id 之前注册，否则 Express 会优先匹配通用路由。
const maintenanceSchema = z.object({
  mtype: z.enum(['maintain', 'repair', 'inspect']).default('maintain'),
  plan_date: z.string().optional(),
  done_date: z.string().optional(),
  cost: z.union([z.number(), z.string()]).optional(),
  responsible: z.string().optional(),
  note: z.string().optional(),
  photos: z.array(z.string()).optional(),
});

// 维保列表（按设备）
router.get('/equipment/:eqId/maintenances', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT * FROM equipment_maintenance WHERE equipment_id=$1 AND tenant_id=$2 ORDER BY plan_date DESC NULLS LAST, created_at DESC`,
          [req.params.eqId, tenantId],
        )
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// 新建维保
router.post('/equipment/:eqId/maintenances', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = maintenanceSchema.parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'equipment.manage');
      const cur = await client.query('SELECT id FROM equipment WHERE id=$1 AND tenant_id=$2', [req.params.eqId, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'equipment not found', 404);
      const r = await client.query(
        `INSERT INTO equipment_maintenance (tenant_id, equipment_id, mtype, plan_date, done_date, cost, responsible, note, photos)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          tenantId, req.params.eqId, b.mtype, b.plan_date ?? null, b.done_date ?? null,
          b.cost ?? 0, b.responsible ?? null, b.note ?? null, b.photos ?? null,
        ],
      );
      return r.rows[0];
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 更新维保
router.put('/equipment/maintenances/:id', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = maintenanceSchema.partial().parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'equipment.manage');
      const cur = await client.query('SELECT * FROM equipment_maintenance WHERE id=$1 AND tenant_id=$2', [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'maintenance not found', 404);
      const sets: string[] = [];
      const params: unknown[] = [req.params.id, tenantId];
      const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
      if (b.mtype !== undefined) set('mtype', b.mtype);
      if (b.plan_date !== undefined) set('plan_date', b.plan_date);
      if (b.done_date !== undefined) set('done_date', b.done_date);
      if (b.cost !== undefined) set('cost', b.cost);
      if (b.responsible !== undefined) set('responsible', b.responsible);
      if (b.note !== undefined) set('note', b.note);
      if (b.photos !== undefined) set('photos', b.photos);
      if (sets.length === 0) return cur.rows[0];
      sets.push('updated_at = now()');
      const r = await client.query(
        `UPDATE equipment_maintenance SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        params,
      );
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 删除维保
router.delete('/equipment/maintenances/:id', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const r = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'equipment.manage');
      return client.query('DELETE FROM equipment_maintenance WHERE id=$1 AND tenant_id=$2', [req.params.id, tenantId]);
    });
    if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'maintenance not found', 404);
    return res.json({ ok: true, code: 0, deleted: r.rowCount });
  } catch (e) {
    next(e);
  }
});

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
      // P0-8：按字段类型生成搜索表达式（uuid/date/numeric 不能直接 ILIKE）。
      const ref = `$${params.length + 1}`;
      const ors = def.fields.map((f) => equipmentSearchExpr(f, ref)).join(' OR ');
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
    const def = getType(req.params.type);
    const tenantId = res.locals.auth.tenantId;
    const b = def.schema.parse(req.body);
    const id = randomUUID();
    // 仅插入「请求提供了」的列：未提供的列省略，让 DB 的 DEFAULT 生效
    //（若显式传 NULL 会覆盖 NOT NULL DEFAULT 列，如 equipment.status → 违反约束）
    const provided = resolveInsertColumns(def, b as any);
    const cols = ['id', 'tenant_id', ...provided];
    const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
    const vals = [id, tenantId, ...provided.map((c) => (b as any)[c])];
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'equipment.manage');
      return client
        .query(`INSERT INTO ${def.table} (${cols.join(', ')}) VALUES (${ph}) RETURNING *`, vals)
        .then((r) => r.rows[0]);
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// ============ 更新 ============
router.put('/equipment/:type/:id', async (req, res, next) => {
  try {
    const def = getType(req.params.type);
    const tenantId = res.locals.auth.tenantId;
    const b = (def.schema as z.ZodObject<any>).partial().parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'equipment.manage');
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
    const def = getType(req.params.type);
    const tenantId = res.locals.auth.tenantId;
    const r = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'equipment.manage');
      return client.query(`DELETE FROM ${def.table} WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
    });
    if (r.rowCount === 0) throw new AppError('NOT_FOUND', `${def.table} not found`, 404);
    return res.json({ ok: true, code: 0, deleted: r.rowCount });
  } catch (e) {
    next(e);
  }
});

// ============ CSV 导出 ============
const EQUIP_STATUS_CN: Record<string, string> = {
  in_use: '在用', idle: '闲置', repair: '维修中', repairing: '维修中', scrapped: '报废', disabled: '停用',
};
const EQUIP_STATUS_FROM_CN: Record<string, string> = {
  在用: 'in_use', 闲置: 'idle', 维修中: 'repair', 报废: 'scrapped', 停用: 'disabled',
};

function equipCsvFields(
  def: TypeDef,
  type: string,
  typeName: Map<string, string>,
  vendorName: Map<string, string>,
): CsvField[] {
  return def.fields.map((f) => {
    if (type === 'equipment' && f.key === 'type_id') {
      return { key: f.key, label: f.label, export: (r: any) => typeName.get(String(r.type_id)) || '' };
    }
    if (type === 'equipment' && f.key === 'vendor_id') {
      return { key: f.key, label: f.label, export: (r: any) => vendorName.get(String(r.vendor_id)) || '' };
    }
    if (type === 'equipment' && f.key === 'status') {
      return {
        key: f.key, label: f.label,
        export: (r: any) => EQUIP_STATUS_CN[r.status] || r.status || '',
        parse: (v: string) => EQUIP_STATUS_FROM_CN[v] || v || undefined,
      };
    }
    if (f.key === 'purchase_date') {
      return { key: f.key, label: f.label, export: (r: any) => csvDateOnly(r.purchase_date) };
    }
    return { key: f.key, label: f.label };
  });
}

async function loadEquipNames(client: any, tenantId: string): Promise<{ type: Map<string, string>; vendor: Map<string, string>; typeId: Map<string, string>; vendorId: Map<string, string> }> {
  const typeRows = (await client.query(`SELECT id, code, name FROM equipment_type WHERE tenant_id=$1`, [tenantId])).rows;
  const vendorRows = (await client.query(`SELECT id, code, name FROM equipment_vendor WHERE tenant_id=$1`, [tenantId])).rows;
  const type = new Map<string, string>();
  const typeId = new Map<string, string>();
  for (const r of typeRows) {
    type.set(String(r.id), String(r.name));
    typeId.set(String(r.name), String(r.id));
    if (r.code) typeId.set(String(r.code), String(r.id));
  }
  const vendor = new Map<string, string>();
  const vendorId = new Map<string, string>();
  for (const r of vendorRows) {
    vendor.set(String(r.id), String(r.name));
    vendorId.set(String(r.name), String(r.id));
    if (r.code) vendorId.set(String(r.code), String(r.id));
  }
  return { type, vendor, typeId, vendorId };
}

router.get('/equipment/:type/export', async (req, res, next) => {
  try {
    const def = getType(req.params.type);
    const tenantId = res.locals.auth.tenantId;
    const result = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'equipment.manage');
      const items = await client.query(`SELECT * FROM ${def.table} WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId]).then((r) => r.rows);
      const names = req.params.type === 'equipment' ? await loadEquipNames(client, tenantId) : { type: new Map(), vendor: new Map(), typeId: new Map(), vendorId: new Map() };
      return { items, names };
    });
    const fields = equipCsvFields(def, req.params.type, result.names.type, result.names.vendor);
    const lines = [csvHeader(fields)];
    for (const row of result.items) lines.push(csvRowLine(row, fields));
    const csv = '﻿' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${def.table}.csv"`);
    return res.send(csv);
  } catch (e) {
    next(e);
  }
});

// ============ CSV 导入 ============
router.post('/equipment/:type/import', async (req, res, next) => {
  try {
    const def = getType(req.params.type);
    const tenantId = res.locals.auth.tenantId;
    const text = typeof req.body === 'string' ? req.body : (req.body as any)?.csv;
    if (!text || typeof text !== 'string') throw new AppError('BAD_INPUT', 'csv text required', 400);
    const rows = parseCsv(text);
    if (rows.length < 2) return res.json({ ok: true, code: 0, inserted: 0, skipped: 0, errors: [] });
    if (rows.length - 1 > 2000) throw new AppError('BAD_INPUT', '单次导入最多 2000 行，请拆分后分批导入', 400);
    let inserted = 0;
    const errors: Array<{ row: number; reason: string }> = [];
    await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'equipment.manage');
      const names = req.params.type === 'equipment' ? await loadEquipNames(client, tenantId) : null;
      const fields = equipCsvFields(def, req.params.type, names?.type ?? new Map(), names?.vendor ?? new Map());
      const headerMap = csvHeaderMap(rows[0], fields);
      const dataRows = rows.slice(1);
      for (let i = 0; i < dataRows.length; i++) {
        const obj = csvParseRow(dataRows[i], headerMap);
        if (req.params.type === 'equipment') {
          const typeName = String(obj.type_id ?? '').trim();
          const vendorName = String(obj.vendor_id ?? '').trim();
          if (typeName) obj.type_id = names!.typeId.get(typeName) ?? (typeName.length === 36 ? typeName : undefined);
          if (vendorName) obj.vendor_id = names!.vendorId.get(vendorName) ?? (vendorName.length === 36 ? vendorName : undefined);
          if (typeName && !obj.type_id) { errors.push({ row: i + 2, reason: `设备类型不存在：${typeName}` }); continue; }
          if (vendorName && !obj.vendor_id) { errors.push({ row: i + 2, reason: `设备厂商不存在：${vendorName}` }); continue; }
        }
        if (!obj.name) { errors.push({ row: i + 2, reason: '缺少名称' }); continue; }
        try {
          await withRowSavepoint(client, async () => {
            const id = randomUUID();
            const provided = resolveInsertColumns(def, obj);
            const cols = ['id', 'tenant_id', ...provided];
            const ph = cols.map((_, n) => `$${n + 1}`).join(', ');
            const vals = [id, tenantId, ...provided.map((c) => obj[c])];
            await client.query(`INSERT INTO ${def.table} (${cols.join(', ')}) VALUES (${ph})`, vals);
          });
          inserted++;
        } catch (e: any) {
          errors.push({ row: i + 2, reason: e?.message || '写入失败' });
        }
      }
    });
    return res.json({ ok: true, code: 0, inserted, skipped: errors.length, errors: errors.slice(0, 20) });
  } catch (e) {
    next(e);
  }
});

export default router;
