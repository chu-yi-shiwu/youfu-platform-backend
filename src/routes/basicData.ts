// 基础数据模块（P1 回归修复）：区域 / 联系人 / 供应商 三类主数据。
// 通用 CRUD + CSV 导入导出；RLS 铁底线（withTenantClient 注入 tenant_id）；写操作 requireConfigRole。
// 契约形态对齐 asset.ts（{ ok, code, items / item }），与前端 BasicData.tsx 配套。
import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requirePermission, requireConfigRole } from '../middleware/role.js';
import { parseCsv, csvEscape } from '../services/csvUtil.js';

const router = Router();

type FieldDef = { key: string; label: string };
type TypeDef = {
  table: string;
  columns: string[];
  insertCols: string[];
  fields: FieldDef[];
  schema: z.ZodType<any>;
  /** jsonb 列（CSV 导入时按 JSON 解析；导出时按 JSON 序列化） */
  jsonCols?: string[];
  /**
   * 可搜索的文本列（注册制批次一 P0-2 引擎修复①）：
   * GET 列表模糊搜索只对声明列做 ILIKE。未声明时回退为「schema 中 z.string() 类型的 fields key」，
   * 避免 uuid 列（如 location_dict.default_reporter_id）/numeric 列（如 priority_dict.sort）
   * 被 ILIKE → 42883/500。
   */
  searchCols?: string[];
  /**
   * code 列租户内唯一（有 DB 唯一索引背书）。POST 建档前先预检查重 → 409（P0-2 引擎修复②）。
   * 只对确有唯一索引的字典开启（location_dict/reporter_dict，055 迁移 ux_*_tenant_code）；
   * 既有 9 类字典的 code 无唯一索引（001 系列迁移实查），不开此开关以保持既有行为（红线）。
   */
  uniqueCode?: boolean;
};

