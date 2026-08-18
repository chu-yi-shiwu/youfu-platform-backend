// P1 基础数据模块：区域 / 联系人 / 供应商 三类主数据的通用 CRUD + CSV 导入导出。
// 风格对齐 asset.ts：withTenantClient 注入租户/RLS；写操作 requireConfigRole；返回 {ok,code,items/item}。
import { Router } from 'express';
import { randomUUID } from 'crypto';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requireConfigRole } from '../middleware/role.js';

const router = Router();

interface FieldDef {
  key: string;
  required?: boolean;
}
interface EntityDef {
  table: string;
  searchField: string;
  fields: FieldDef[];
}

const entityDefs: Record<string, EntityDef> = {
  region: {
    table: 'region',
    searchField: 'name',
    fields: [
      { key: 'name', required: true },
      { key: 'code' },
      { key: 'parent_id' },
      { key: 'remark' },
    ],
  },
  contact: {
    table: 'contact',
    searchField: 'name',
    fields: [
      { key: 'name', required: true },
      { key: 'phone' },
      { key: 'email' },
      { key: 'org' },
      { key: 'dept' },
      { key: 'remark' },
    ],
  },
  supplier: {
    table: 'supplier',
    searchField: 'name',
    fields: [
      { key: 'name', required: true },
      { key: 'contact_person' },
      { key: 'phone' },
      { key: 'address' },
      { key: 'category' },
      { key: 'remark' },
    ],
  },
};

function getDef(type: string): EntityDef {
  const def = entityDefs[type];
  if (!def) throw new AppError('BAD_TYPE', `unknown basic-data type: ${type}`, 400);
  return def;
}

// 列表（支持按名称搜索）
router.get('/:type', async (req, res, next) => {
  try {
    const def = getDef(req.params.type);
    const tenantId = res.locals.auth.tenantId;
    const { q } = req.query as Record<string, string>;
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    if (q) {
      params.push(`%${q}%`);
      clauses.push(`${def.searchField} ILIKE $${params.length}`);
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

// CSV 导出（须认证；返回 text/csv 带 BOM）
router.get('/:type/export', async (req, res, next) => {
  try {
    const def = getDef(req.params.type);
    const tenantId = res.locals.auth.tenantId;
    const items: Record<string, unknown>[] = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT * FROM ${def.table} WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId])
        .then((r) => r.rows),
    );
    const header = ['id', ...def.fields.map((f) => f.key)];
    const lines = [header.join(',')];
    for (const row of items) {
      lines.push(header.map((h) => csvCell(String(row[h] ?? ''))).join(','));
    }
    const csv = '﻿' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.type}_${Date.now()}.csv"`);
    return res.send(csv);
  } catch (e) {
    next(e);
  }
});

// 创建
router.post('/:type', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const def = getDef(req.params.type);
    const tenantId = res.locals.auth.tenantId;
    const body = req.body as Record<string, unknown>;
    for (const f of def.fields) {
      if (f.required && !(body[f.key] && String(body[f.key]).trim())) {
        throw new AppError('VALIDATION', `${f.key} 必填`, 400);
      }
    }
    const cols = ['tenant_id', ...def.fields.map((f) => f.key)];
    const vals: unknown[] = [tenantId];
    for (const f of def.fields) vals.push((body[f.key] ?? null) as unknown);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const item = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `INSERT INTO ${def.table} (${cols.join(', ')}, id) VALUES (${placeholders}, $${cols.length + 1}) RETURNING *`,
          [...vals, randomUUID()],
        )
        .then((r) => r.rows[0]),
    );
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// CSV 导入（body: { csv } 文本，含表头首行）
router.post('/:type/import', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const def = getDef(req.params.type);
    const tenantId = res.locals.auth.tenantId;
    const csv = (req.body?.csv as string) || '';
    const rows = parseCsv(csv);
    if (rows.length < 2) throw new AppError('EMPTY', 'CSV 无数据行', 400);
    const header = rows[0].map((h) => h.trim());
    const missing = def.fields.filter((f) => f.required && !header.includes(f.key));
    if (missing.length) throw new AppError('HEADER', `缺少必填列: ${missing.map((m) => m.key).join(',')}`, 400);
    let inserted = 0;
    for (const r of rows.slice(1)) {
      if (r.length === 1 && !r[0].trim()) continue; // 空行
      if (r.every((c) => !c.trim())) continue;
      const obj: Record<string, string> = {};
      header.forEach((h, i) => {
        obj[h] = (r[i] ?? '').trim();
      });
      const realCols = ['tenant_id'];
      const vals: unknown[] = [tenantId];
      for (const f of def.fields) {
        if (obj[f.key] !== undefined) {
          realCols.push(f.key);
          vals.push(obj[f.key] || null);
        }
      }
      const placeholders = realCols.map((_, i) => `$${i + 1}`).join(', ');
      await withTenantClient(tenantId, (client) =>
        client.query(
          `INSERT INTO ${def.table} (${realCols.join(', ')}, id) VALUES (${placeholders}, $${realCols.length + 1})`,
          [...vals, randomUUID()],
        ),
      );
      inserted++;
    }
    return res.json({ ok: true, code: 0, inserted });
  } catch (e) {
    next(e);
  }
});

// 更新
router.put('/:type/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const def = getDef(req.params.type);
    const tenantId = res.locals.auth.tenantId;
    const body = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const params: unknown[] = [req.params.id, tenantId];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    for (const f of def.fields) {
      if (body[f.key] !== undefined) set(f.key, body[f.key] ?? null);
    }
    let item: Record<string, unknown> | null = null;
    if (sets.length === 0) {
      item = await withTenantClient(tenantId, (client) =>
        client
          .query(`SELECT * FROM ${def.table} WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId])
          .then((r) => r.rows[0] ?? null),
      );
    } else {
      sets.push('updated_at = now()');
      item = await withTenantClient(tenantId, (client) =>
        client
          .query(`UPDATE ${def.table} SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING *`, params)
          .then((r) => r.rows[0] ?? null),
      );
    }
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 删除
router.delete('/:type/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const def = getDef(req.params.type);
    const tenantId = res.locals.auth.tenantId;
    const r = await withTenantClient(tenantId, (client) =>
      client.query(`DELETE FROM ${def.table} WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]),
    );
    if (r.rowCount === 0) throw new AppError('NOT_FOUND', `${req.params.type} not found`, 404);
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

// ---- CSV 工具 ----
function csvCell(v: string): string {
  if (/[",\r\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
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
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') {
        row.push(cur);
        cur = '';
      } else if (ch === '\r') {
        /* skip */
      } else if (ch === '\n') {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = '';
      } else cur += ch;
    }
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  if (rows.length && rows[0][0] && rows[0][0].startsWith('﻿')) rows[0][0] = rows[0][0].slice(1);
  return rows;
}

export default router;
