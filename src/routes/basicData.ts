// 基础数据模块（P1 回归修复）：区域 / 联系人 / 供应商 三类主数据。
// 通用 CRUD + CSV 导入导出；RLS 铁底线（withTenantClient 注入 tenant_id）；写操作 requirePermission('basicdata.edit')（含 CSV 导出，原 requireConfigRole 已收敛）。
// 契约形态对齐 asset.ts（{ ok, code, items / item }），与前端 BasicData.tsx 配套。
import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requirePermission } from '../middleware/role.js';
import { parseCsv, csvHeader, csvRowLine, csvHeaderMap, csvParseRow, csvBool, csvDateOnly, type CsvField } from '../services/csvUtil.js';

import { requireModuleWrites } from '../middleware/moduleGuard.js';

const router = Router();
router.use(requireModuleWrites('foundation'));


/**
 * CSV 单次导入的数据行硬上限（QA🟡9）。
 * 导入是「单事务 + 逐行 INSERT + 全程持连接」，行数无上限时会长时间占用连接与行锁
 * （N 行 = N 次往返），大文件足以把连接池拖干。超限一律 400 请调用方拆分分批，
 * 不静默截断（静默截断会让用户以为导全了，实则丢数据）。
 */
const CSV_IMPORT_MAX_ROWS = 2000;

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

// 有 enabled 列的字典表（055/117 迁移）。列表默认只返回启用项；
// include_disabled=1 时才连停用项一起返回（管理端“显示已停用”开关）。
// 历史单据按 id/名称解析，不依赖列表过滤，所以停用不会造成历史数据丢失。
const ENABLED_TABLES = new Set([
  'dept', 'region', 'contact', 'supplier', 'equipment_type', 'equipment_brand', 'priority_dict',
  'sla_policy', 'work_order_template', 'business_type_dict', 'location_dict', 'reporter_dict',
]);

