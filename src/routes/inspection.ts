// 巡检模块（批次 B · PRD §6.1）：点位 + 巡检单 + 定位签到 + 异常转工单。
// 风格对齐 config.ts：withTenantClient 注入租户/RLS；写操作 requireConfigRole；占位符防注入。
// 转单复用 services/linkedWorkOrder（巡检异常 → 标准维修工单，进入既有派单流）。
// B1 统一事件总线：关键业务动作 emit domain_event（过程挖掘统一数据源）。
import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requireConfigRole, requireAssigneeOrConfig } from '../middleware/role.js';
import { createLinkedWorkOrder } from '../services/linkedWorkOrder.js';
import { emitDomainEvent } from '../db/eventBus.js';
import { getWorkflowDefOrDefault } from '../engine/workflowDef.js';
import { applyEvent, availableTransitions } from '../engine/stateMachine.js';
import { INSPECTION_DEF } from '../engine/themes.js';
import { csvEscape } from '../services/csvUtil.js'; // R30-F7：统一 CSV 转义（含 R5-001 公式注入防护），删除本地重复 esc
import { createAlert } from './emergency.js';

/**
 * 状态流转统一走 workflow_def 引擎（红线：所有业务流必须过 workflow_def，不再硬编码状态机）。
 * 读取 inspection_task 当前 status → 用引擎校验 event 合法性 → 写入目标态。
 * 租户无自定义 inspection_task 定义时回退内置 INSPECTION_DEF，保证既有语义（pending→in_progress→done/exception）不变。
 */
async function transitionTask(
  client: any,
  tenantId: string,
  taskId: string,
  event: string,
  extra: Record<string, unknown> = {},
  actor = 'config_role',
): Promise<any> {
  const cur = await client.query(`SELECT * FROM inspection_task WHERE id = $1 AND tenant_id = $2`, [taskId, tenantId]);
  if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'task not found', 404);
  const t = cur.rows[0];
  const def = await getWorkflowDefOrDefault(client, tenantId, 'inspection_task', INSPECTION_DEF);
  const target = applyEvent(def, t.status, event);
  if (!target) {
    throw new AppError('BAD_STATE', `illegal transition ${t.status} --${event}-->`, 422);
  }
  // 防御纵深：仅允许白名单物理列被 SET，杜绝任意列名拼入 SQL（🔴① 修复）
  const ALLOWED_COLS = new Set(['note', 'geo_lat', 'geo_lng', 'done_at', 'photos']);
  const extraKeys = Object.keys(extra).filter((k) => ALLOWED_COLS.has(k));
  const filteredKeys = extraKeys.filter((k) => extra[k] !== 'now()');
  const assigns = [
    'status = $3',
    ...filteredKeys.map((k, idx) => `${k} = $${4 + idx}`),
    ...extraKeys.filter((k) => extra[k] === 'now()').map((k) => `${k} = now()`),
  ];
  const values = [taskId, tenantId, target, ...filteredKeys.map((k) => extra[k])];
  const r = await client.query(
    `UPDATE inspection_task SET ${assigns.join(', ')}, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    values,
  );
  await emitDomainEvent(client, { tenantId, entityType: 'inspection_task', entityId: taskId, type: event, actor });
  return r.rows[0];
}

const router = Router();

// 防伪 L1：haversine 球面距离（米）—— 签到坐标与点位基准坐标校验用
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ============ 点位 ============
const pointSchema = z.object({
  name: z.string().min(1),
  code: z.string().optional(),
  lng: z.number().optional(),
  lat: z.number().optional(),
  asset_id: z.string().optional(),
});

router.get('/points', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT id, name, code, lng, lat, asset_id, created_at FROM inspection_point WHERE tenant_id = $1 ORDER BY created_at DESC`,
          [tenantId],
        )
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.post('/points', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = pointSchema.parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const r = await client.query(
        `INSERT INTO inspection_point (tenant_id, name, code, lng, lat, asset_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [tenantId, b.name, b.code ?? null, b.lng ?? null, b.lat ?? null, b.asset_id ?? null],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'inspection_point', entityId: row.id, type: 'create', actor: 'config_role' });
      return row;
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.put('/points/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = pointSchema.partial().parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM inspection_point WHERE id = $1 AND tenant_id = $2`, [
        req.params.id,
        tenantId,
      ]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'point not found', 404);
      const c = cur.rows[0];
      const r = await client.query(
        `UPDATE inspection_point SET name = $3, code = $4, lng = $5, lat = $6, asset_id = $7 WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [req.params.id, tenantId, b.name ?? c.name, b.code ?? c.code, b.lng ?? c.lng, b.lat ?? c.lat, b.asset_id ?? c.asset_id],
      );
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.delete('/points/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const n = await withTenantClient(tenantId, (client) =>
      client
        .query(`DELETE FROM inspection_point WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenantId])
        .then((r) => r.rowCount ?? 0),
    );
    if (n === 0) throw new AppError('NOT_FOUND', 'point not found', 404);
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