// export 供测试/静态门禁断言「声明列必存在于迁移 DDL」不变式（M0-1 C 件配套），无运行时行为变更。
export const TYPES: Record<string, TypeDef> = {
  dept: {
    table: 'dept',
    columns: ['id', 'tenant_id', 'name', 'code', 'remark', 'created_at', 'updated_at'],
    insertCols: ['name', 'code', 'remark'],
    fields: [
      { key: 'name', label: '部门名称' },
      { key: 'code', label: '编码' },
      { key: 'remark', label: '备注' },
    ],
    schema: z.object({
      name: z.string().min(1),
      code: z.string().optional(),
      remark: z.string().optional(),
    }),
  },
  region: {
    table: 'region',
    columns: ['id', 'tenant_id', 'name', 'code', 'parent_id', 'remark', 'created_at', 'updated_at'],
    insertCols: ['name', 'code', 'parent_id', 'remark'],
    fields: [
      { key: 'name', label: '名称' },
      { key: 'code', label: '编码' },
      { key: 'parent_id', label: '上级区域ID' },
      { key: 'remark', label: '备注' },
    ],
    schema: z.object({
      name: z.string().min(1),
      code: z.string().optional(),
      parent_id: z.string().optional(),
      remark: z.string().optional(),
    }),
  },
  contact: {
    table: 'contact',
    columns: ['id', 'tenant_id', 'name', 'phone', 'email', 'org', 'dept', 'remark', 'created_at', 'updated_at'],
    insertCols: ['name', 'phone', 'email', 'org', 'dept', 'remark'],
    fields: [
      { key: 'name', label: '姓名' },
      { key: 'phone', label: '电话' },
      { key: 'email', label: '邮箱' },
      { key: 'org', label: '单位' },
      { key: 'dept', label: '部门' },
      { key: 'remark', label: '备注' },
    ],
    schema: z.object({
      name: z.string().min(1),
      phone: z.string().optional(),
      email: z.string().optional(),
      org: z.string().optional(),
      dept: z.string().optional(),
      remark: z.string().optional(),
    }),
  },
  supplier: {
    table: 'supplier',
    columns: ['id', 'tenant_id', 'name', 'contact_person', 'phone', 'address', 'category', 'remark', 'created_at', 'updated_at'],
    insertCols: ['name', 'contact_person', 'phone', 'address', 'category', 'remark'],
    fields: [
      { key: 'name', label: '名称' },
      { key: 'contact_person', label: '联系人' },
      { key: 'phone', label: '电话' },
      { key: 'address', label: '地址' },
      { key: 'category', label: '分类' },
      { key: 'remark', label: '备注' },
    ],
    schema: z.object({
      name: z.string().min(1),
      contact_person: z.string().optional(),
      phone: z.string().optional(),
      address: z.string().optional(),
      category: z.string().optional(),
      remark: z.string().optional(),
    }),
  },
  // ===== 批次 B 新增（047 迁移）=====
  equipment_type: {
    table: 'equipment_type',
    columns: ['id', 'tenant_id', 'name', 'code', 'remark', 'created_at', 'updated_at'],
    insertCols: ['name', 'code', 'remark'],
    fields: [
      { key: 'name', label: '类型名称' },
      { key: 'code', label: '编码' },
      { key: 'remark', label: '备注' },
    ],
    schema: z.object({
      name: z.string().min(1),
      code: z.string().optional(),
      remark: z.string().optional(),
    }),
  },
  equipment_brand: {
    table: 'equipment_brand',
    columns: ['id', 'tenant_id', 'name', 'code', 'remark', 'created_at', 'updated_at'],
    insertCols: ['name', 'code', 'remark'],
    fields: [
      { key: 'name', label: '厂商名称' },
      { key: 'code', label: '编码' },
      { key: 'remark', label: '备注' },
    ],
    schema: z.object({
      name: z.string().min(1),
      code: z.string().optional(),
      remark: z.string().optional(),
    }),
  },
  priority_dict: {
    table: 'priority_dict',
    columns: ['id', 'tenant_id', 'name', 'code', 'sort', 'color', 'remark', 'created_at', 'updated_at'],
    insertCols: ['name', 'code', 'sort', 'color', 'remark'],
    // numeric 列 sort 不可 ILIKE（P0-2 引擎修复①配套声明；回退逻辑也会排除 z.number()，双保险）
    searchCols: ['name', 'code', 'color', 'remark'],
    fields: [
      { key: 'name', label: '优先级名称' },
      { key: 'code', label: '编码' },
      { key: 'sort', label: '排序(小在前)' },
      { key: 'color', label: '颜色(red/orange)' },
      { key: 'remark', label: '备注' },
    ],
    schema: z.object({
      name: z.string().min(1),
      code: z.string().optional(),
      sort: z.number().optional(),
      color: z.string().optional(),
      remark: z.string().optional(),
    }),
  },
  sla_policy: {
    table: 'sla_policy',
    columns: ['id', 'tenant_id', 'name', 'entity_type', 'priority', 'response_hours', 'complete_hours', 'enabled', 'remark', 'created_at', 'updated_at'],
    insertCols: ['name', 'entity_type', 'priority', 'response_hours', 'complete_hours', 'enabled', 'remark'],
    fields: [
      { key: 'name', label: '策略名称' },
      { key: 'entity_type', label: '适用业务类型' },
      { key: 'priority', label: '适用优先级(空=全部)' },
      { key: 'response_hours', label: '响应时限(小时)' },
      { key: 'complete_hours', label: '完成时限(小时)' },
      { key: 'enabled', label: '启用' },
      { key: 'remark', label: '备注' },
    ],
    schema: z.object({
      name: z.string().min(1),
      entity_type: z.string().optional(),
      priority: z.string().optional(),
      // D11 修复（M0-2）：SLA 时限单位=小时，必须有界。0 会触发全量瞬时 SLA 升级+通知风暴
      //（slaScheduler 扫 sla_due_at=now），上限取 1 年（8760h）防误录。违反走统一 ZodError→422 details[].path。
      response_hours: z.number().gt(0).lte(8760).optional(),
      complete_hours: z.number().gt(0).lte(8760).optional(),
      enabled: z.boolean().optional(),
      remark: z.string().optional(),
    }),
  },
  work_order_template: {
    table: 'work_order_template',
    columns: ['id', 'tenant_id', 'name', 'entity_type', 'business_type', 'description', 'default_fields', 'enabled', 'created_at', 'updated_at'],
    insertCols: ['name', 'entity_type', 'business_type', 'description', 'default_fields', 'enabled'],
    fields: [
      { key: 'name', label: '模板名称' },
      { key: 'entity_type', label: '关联业务类型' },
      { key: 'business_type', label: '业务类型code' },
      { key: 'description', label: '说明' },
      { key: 'default_fields', label: '默认值(JSON)' },
      { key: 'enabled', label: '启用' },
    ],
    schema: z.object({
      name: z.string().min(1),
      entity_type: z.string().optional(),
      business_type: z.string().optional(),
      description: z.string().optional(),
      default_fields: z.record(z.string(), z.any()).optional(),
      enabled: z.boolean().optional(),
    }),
    jsonCols: ['default_fields'],
  },
  // ===== 注册制批次一（055 迁移）：位置 / 报修人字典（卡1）=====
  location: {
    table: 'location_dict',
    columns: ['id', 'tenant_id', 'code', 'name', 'category', 'default_reporter_id', 'enabled', 'created_at', 'updated_at'],
    insertCols: ['code', 'name', 'category', 'default_reporter_id'],
    searchCols: ['code', 'name', 'category'],
    uniqueCode: true,
    fields: [
      { key: 'code', label: '编号' },
      { key: 'name', label: '名称' },
      { key: 'category', label: '类别' },
      { key: 'default_reporter_id', label: '默认报修人ID' },
    ],
    schema: z.object({
      code: z.string().min(1),
      name: z.string().min(1),
      category: z.string().optional(),
      default_reporter_id: z.string().uuid().optional(),
      // enabled 有 DB DEFAULT true（055）；schema 仅放行取值，不在 insertCols（未提供列让 DB DEFAULT 生效）
      enabled: z.boolean().optional(),
    }),
  },
  reporter: {
    table: 'reporter_dict',
    columns: ['id', 'tenant_id', 'code', 'name', 'phone', 'role', 'enabled', 'created_at', 'updated_at'],
    insertCols: ['code', 'name', 'phone', 'role'],
    searchCols: ['code', 'name', 'phone', 'role'],
    uniqueCode: true,
    fields: [
      { key: 'code', label: '编号' },
      { key: 'name', label: '姓名' },
      { key: 'phone', label: '手机号' },
      { key: 'role', label: '角色说明' },
    ],
    schema: z.object({
      code: z.string().min(1),
      name: z.string().min(1),
      phone: z.string().regex(/^1\d{10}$/),
      role: z.string().optional(),
      enabled: z.boolean().optional(),
    }),
  },
};