// export 供测试/静态门禁断言「声明列必存在于迁移 DDL」不变式（M0-1 C 件配套），无运行时行为变更。
export const TYPES: Record<string, TypeDef> = {
  dept: {
    table: 'dept',
    columns: ['id', 'tenant_id', 'name', 'code', 'remark', 'is_default', 'enabled', 'created_at', 'updated_at'],
    insertCols: ['name', 'code', 'remark', 'enabled'],
    fields: [
      { key: 'name', label: '部门名称' },
      { key: 'code', label: '编码' },
      { key: 'remark', label: '备注' },
      { key: 'enabled', label: '启用' },
    ],
    schema: z.object({
      name: z.string().min(1),
      code: z.string().optional(),
      remark: z.string().optional(),
      enabled: z.boolean().optional(),
    }),
  },
  region: {
    table: 'region',
    columns: ['id', 'tenant_id', 'name', 'code', 'parent_id', 'remark', 'enabled', 'created_at', 'updated_at'],
    insertCols: ['name', 'code', 'parent_id', 'remark', 'enabled'],
    fields: [
      { key: 'name', label: '名称' },
      { key: 'code', label: '编码' },
      { key: 'parent_id', label: '上级区域' },
      { key: 'remark', label: '备注' },
      { key: 'enabled', label: '启用' },
    ],
    schema: z.object({
      name: z.string().min(1),
      code: z.string().optional(),
      parent_id: z.string().optional(),
      remark: z.string().optional(),
      enabled: z.boolean().optional(),
    }),
  },
  contact: {
    table: 'contact',
    columns: ['id', 'tenant_id', 'name', 'phone', 'email', 'org', 'dept', 'remark', 'enabled', 'created_at', 'updated_at'],
    insertCols: ['name', 'phone', 'email', 'org', 'dept', 'remark', 'enabled'],
    fields: [
      { key: 'name', label: '姓名' },
      { key: 'phone', label: '电话' },
      { key: 'email', label: '邮箱' },
      { key: 'org', label: '单位' },
      { key: 'dept', label: '部门' },
      { key: 'remark', label: '备注' },
      { key: 'enabled', label: '启用' },
    ],
    schema: z.object({
      name: z.string().min(1),
      phone: z.string().optional(),
      email: z.string().optional(),
      org: z.string().optional(),
      dept: z.string().optional(),
      remark: z.string().optional(),
      enabled: z.boolean().optional(),
    }),
  },
  supplier: {
    table: 'supplier',
    columns: ['id', 'tenant_id', 'name', 'contact_person', 'phone', 'address', 'category', 'remark', 'enabled', 'created_at', 'updated_at'],
    insertCols: ['name', 'contact_person', 'phone', 'address', 'category', 'remark', 'enabled'],
    fields: [
      { key: 'name', label: '名称' },
      { key: 'contact_person', label: '联系人' },
      { key: 'phone', label: '电话' },
      { key: 'address', label: '地址' },
      { key: 'category', label: '分类' },
      { key: 'remark', label: '备注' },
      { key: 'enabled', label: '启用' },
    ],
    schema: z.object({
      name: z.string().min(1),
      contact_person: z.string().optional(),
      phone: z.string().optional(),
      address: z.string().optional(),
      category: z.string().optional(),
      remark: z.string().optional(),
      enabled: z.boolean().optional(),
    }),
  },
  // ===== 批次 B 新增（047 迁移）=====
  equipment_type: {
    table: 'equipment_type',
    columns: ['id', 'tenant_id', 'name', 'code', 'remark', 'enabled', 'created_at', 'updated_at'],
    insertCols: ['name', 'code', 'remark', 'enabled'],
    fields: [
      { key: 'name', label: '类型名称' },
      { key: 'code', label: '编码' },
      { key: 'remark', label: '备注' },
      { key: 'enabled', label: '启用' },
    ],
    schema: z.object({
      name: z.string().min(1),
      code: z.string().optional(),
      remark: z.string().optional(),
      enabled: z.boolean().optional(),
    }),
  },
  equipment_brand: {
    table: 'equipment_brand',
    columns: ['id', 'tenant_id', 'name', 'code', 'remark', 'enabled', 'created_at', 'updated_at'],
    insertCols: ['name', 'code', 'remark', 'enabled'],
    fields: [
      { key: 'name', label: '厂商名称' },
      { key: 'code', label: '编码' },
      { key: 'remark', label: '备注' },
      { key: 'enabled', label: '启用' },
    ],
    schema: z.object({
      name: z.string().min(1),
      code: z.string().optional(),
      remark: z.string().optional(),
      enabled: z.boolean().optional(),
    }),
  },
  priority_dict: {
    table: 'priority_dict',
    columns: ['id', 'tenant_id', 'name', 'code', 'sort', 'color', 'remark', 'enabled', 'created_at', 'updated_at'],
    insertCols: ['name', 'code', 'sort', 'color', 'remark', 'enabled'],
    // numeric 列 sort 不可 ILIKE（P0-2 引擎修复①配套声明；回退逻辑也会排除 z.number()，双保险）
    searchCols: ['name', 'code', 'color', 'remark'],
    fields: [
      { key: 'name', label: '优先级名称' },
      { key: 'code', label: '编码' },
      { key: 'sort', label: '排序(小在前)' },
      { key: 'color', label: '颜色(red/orange)' },
      { key: 'remark', label: '备注' },
      { key: 'enabled', label: '启用' },
    ],
    schema: z.object({
      name: z.string().min(1),
      code: z.string().optional(),
      sort: z.number().optional(),
      color: z.string().optional(),
      remark: z.string().optional(),
      enabled: z.boolean().optional(),
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
  // ===== FE Intake 业务类型登记处（075 迁移）：申报页业务类型后端事实源 =====
  business_type: {
    table: 'business_type_dict',
    columns: ['id', 'tenant_id', 'code', 'name', 'sort', 'enabled', 'remark', 'created_at', 'updated_at'],
    insertCols: ['code', 'name', 'sort', 'enabled', 'remark'],
    // numeric 列 sort 不可 ILIKE（对齐 priority_dict 口径，P0-2 引擎修复①）
    searchCols: ['name', 'code', 'remark'],
    fields: [
      { key: 'name', label: '业务类型名称' },
      { key: 'code', label: '编码' },
      { key: 'sort', label: '排序(小在前)' },
      { key: 'enabled', label: '启用' },
      { key: 'remark', label: '备注' },
    ],
    schema: z.object({
      name: z.string().min(1),
      code: z.string().optional(),
      sort: z.number().optional(),
      enabled: z.boolean().optional(),
      remark: z.string().optional(),
    }),
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
      { key: 'default_reporter_id', label: '默认报修人' },
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

/**
 * P0-6（2026-11-04）：敏感字典读守卫。
 * contact / supplier / reporter 含姓名、电话、邮箱、住址等 PII，此前任意登录账号
 * （含最低权限 worker）都能列表读取。现在读取与写入统一到 `basicdata.edit`
 * （默认 operator 及以上；租户可通过 role_permission 显式授予）。
 * 
 * 为什么不收 location/dept：这两类是建单必填字典（公开报修/小程序建单选区域、部门），
 * 对登录用户只读放行是业务必需；它们不含个人联系方式，泄露面与 PII 不同级。
 */
const SENSITIVE_READ_TYPES = new Set(['contact', 'supplier', 'reporter']);

// ============ 列表（支持名称/关键字搜索）============
router.get('/basic-data/:type', async (req, res, next) => {
  try {
    const def = getType(req.params.type);
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    if (SENSITIVE_READ_TYPES.has(req.params.type)) {
      await withTenantClient(tenantId, (client) => requirePermission(auth, client, 'basicdata.edit'));
    }
    const q = (req.query.q as string) || '';
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    // 停用项默认不出现在列表/下拉；管理端显式 include_disabled=1 才返回。
    if (ENABLED_TABLES.has(def.table) && req.query.include_disabled !== '1') {
      clauses.push('enabled IS NOT FALSE');
    }
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
function basicCsvFields(def: TypeDef, type: string, nameMap: Map<string, string> = new Map()): CsvField[] {
  const byKey = new Map(def.fields.map((f) => [f.key, f]));
  return def.insertCols.map((key) => {
    const f = byKey.get(key);
    return {
      key,
      label: f?.label ?? key,
      export: (row: any) => {
        const v = row?.[key];
        if ((type === 'region' && key === 'parent_id') || (type === 'location' && key === 'default_reporter_id')) {
          return nameMap.get(String(v)) || '';
        }
        if (typeof v === 'boolean') return csvBool(v);
        if (/_date$/.test(key) || key === 'purchase_date') return csvDateOnly(v);
        return v;
      },
    };
  });
}

router.get('/basic-data/:type/export', async (req, res, next) => {
  try {
    const def = getType(req.params.type);
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const result = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'basicdata.edit');
      const items = await client
        .query(`SELECT * FROM ${def.table} WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId])
        .then((r) => r.rows);
      const nameMap = new Map<string, string>();
      if (req.params.type === 'region') {
        const rows = (await client.query(`SELECT id, name FROM region WHERE tenant_id=$1`, [tenantId])).rows;
        for (const r of rows) nameMap.set(String(r.id), String(r.name));
      } else if (req.params.type === 'location') {
        const rows = (await client.query(`SELECT id, name FROM reporter_dict WHERE tenant_id=$1`, [tenantId])).rows;
        for (const r of rows) nameMap.set(String(r.id), String(r.name));
      }
      return { items, nameMap };
    });
    const fields = basicCsvFields(def, req.params.type, result.nameMap);
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
router.post('/basic-data/:type/import', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const def = getType(req.params.type);
    const tenantId = auth.tenantId;
    const text = typeof req.body === 'string' ? req.body : (req.body as any)?.csv;
    if (!text || typeof text !== 'string') throw new AppError('BAD_INPUT', 'csv text required', 400);
    const rows = parseCsv(text);
    if (rows.length < 2) return res.json({ ok: true, code: 0, inserted: 0 });
    const fields = basicCsvFields(def, req.params.type);
    const headerMap = csvHeaderMap(rows[0], fields);
    const dataRows = rows.slice(1).map((r) => csvParseRow(r, headerMap));
    // QA🟡9①：行数上限（见 CSV_IMPORT_MAX_ROWS 注释）——超限直接 400，不静默截断。
    if (dataRows.length > CSV_IMPORT_MAX_ROWS) {
      throw new AppError(
        'BAD_INPUT',
        `CSV 数据行 ${dataRows.length} 行，超过单次导入上限 ${CSV_IMPORT_MAX_ROWS} 行，请拆分后分批导入`,
        400,
      );
    }
    // QA🟡9②：唯一码预检（仅对声明 uniqueCode 的字典，与 POST 建档同口径）。
    // 先做「CSV 内自撞」，再做「与库内撞码」——撞码一律前置为 409，
    // 否则中途撞 DB 唯一索引会抛 23505 把整个事务打成 aborted，错误信息还是 PG 方言。
    const codeLines = new Map<string, number[]>(); // code → 出现过的 CSV 行号（表头算第 1 行）
    if (def.uniqueCode) {
      dataRows.forEach((obj, i) => {
        const raw = String(obj.code ?? '').trim();
        if (!raw) return; // 无编号的行不参与撞码（后续按 !obj.name 跳过）
        const lines = codeLines.get(raw) ?? [];
        lines.push(i + 2);
        codeLines.set(raw, lines);
      });
      const selfDup = [...codeLines.entries()].filter(([, lines]) => lines.length > 1);
      if (selfDup.length > 0) {
        throw new AppError(
          'CONFLICT',
          `CSV 内部编号重复：${selfDup.slice(0, 5).map(([c, lines]) => `${c}（第 ${lines.join('、')} 行）`).join('；')}`,
          409,
        );
      }
    }
    let inserted = 0;
    await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'basicdata.edit');
      const refMap = new Map<string, string>();
      if (req.params.type === 'region') {
        const rows = (await client.query(`SELECT id, name, code FROM region WHERE tenant_id=$1`, [tenantId])).rows;
        for (const r of rows) {
          refMap.set(String(r.name), String(r.id));
          if (r.code) refMap.set(String(r.code), String(r.id));
        }
      } else if (req.params.type === 'location') {
        const rows = (await client.query(`SELECT id, name, code FROM reporter_dict WHERE tenant_id=$1`, [tenantId])).rows;
        for (const r of rows) {
          refMap.set(String(r.name), String(r.id));
          if (r.code) refMap.set(String(r.code), String(r.id));
        }
      }
      if (codeLines.size > 0) {
        const dup = await client.query(
          `SELECT code FROM ${def.table} WHERE tenant_id=$1 AND code = ANY($2::text[])`,
          [tenantId, [...codeLines.keys()]],
        );
        if (dup.rowCount && dup.rowCount > 0) {
          const hit = dup.rows.slice(0, 10).map((r: { code: string }) => r.code).join('、');
          throw new AppError('CONFLICT', `以下编号已存在，无法导入：${hit}`, 409);
        }
      }
      for (let rowIdx = 0; rowIdx < dataRows.length; rowIdx++) {
        const obj = dataRows[rowIdx];
        if (!obj.name) continue; // 名称必填，跳过空行
        const refKey = req.params.type === 'region' ? 'parent_id' : req.params.type === 'location' ? 'default_reporter_id' : '';
        if (refKey && obj[refKey]) {
          const raw = String(obj[refKey]).trim();
          if (raw) {
            const id = refMap.get(raw) ?? (/^[0-9a-f-]{36}$/i.test(raw) ? raw : '');
            if (!id) throw new AppError('BAD_INPUT', `${refKey} 第 ${rowIdx + 2} 行引用不存在：${raw}`, 400);
            obj[refKey] = id;
          }
        }
        // 布尔列：导出为「是/否」，导入还原为 boolean（Postgres 不认中文布尔字面量）
        for (const key of Object.keys(obj)) {
          if (/^(is_|has_|enabled$|active$)/.test(key) && typeof obj[key] === 'string') {
            const v = String(obj[key]).trim();
            if (['是', 'true', '1', '启用'].includes(v)) obj[key] = true;
            else if (['否', 'false', '0', '停用'].includes(v)) obj[key] = false;
          }
        }
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