// ============ 检查项模板（巡检内容） ============
// 检查项 = 巡检要「查什么」：名称 / 类型[是否|数值|文本] / 标准值 / 单位 / 归类。
const itemTemplateSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['bool', 'number', 'text']).default('bool'),
  standard_value: z.string().optional(),
  unit: z.string().optional(),
  category: z.string().optional(),
  // D2：外部硬件预留（RFID/传感器，仅字段/协议预留，硬件到位即插即用）
  device_type: z.enum(['rfid', 'sensor', 'qr', 'none']).optional(),
  device_tag: z.string().optional(),
  trigger_mode: z.enum(['manual', 'scan', 'auto']).optional(),
});

function seedItemsSnapshot(client: any, tenantId: string, itemIds: string[]): Promise<unknown[]> {
  if (!itemIds || itemIds.length === 0) return Promise.resolve([]);
  return client
    .query(
      `SELECT id, name, type, standard_value, unit, category FROM inspection_item
       WHERE tenant_id = $1 AND id = ANY($2)`,
      [tenantId, itemIds],
    )
    .then((r: any) =>
      r.rows.map((x: any) => ({
        item_id: x.id,
        name: x.name,
        type: x.type,
        standard_value: x.standard_value ?? null,
        unit: x.unit ?? null,
        category: x.category ?? null,
        actual_value: null,
        passed: null,
        photo: null,
        remark: null,
      })),
    );
}

router.get('/items', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT id, name, type, standard_value, unit, category, created_at FROM inspection_item WHERE tenant_id = $1 ORDER BY category NULLS LAST, created_at DESC`,
          [tenantId],
        )
        .then((r: any) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.post('/items', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = itemTemplateSchema.parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const r = await client.query(
        `INSERT INTO inspection_item (tenant_id, name, type, standard_value, unit, category, device_type, device_tag, trigger_mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [tenantId, b.name, b.type, b.standard_value ?? null, b.unit ?? null, b.category ?? null, b.device_type ?? 'none', b.device_tag ?? null, b.trigger_mode ?? 'manual'],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'inspection_item', entityId: row.id, type: 'create', actor: 'config_role' });
      return row;
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.put('/items/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = itemTemplateSchema.partial().parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM inspection_item WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'item not found', 404);
      const c = cur.rows[0];
      const r = await client.query(
        `UPDATE inspection_item SET name=$3, type=$4, standard_value=$5, unit=$6, category=$7, device_type=$8, device_tag=$9, trigger_mode=$10 WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        [req.params.id, tenantId, b.name ?? c.name, b.type ?? c.type, b.standard_value ?? c.standard_value, b.unit ?? c.unit, b.category ?? c.category, b.device_type ?? c.device_type ?? 'none', b.device_tag ?? c.device_tag ?? null, b.trigger_mode ?? c.trigger_mode ?? 'manual'],
      );
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.delete('/items/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const n = await withTenantClient(tenantId, (client) =>
      client
        .query(`DELETE FROM inspection_item WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenantId])
        .then((r: any) => r.rowCount ?? 0),
    );
    if (n === 0) throw new AppError('NOT_FOUND', 'item not found', 404);
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

// ============ 巡检单 ============
const taskSchema = z.object({
  point_id: z.string().uuid().optional(),
  type: z.enum(['plan', 'free']).default('plan'),
  title: z.string().min(1),
  assignee: z.string().optional(),
  scheduled_at: z.string().optional(),
  item_ids: z.array(z.string().uuid()).optional(),           // 选定检查项模板，创建时 seed 进 items_json
});