function getType(t: string): TypeDef {
  const d = TYPES[t];
  if (!d) throw new AppError('BAD_TYPE', `unknown basic-data type: ${t}`, 400);
  return d;
}

// 可搜索列解析（P0-2 引擎修复①）：显式 searchCols 优先；
// 未声明时回退为「fields 中 schema 形状为 z.string() 的 key」——
// 排除 z.number()（priority_dict.sort）与 z.string().uuid()（uuid 列 ILIKE 会 42883/500）。
function searchColsOf(def: TypeDef): string[] {
  if (def.searchCols && def.searchCols.length > 0) return def.searchCols;
  const shape = (def.schema as z.ZodObject<any>)?.shape ?? {};
  return def.fields
    .filter((f) => {
      const s = shape[f.key];
      if (!(s instanceof z.ZodString)) return false;
      const checks = (s as unknown as { _def?: { checks?: { kind?: string }[] } })._def?.checks ?? [];
      return !checks.some((c) => c.kind === 'uuid');
    })
    .map((f) => f.key);
}

// ============ 列表（支持名称/关键字搜索）============
router.get('/basic-data/:type', async (req, res, next) => {
  try {
    const def = getType(req.params.type);
    const tenantId = res.locals.auth.tenantId;
    const q = (req.query.q as string) || '';
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    if (q) {
      const like = `%${q}%`;
      // 在可搜索字段上做 ILIKE（searchCols 声明优先，回退 z.string() 字段，杜绝 uuid/numeric 列 500）
      const searchCols = searchColsOf(def);
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
router.post('/basic-data/:type', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const def = getType(req.params.type);
    const tenantId = auth.tenantId;
    const b = def.schema.parse(req.body);
    const id = randomUUID();
    // 只插入「请求提供了」的列：未提供的列省略，让 DB 的 DEFAULT 生效
    //（若显式传 NULL 会覆盖 NOT NULL DEFAULT 列，如 work_order_template.entity_type → 违反约束）
    const provided = def.insertCols.filter((c) => (b as any)[c] !== undefined);
    const cols = ['id', 'tenant_id', ...provided];
    const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
    const vals = [id, tenantId, ...provided.map((c) => (b as any)[c])];
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'basicdata.edit');
      // 撞码预检（P0-2 引擎修复②）：仅对声明 uniqueCode（有 DB 唯一索引背书）的类型启用。
      // 命中给 409 语义化冲突，而非落到 DB 唯一索引的 23505。
      const code = (b as { code?: unknown }).code;
      if (def.uniqueCode && typeof code === 'string' && code !== '') {
        const dup = await client.query(
          `SELECT 1 FROM ${def.table} WHERE tenant_id=$1 AND code=$2 LIMIT 1`,
          [tenantId, code],
        );
        if (dup.rowCount && dup.rowCount > 0) throw new AppError('CONFLICT', '该编号已存在', 409);
      }
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
router.put('/basic-data/:type/:id', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const def = getType(req.params.type);
    const tenantId = auth.tenantId;
    const b = (def.schema as z.ZodObject<any>).partial().parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'basicdata.edit');
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
      // D1 修复（M0-1）：updated_at 列非全表标配（047 建的 equipment_brand/priority_dict/sla_policy/
      // work_order_template 四表历史缺列），无条件 SET 会对缺列表生成非法 SQL → 42703 全量更新失败。
      // 迁移 068 补列后此处守卫仍保留（纵深防御：列声明与 DDL 漂移时降级为不更新时间戳而非报错）。
      if (def.columns.includes('updated_at')) sets.push('updated_at = now()');
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
router.delete('/basic-data/:type/:id', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const def = getType(req.params.type);
    const tenantId = auth.tenantId;
    // P0-2 引擎修复③（删除联动）：删除报修人成功后，同事务把 location_dict.default_reporter_id
    // 引用置空，避免悬空 uuid 引用（055 外键语义由应用层维护，未建 FK 约束）。
    const rowCount = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'basicdata.edit');
      const r = await client.query(`DELETE FROM ${def.table} WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (!r.rowCount || r.rowCount === 0) return 0;
      if (def.table === 'reporter_dict') {
        await client.query(
          `UPDATE location_dict SET default_reporter_id = NULL WHERE tenant_id=$1 AND default_reporter_id=$2`,
          [tenantId, req.params.id],
        );
      }
      return r.rowCount;
    });
    if (rowCount === 0) throw new AppError('NOT_FOUND', `${def.table} not found`, 404);
    return res.json({ ok: true, code: 0, deleted: rowCount });
  } catch (e) {
    next(e);
  }
});

// ============ CSV 导出 ============
router.get('/basic-data/:type/export', async (req, res, next) => {
  try {
    requireConfigRole(req, res); // R9-F1：导出属管理面，仅 admin/operator
    const def = getType(req.params.type);
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client.query(`SELECT * FROM ${def.table} WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId]).then((r) => r.rows),
    );
    const headers = def.insertCols;
    const lines = [headers.join(',')];
    for (const row of items) lines.push(headers.map((h) => csvEscape(row[h])).join(','));
    const csv = '﻿' + lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${def.table}.csv"`);
    return res.send(csv);
  } catch (e) {
    next(e);
  }
});