router.get('/tasks', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { status, point_id, type, scheduled_from, scheduled_to, plan_id, assignee } = req.query as Record<string, string>;
    const clauses = ['t.tenant_id = $1']; // 必须与下方 LEFT JOIN inspection_point p 共存：两表都有 tenant_id，未限定会触发 "column reference tenant_id is ambiguous" 500
    const params: unknown[] = [tenantId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      clauses.push(sql.replace(/\?/g, `$${params.length}`));
    };
    if (status) add('status = ?', status);
    if (point_id) add('point_id = ?', point_id);
    if (type) add('type = ?', type);
    if (plan_id) add('plan_id = ?', plan_id);
    if (assignee) add('assignee = ?', assignee); // #583：worker 工作台按归属拉自己的巡检任务
    if (scheduled_from) add('scheduled_at >= ?', scheduled_from);
    if (scheduled_to) add('scheduled_at <= ?', scheduled_to);
      const items = await withTenantClient(tenantId, (client) =>
        client
          .query(
            `SELECT t.*, p.name AS point_name FROM inspection_task t LEFT JOIN inspection_point p ON p.id = t.point_id WHERE ${clauses.join(' AND ')} ORDER BY t.scheduled_at ASC NULLS LAST, t.created_at DESC`,
            params,
          )
          .then((r) => r.rows),
      );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// 巡检单详情：返回任务 + 引擎算出的 available（供前端动态渲染动作按钮，不硬编码状态机）
// + 检查项快照(items_json) + 已填实测记录(records)。
router.get('/tasks/:id', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT t.*, p.name AS point_name FROM inspection_task t LEFT JOIN inspection_point p ON p.id = t.point_id WHERE t.id = $1 AND t.tenant_id = $2`, [
        req.params.id,
        tenantId,
      ]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'task not found', 404);
      const t = cur.rows[0];
      const def = await getWorkflowDefOrDefault(client, tenantId, 'inspection_task', INSPECTION_DEF);
      const available = availableTransitions(def, t.status);
      const rec = await client
        .query(`SELECT * FROM inspection_record WHERE tenant_id = $1 AND task_id = $2 ORDER BY created_at ASC`, [tenantId, t.id])
        .then((r: any) => r.rows);
      const itemsSnapshot = Array.isArray(t.items_json) ? t.items_json : [];
      // items_json 快照叠加实测回填：以 snapshot 为基础，用 records 覆盖 actual_value/passed/photo/remark。
      const recMap = new Map<string, any>();
      for (const x of rec) recMap.set(String(x.item_id), x);
      const items = itemsSnapshot.map((s: any) => {
        const recx = recMap.get(String(s.item_id));
        return recx
          ? { ...s, actual_value: recx.actual_value ?? null, passed: recx.passed ?? null, photo: recx.photo ?? null, remark: recx.remark ?? null }
          : s;
      });
      return { ...t, available, items, records: rec };
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.post('/tasks', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = taskSchema.parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const snapshot = await seedItemsSnapshot(client, tenantId, b.item_ids ?? []);
      const r = await client.query(
        `INSERT INTO inspection_task (tenant_id, plan_id, point_id, type, title, assignee, scheduled_at, status, items_json)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, 'pending', $7) RETURNING *`,
        [tenantId, b.point_id ?? null, b.type, b.title, b.assignee ?? null, b.scheduled_at ?? null, JSON.stringify(snapshot)],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'inspection_task', entityId: row.id, type: 'create', actor: 'config_role' });
      return row;
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.post('/tasks/:id/checkin', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    // D2：scan_tag 打卡（RFID/扫码占位——硬件到位即插即用）；scan_meta 落库（tag/lat/lng/时间）
    const b = z.object({
      geo_lat: z.number().optional(),
      geo_lng: z.number().optional(),
      note: z.string().optional(),
      scan_tag: z.string().optional(),
    }).parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      // #583 归属守卫：worker 仅可签到被指派给自己的巡检任务
      const cur = await client.query(`SELECT assignee, point_id FROM inspection_task WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'task not found', 404);
      await requireAssigneeOrConfig(client, res.locals.auth, cur.rows[0].assignee, 'inspection task');
      // 防伪 L1：签到坐标与点位基准坐标距离校验（haversine），>500m 标记疑似
      // 点位无坐标或未绑点位 → 不判（诚实：无法校验就不硬造异常）
      let geoSuspect = false;
      let geoDistanceM: number | null = null;
      if (b.geo_lat != null && b.geo_lng != null && cur.rows[0].point_id) {
        const pt = await client.query(
          `SELECT lat, lng FROM inspection_point WHERE id=$1 AND tenant_id=$2`,
          [cur.rows[0].point_id, tenantId],
        );
        const p = pt.rows[0];
        if (p && p.lat != null && p.lng != null) {
          const d = haversineM(p.lat, p.lng, b.geo_lat, b.geo_lng);
          geoDistanceM = Math.round(d);
          geoSuspect = d > 500; // 500m 阈值（可后续租户化配置）
        }
      }
      const updated = await transitionTask(client, tenantId, req.params.id, 'checkin', {
        geo_lat: b.geo_lat ?? null,
        geo_lng: b.geo_lng ?? null,
        note: b.note ?? null,
        scan_tag: b.scan_tag ?? null,
      }, res.locals.auth.userId ?? 'config_role');
      if (b.scan_tag || geoSuspect) {
        await client.query(
          `UPDATE inspection_task SET scan_meta = scan_meta || $1::jsonb WHERE id = $2 AND tenant_id = $3`,
          [JSON.stringify({
            scan_tag: b.scan_tag ?? null,
            scan_at: new Date().toISOString(),
            lat: b.geo_lat ?? null,
            lng: b.geo_lng ?? null,
            geo_suspect: geoSuspect,
            geo_distance_m: geoDistanceM,
          }), req.params.id, tenantId],
        );
      }
      return updated;
    });
    return res.json({ ok: true, code: 0, item, scan_tag: b.scan_tag ?? null });
  } catch (e) {
    next(e);
  }
});

router.post('/tasks/:id/complete', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({
      note: z.string().optional(),
      photos: z.array(z.string()).optional(),
      records: z
        .array(
          z.object({
            item_id: z.string().uuid(),
            actual_value: z.string().optional(),
            passed: z.boolean().optional(),
            photo: z.string().optional(),
            remark: z.string().optional(),
          }),
        )
        .optional(),
    }).parse(req.body);
    const extra: Record<string, unknown> = { done_at: 'now()', note: b.note ?? null };
    if (b.photos) extra.photos = JSON.stringify(b.photos); // photos 为 NOT NULL，仅在提供时写入，避免置空破坏约束
    const item = await withTenantClient(tenantId, async (client) => {
      // #583 归属守卫
      const cur = await client.query(`SELECT assignee FROM inspection_task WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'task not found', 404);
      await requireAssigneeOrConfig(client, res.locals.auth, cur.rows[0].assignee, 'inspection task');
      const task = await transitionTask(client, tenantId, req.params.id, 'complete', extra, res.locals.auth.userId ?? 'config_role');
      if (b.records && b.records.length) {
        await upsertRecords(client, tenantId, req.params.id, b.records);
      }
      return task;
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 巡检实测记录写入：UPSERT（同一巡检单+检查项唯一），同时回填 items_json 快照，保证单表与快照一致。
async function upsertRecords(client: any, tenantId: string, taskId: string, records: { item_id: string; actual_value?: string; passed?: boolean; photo?: string; remark?: string }[]): Promise<void> {
  for (const rec of records) {
    await client.query(
      `INSERT INTO inspection_record (tenant_id, task_id, item_id, actual_value, passed, photo, remark)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT ON CONSTRAINT uq_inspection_record_task_item
       DO UPDATE SET actual_value=$4, passed=$5, photo=$6, remark=$7`,
      [tenantId, taskId, rec.item_id, rec.actual_value ?? null, rec.passed ?? null, rec.photo ?? null, rec.remark ?? null],
    );
  }
  // 用最新 records 回填 items_json 快照（与 detail 端叠加逻辑保持一致）。
  const cur = await client.query(`SELECT items_json, tenant_id FROM inspection_task WHERE id=$1 AND tenant_id=$2`, [taskId, tenantId]);
  if (cur.rowCount === 0) return;
  const snap: any[] = Array.isArray(cur.rows[0].items_json) ? cur.rows[0].items_json : [];
  const byId = new Map<string, any>();
  for (const r of records) byId.set(String(r.item_id), r);
  const next = snap.map((s) => {
    const r = byId.get(String(s.item_id));
    return r ? { ...s, actual_value: r.actual_value ?? null, passed: r.passed ?? null, photo: r.photo ?? null, remark: r.remark ?? null } : s;
  });
  await client.query(`UPDATE inspection_task SET items_json=$2 WHERE id=$1 AND tenant_id=$3`, [taskId, JSON.stringify(next), tenantId]);
}

// 单独写入/修改实测记录（未点完成时也可逐项暂存）。
router.post('/tasks/:id/records', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = z
      .object({
        records: z.array(
          z.object({
            item_id: z.string().uuid(),
            actual_value: z.string().optional(),
            passed: z.boolean().optional(),
            photo: z.string().optional(),
            remark: z.string().optional(),
          }),
        ),
      })
      .parse(req.body);
    const out = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT id, assignee FROM inspection_task WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'task not found', 404);
      // #583 归属守卫
      await requireAssigneeOrConfig(client, res.locals.auth, cur.rows[0].assignee, 'inspection task');
      await upsertRecords(client, tenantId, req.params.id, b.records);
      const rec = await client
        .query(`SELECT * FROM inspection_record WHERE tenant_id=$1 AND task_id=$2 ORDER BY created_at ASC`, [tenantId, req.params.id])
        .then((r: any) => r.rows);
      return rec;
    });
    return res.json({ ok: true, code: 0, records: out });
  } catch (e) {
    next(e);
  }
});

router.post('/tasks/:id/exception', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ note: z.string().min(1) }).parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      // #583 归属守卫
      const cur = await client.query(`SELECT assignee FROM inspection_task WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'task not found', 404);
      await requireAssigneeOrConfig(client, res.locals.auth, cur.rows[0].assignee, 'inspection task');
      const row = await transitionTask(client, tenantId, req.params.id, 'exception', { note: b.note }, res.locals.auth.userId ?? 'config_role');
      // 预警深化：巡检异常自动生成 L1 预警，落入预警中心统一处理
      await createAlert(client, tenantId, {
        source_type: 'inspection',
        source_id: req.params.id,
        level: 'L1',
        title: `巡检异常：${row.title}`,
        message: b.note,
      });
      return row;
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 通用流转端点：复用 transitionTask（引擎校验 + 写库 + 事件记账）。
// 前端按 available 的 event 统一调用，避免为每事件单独硬编码端点（覆盖 cancel 等）。
router.post('/tasks/:id/transition', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { event, ...fields } = req.body as { event: string; [k: string]: unknown };
    if (!event || typeof event !== 'string') throw new AppError('BAD_REQUEST', 'event is required', 400);
    // 入口白名单化 extra：请求体剩余键只允许已知列透传，防列名注入（🔴① 修复）
    const ALLOWED = new Set(['note', 'geo_lat', 'geo_lng', 'done_at', 'photos']);
    const extra: Record<string, unknown> = {};
    for (const k of Object.keys(fields)) if (ALLOWED.has(k)) extra[k] = fields[k];
    const item = await withTenantClient(tenantId, async (client) => {
      // #583 归属守卫
      const cur = await client.query(`SELECT assignee FROM inspection_task WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'task not found', 404);
      await requireAssigneeOrConfig(client, res.locals.auth, cur.rows[0].assignee, 'inspection task');
      return transitionTask(client, tenantId, req.params.id, event, extra, res.locals.auth.userId ?? 'config_role');
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// ============ 周期/循环计划（G3 · MVP） ============
// 设计：inspection_plan 记录频率/间隔/下次执行/暂停；建计划时按规则批量生成未来 N 期
// scheduled 巡检单（plan_id 关联），暂停则不再推进。真 cron 调度列为后续增强。
type PlanFrequency = 'daily' | 'weekly' | 'monthly';

function addPlanInterval(base: Date, freq: PlanFrequency, n: number): Date {
  const d = new Date(base);
  if (freq === 'daily') d.setDate(d.getDate() + n);
  else if (freq === 'weekly') d.setDate(d.getDate() + n * 7);
  else if (freq === 'monthly') d.setMonth(d.getMonth() + n);
  return d;
}
function toPgTs(d: Date): string {
  return d.toISOString();
}

const planSchema = z.object({
  name: z.string().min(1),
  point_ids: z.array(z.string().uuid()),
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  interval_n: z.number().int().min(1).max(365).optional(),
  start_from: z.string().optional(),
  generate_ahead: z.number().int().min(1).max(24).optional(),
  item_ids: z.array(z.string().uuid()).optional(),               // 每次生成实例自动带的检查项
});
const planUpdateSchema = planSchema.partial().extend({
  paused: z.boolean().optional(),
  next_run_at: z.string().optional(),
});

// 为某计划的某一期生成各点位的 pending 巡检单（plan_id 关联，便于查实例）。
async function createPlanOccurrence(
  client: any,
  tenantId: string,
  plan: { id: string; name: string; point_ids: string[]; item_ids?: string[] },
  occurrenceDate: Date,
): Promise<unknown[]> {
  const snapshot = await seedItemsSnapshot(client, tenantId, plan.item_ids ?? []);
  const out: unknown[] = [];
  for (const pid of plan.point_ids) {
    const r = await client.query(
      `INSERT INTO inspection_task (tenant_id, plan_id, point_id, type, title, scheduled_at, status, items_json)
       VALUES ($1,$2,$3,'plan',$4,$5,'pending',$6) RETURNING *`,
      [tenantId, plan.id, pid, `${plan.name}·巡检`, toPgTs(occurrenceDate), JSON.stringify(snapshot)],
    );
    const ins = r.rows[0];
    await emitDomainEvent(client, { tenantId, entityType: 'inspection_task', entityId: ins.id, type: 'create', actor: 'config_role' });
    out.push(ins);
  }
  return out;
}

/**
 * 真 cron 调度入口（G3 后续增强落地）：对某租户扫描到期未暂停计划，自动生成逾期/当期实例并推进 next_run_at。
 * - 复用 createPlanOccurrence（已含 domain_event 记账）与 addPlanInterval，保持与手动"生成下一期"完全一致的行为。
 * - catch-up：若 next_run_at 远早于 now（服务宕机/新建即过期），循环补齐至多 60 期，避免无限生成。
 * - 必须在 withTenantClient 内调用（已设 RLS 租户隔离）。
 */
export async function runDuePlansForTenant(tenantId: string): Promise<number> {
  return withTenantClient(tenantId, async (client) => {
    const due = await client.query(
      `SELECT id, name, point_ids, frequency, interval_n, next_run_at
       FROM inspection_plan WHERE tenant_id=$1 AND paused=false AND next_run_at IS NOT NULL AND next_run_at <= now()`,
      [tenantId],
    );
    let generated = 0;
    for (const plan of due.rows) {
      let occ = new Date(plan.next_run_at);
      const now = new Date();
      let guard = 0;
      while (occ <= now && guard < 60) {
        await createPlanOccurrence(client, tenantId, plan, occ);
        generated += Array.isArray(plan.point_ids) ? plan.point_ids.length : 0;
        occ = addPlanInterval(occ, plan.frequency, plan.interval_n || 1);
        guard++;
      }
      await client.query(`UPDATE inspection_plan SET next_run_at=$2, updated_at=now() WHERE id=$1`, [
        plan.id,
        toPgTs(occ),
      ]);
    }
    return generated;
  });
}

// 计划生成：批量为若干点位生成 pending 巡检单（纯函数便于单测）
export function generatePlanTasks(
  points: { id: string }[],
  scheduledAt: string | null,
): { point_id: string | null; type: 'plan'; title: string; status: 'pending'; scheduled_at: string | null }[] {
  return points.map((p) => ({
    point_id: p.id,
    type: 'plan' as const,
    title: '计划巡检',
    status: 'pending' as const,
    scheduled_at: scheduledAt,
  }));
}

router.post('/generate', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ point_ids: z.array(z.string().uuid()), scheduled_at: z.string().optional(), item_ids: z.array(z.string().uuid()).optional() }).parse(req.body);
    const created = await withTenantClient(tenantId, async (client) => {
      const snapshot = await seedItemsSnapshot(client, tenantId, b.item_ids ?? []);
      const rows = generatePlanTasks(
        b.point_ids.map((id) => ({ id })),
        b.scheduled_at ?? null,
      );
      const out: unknown[] = [];
      for (const row of rows) {
        const r = await client.query(
          `INSERT INTO inspection_task (tenant_id, plan_id, point_id, type, title, scheduled_at, status, items_json)
           VALUES ($1, NULL, $2, 'plan', $3, $4, 'pending', $5) RETURNING *`,
          [tenantId, row.point_id, row.title, row.scheduled_at, JSON.stringify(snapshot)],
        );
        const ins = r.rows[0];
        await emitDomainEvent(client, { tenantId, entityType: 'inspection_task', entityId: ins.id, type: 'create', actor: 'config_role' });
        out.push(ins);
      }
      return out;
    });
    return res.status(201).json({ ok: true, code: 0, items: created, count: created.length });
  } catch (e) {
    next(e);
  }
});

// 异常转工单：复用共享服务（巡检异常 → 标准维修工单，进入派单流）
router.post('/tasks/:id/convert', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const result = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM inspection_task WHERE id = $1 AND tenant_id = $2`, [
        req.params.id,
        tenantId,
      ]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'task not found', 404);
      const t = cur.rows[0];
      if (t.status !== 'exception') throw new AppError('BAD_STATE', 'only exception task can convert', 409);
      const wo = await createLinkedWorkOrder(client, {
        id: randomUUID(),
        tenantId,
        businessType: 'inspection',
        catalog: 'inspection',
        priority: 'normal',
        title: `巡检异常(${t.title})`,
        description: t.note ?? '',
        location: undefined,
        sourceType: 'inspection',
        sourceId: t.id,
      });
      await client.query(`UPDATE inspection_task SET linked_wo_id = $2, updated_at = now() WHERE id = $1`, [t.id, wo.id]);
      await emitDomainEvent(client, { tenantId, entityType: 'inspection_task', entityId: t.id, type: 'convert', actor: 'config_role', payload: { work_order_id: wo.id } });
      return wo;
    });
    return res.json({ ok: true, code: 0, result });
  } catch (e) {
    next(e);
  }
});

// ============ 周期计划 CRUD + 手动生成下一期 ============
router.get('/plans', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT * FROM inspection_plan WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId])
        .then((r: any) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.post('/plans', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = planSchema.parse(req.body);
    const interval_n = b.interval_n ?? 1;
    const generate_ahead = b.generate_ahead ?? 1;
    const startFrom = b.start_from ? new Date(b.start_from) : new Date();
    const id = randomUUID();
    const created = await withTenantClient(tenantId, async (client) => {
      await client.query(
        `INSERT INTO inspection_plan (id, tenant_id, name, point_ids, frequency, interval_n, paused, next_run_at, item_ids)
         VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8) RETURNING *`,
        [id, tenantId, b.name, b.point_ids, b.frequency, interval_n, null, b.item_ids ?? []],
      );
      let cursor = startFrom;
      const out: unknown[] = [];
      for (let i = 0; i < generate_ahead; i++) {
        out.push(...(await createPlanOccurrence(client, tenantId, { id, name: b.name, point_ids: b.point_ids }, cursor)));
        cursor = addPlanInterval(cursor, b.frequency, interval_n);
      }
      await client.query(`UPDATE inspection_plan SET next_run_at=$2, updated_at=now() WHERE id=$1`, [id, toPgTs(cursor)]);
      await emitDomainEvent(client, { tenantId, entityType: 'inspection_plan', entityId: id, type: 'create', actor: 'config_role' });
      return out;
    });
    return res.status(201).json({ ok: true, code: 0, plan_id: id, count: created.length });
  } catch (e) {
    next(e);
  }
});