// ============ CSV 导入 ============
router.post('/basic-data/:type/import', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const def = getType(req.params.type);
    const tenantId = auth.tenantId;
    const text = typeof req.body === 'string' ? req.body : (req.body as any)?.csv;
    if (!text || typeof text !== 'string') throw new AppError('BAD_INPUT', 'csv text required', 400);
    const rows = parseCsv(text);
    if (rows.length < 2) return res.json({ ok: true, code: 0, inserted: 0 });
    const headers = rows[0].map((h) => h.trim());
    const dataRows = rows.slice(1);
    let inserted = 0;
    await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'basicdata.edit');
      for (const r of dataRows) {
        const obj: Record<string, unknown> = {};
        headers.forEach((h, i) => {
          if (def.insertCols.includes(h)) obj[h] = r[i] ?? null;
        });
        if (!obj.name) continue; // 名称必填，跳过空行
        // jsonb 列：CSV 单元格按 JSON 解析（非法 JSON 给友好 400，而非 500）
        for (const jc of def.jsonCols ?? []) {
          const raw = obj[jc];
          if (raw === null || raw === undefined || raw === '') {
            obj[jc] = null;
            continue;
          }
          try {
            obj[jc] = JSON.parse(String(raw));
          } catch {
            throw new AppError('BAD_INPUT', `${jc} 第 ${inserted + 2} 行不是合法 JSON`, 400);
          }
        }
        // 只插入 CSV 提供的列（省略未提供列，让 DB DEFAULT 生效，避免 NULL 覆盖 NOT NULL DEFAULT 列）
        const id = randomUUID();
        const provided = def.insertCols.filter((c) => obj[c] !== undefined && obj[c] !== null && obj[c] !== '');
        const cols = ['id', 'tenant_id', ...provided];
        const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
        const vals = [id, tenantId, ...provided.map((c) => obj[c])];
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