router.put('/plans/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = planUpdateSchema.parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM inspection_plan WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'plan not found', 404);
      const sets: string[] = [];
      const params: unknown[] = [req.params.id, tenantId];
      const set = (col: string, v: unknown) => {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      };
      if (b.name !== undefined) set('name', b.name);
      if (b.point_ids !== undefined) set('point_ids', b.point_ids);
      if (b.frequency !== undefined) set('frequency', b.frequency);
      if (b.interval_n !== undefined) set('interval_n', b.interval_n);
      if (b.item_ids !== undefined) set('item_ids', b.item_ids);
      if (b.paused !== undefined) set('paused', b.paused);
      if (b.next_run_at !== undefined) set('next_run_at', b.next_run_at ?? null);
      if (sets.length === 0) return cur.rows[0];
      sets.push('updated_at = now()');
      const r = await client.query(
        `UPDATE inspection_plan SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        params,
      );
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 手动生成下一期（暂停则拒绝）；生成后推进 next_run_at。
router.post('/plans/:id/generate', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const created = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM inspection_plan WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'plan not found', 404);
      const plan = cur.rows[0];
      if (plan.paused) throw new AppError('BAD_STATE', 'plan is paused', 409);
      const occurrenceDate = plan.next_run_at ? new Date(plan.next_run_at) : new Date();
      const out = await createPlanOccurrence(client, tenantId, plan, occurrenceDate);
      const next = addPlanInterval(occurrenceDate, plan.frequency, plan.interval_n);
      await client.query(`UPDATE inspection_plan SET next_run_at=$2, updated_at=now() WHERE id=$1`, [plan.id, toPgTs(next)]);
      return out;
    });
    return res.status(201).json({ ok: true, code: 0, count: created.length, items: created });
  } catch (e) {
    next(e);
  }
});

// ============ 统计报表（P2：闭合巡检“缺报表/统计”缺口） ============
// 汇总：总量、按状态分布、今日计划数、完成率、异常率、热点点位 Top5。
router.get('/stats', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const stats = await withTenantClient(tenantId, async (client) => {
      const byStatus = await client
        .query(
          `SELECT status, COUNT(*)::int AS c FROM inspection_task WHERE tenant_id=$1 GROUP BY status`,
          [tenantId],
        )
        .then((r) => r.rows);
      const total = byStatus.reduce((s, x) => s + Number(x.c), 0);
      const byStatusMap: Record<string, number> = {};
      for (const x of byStatus) byStatusMap[x.status] = Number(x.c);
      const done = byStatusMap['done'] ?? 0;
      const exception = byStatusMap['exception'] ?? 0;
      const pending = byStatusMap['pending'] ?? 0;
      const inProgress = byStatusMap['in_progress'] ?? 0;
      const today = await client
        .query(
          `SELECT COUNT(*)::int AS c FROM inspection_task WHERE tenant_id=$1 AND DATE(COALESCE(scheduled_at, created_at)) = CURRENT_DATE`,
          [tenantId],
        )
        .then((r) => Number(r.rows[0].c));
      const byPoint = await client
        .query(
          `SELECT p.name AS point_name, COUNT(*)::int AS c
           FROM inspection_task t LEFT JOIN inspection_point p ON p.id = t.point_id
           WHERE t.tenant_id=$1 AND t.point_id IS NOT NULL
           GROUP BY p.name ORDER BY c DESC LIMIT 5`,
          [tenantId],
        )
        .then((r) => r.rows.map((x: any) => ({ point_name: x.point_name, count: Number(x.c) })));
      // 按项合格率：已填实测的巡检项里，通过数 / 总实测数（无实测则诚实置 null，不虚构）。
      const itemAgg = await client
        .query(
          `SELECT
             COUNT(*)::int AS total_items,
             COUNT(*) FILTER (WHERE passed = true)::int AS passed,
             COUNT(*) FILTER (WHERE passed = false)::int AS failed
           FROM inspection_record WHERE tenant_id=$1`,
          [tenantId],
        )
        .then((r: any) => r.rows[0]);
      const totalItems = Number(itemAgg.total_items);
      const passedItems = Number(itemAgg.passed);
      const failedItems = Number(itemAgg.failed);
      return {
        total,
        by_status: byStatusMap,
        pending,
        in_progress: inProgress,
        done,
        exception,
        completion_rate: total ? Math.round((done / total) * 1000) / 10 : 0,
        exception_rate: total ? Math.round((exception / total) * 1000) / 10 : 0,
        today_count: today,
        by_point_top: byPoint,
        // 按项合格率：巡检实测通过率（无实测则为 null，诚实不虚构）。
        item_pass_rate: totalItems ? Math.round((passedItems / totalItems) * 1000) / 10 : null,
        item_stats: { total_items: totalItems, passed: passedItems, failed: failedItems },
      };
    });
    return res.json({ ok: true, code: 0, stats });
  } catch (e) {
    next(e);
  }
});

// 巡检月报 CSV 导出（含点位名、完成时间）。text/csv + BOM，前端直接下载。
router.get('/export', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { month } = req.query as Record<string, string>;
    const rows = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT t.id, t.title, t.type, t.status, t.assignee, p.name AS point_name,
                  t.scheduled_at, t.done_at, t.created_at, t.items_json
           FROM inspection_task t LEFT JOIN inspection_point p ON p.id = t.point_id
           WHERE t.tenant_id=$1 ${month ? 'AND TO_CHAR(COALESCE(t.scheduled_at, t.created_at), \'YYYY-MM\') = $2' : ''}
           ORDER BY t.scheduled_at ASC NULLS LAST, t.created_at DESC`,
          month ? [tenantId, month] : [tenantId],
        )
        .then((r) => r.rows),
    );
    // R30-F7：删除本地 esc（缺 R5-001 公式注入防护），统一走 csvUtil.csvEscape；
    // Date 列由 GMT 字符串变为 ISO 格式（csvEscape 对对象 JSON.stringify），机器可读性更好。
    const header = ['工单ID', '标题', '类型', '状态', '负责人', '点位', '计划时间', '完成时间', '创建时间', '检查项数量', '合格项数', '不合格项数'];
    const lines = rows.map((r: any) => {
      const items: any[] = Array.isArray(r.items_json) ? r.items_json : [];
      const passed = items.filter((x) => x.passed === true).length;
      const failed = items.filter((x) => x.passed === false).length;
      return [
        r.id,
        r.title,
        r.type === 'free' ? '自由巡检' : '计划巡检',
        r.status,
        r.assignee ?? '',
        r.point_name ?? '',
        r.scheduled_at ?? '',
        r.done_at ?? '',
        r.created_at ?? '',
        items.length,
        passed,
        failed,
      ]
        .map(csvEscape)
        .join(',');
    });
    const csv = '﻿' + [header.join(','), ...lines].join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="inspection_report_${month || 'all'}.csv"`);
    return res.send(csv);
  } catch (e) {
    next(e);
  }
});

export default router;
