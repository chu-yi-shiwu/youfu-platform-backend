// 运送模块（P2 第二刀）：运送订单 + 轨迹追踪。
// 状态流转统一走 workflow_def 引擎（TRANSPORT_DEF），不再硬编码状态机（红线）。
// 每次流转自动追加轨迹点（transport_track_point），前端按时间线回显"出发→在途→送达签收"。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requireConfigRole, requireAssigneeOrConfig } from '../middleware/role.js';
import { emitDomainEvent } from '../db/eventBus.js';
import { getWorkflowDefOrDefault } from '../engine/workflowDef.js';
import { applyEvent, availableTransitions } from '../engine/stateMachine.js';
import { TRANSPORT_DEF } from '../engine/themes.js';

/**
 * F-A2 纵深防御（三轮 QA 第一轮修复）：仅允许已知列名进入 UPDATE 的列名插值位，
 * 防止任何调用方误将用户输入当作列名插值进 SQL 导致注入。
 * parameterized：值走 $N 参数化；nowCols：写 now() 字面量（仅限白名单内的时间列）。
 */
export const ALLOWED_EXTRA_COLS = new Set(['depart_at', 'carrier', 'arrive_at', 'sign_at']);
export function filterTransportExtraCols(extra: Record<string, unknown>): {
  parameterized: string[];
  nowCols: string[];
} {
  const extraKeys = Object.keys(extra).filter((k) => ALLOWED_EXTRA_COLS.has(k));
  const parameterized = extraKeys.filter((k) => extra[k] !== 'now()');
  const nowCols = extraKeys.filter((k) => extra[k] === 'now()');
  return { parameterized, nowCols };
}

async function transitionOrder(
  client: any,
  tenantId: string,
  orderId: string,
  event: string,
  extra: Record<string, unknown> = {},
  track: { loc?: string; note?: string; lat?: number; lng?: number; photo?: string } = {},
  actor = 'config_role',
): Promise<any> {
  const cur = await client.query(`SELECT * FROM transport_order WHERE id = $1 AND tenant_id = $2`, [orderId, tenantId]);
  if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'order not found', 404);
  const t = cur.rows[0];
  const def = await getWorkflowDefOrDefault(client, tenantId, 'transport_task', TRANSPORT_DEF);
  const target = applyEvent(def, t.status, event);
  if (!target) {
    throw new AppError('BAD_STATE', `illegal transition ${t.status} --${event}-->`, 422);
  }
  const { parameterized: filteredKeys, nowCols } = filterTransportExtraCols(extra);
  const assigns = [
    'status = $3',
    ...filteredKeys.map((k, idx) => `${k} = $${4 + idx}`),
    ...nowCols.map((k) => `${k} = now()`),
  ];
  const values = [orderId, tenantId, target, ...filteredKeys.map((k) => extra[k])];
  const r = await client.query(
    `UPDATE transport_order SET ${assigns.join(', ')}, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    values,
  );
  const row = r.rows[0];
  // 轨迹点：每次流转留痕（含取件/签收照片凭证）
  await client.query(
    `INSERT INTO transport_track_point (tenant_id, order_id, event, loc, note, lat, lng, photo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [tenantId, orderId, event, track.loc ?? null, track.note ?? null, track.lat ?? null, track.lng ?? null, track.photo ?? null],
  );
  await emitDomainEvent(client, { tenantId, entityType: 'transport_order', entityId: orderId, type: event, actor });
  return row;
}

const router = Router();

// ============ 运送订单 ============
const orderSchema = z.object({
  item_name: z.string().min(1),
  from_loc: z.string().optional(),
  to_loc: z.string().optional(),
  carrier: z.string().optional(),
  priority: z.enum(['urgent', 'normal', 'low']).default('normal'),
  plan_depart_at: z.string().optional(),
  item_category: z.string().optional(), // UOne A3 物品分类（标本/药品/文件/器械...）
  order_type: z.enum(['scheduled', 'free']).default('scheduled'), // scheduled 计划运送 | free 自由运送
  work_order_id: z.string().optional(), // P2：来源工单（work_orders.id 为 text 且含 PILOT-WO-002 等非 uuid 业务单号，故用 string 不校验 uuid 形态，与 041 迁移的 text 列对齐）
});

router.get('/orders', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { status, priority, item_category, order_type, carrier } = req.query as Record<string, string>;
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      clauses.push(sql.replace(/\?/g, `$${params.length}`));
    };
    if (status) add('status = ?', status);
    if (priority) add('priority = ?', priority);
    if (item_category) add('item_category = ?', item_category);
    if (order_type) add('order_type = ?', order_type);
    if (carrier) add('carrier = ?', carrier); // #583：worker 工作台按归属拉自己的运送单
    const items = await withTenantClient(tenantId, async (client) => {
      const rows = await client
        .query(
          `SELECT * FROM transport_order WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`,
          params,
        )
        .then((r) => r.rows);
      // P2：回显关联工单号（工单可能属于同一租户；跨租户 RLS 下查不到则为 null，安全降级）
      for (const o of rows) {
        if (o.work_order_id) {
          const wo = await client
            .query('SELECT order_no, title, status FROM work_orders WHERE id=$1 AND tenant_id=$2', [o.work_order_id, tenantId])
            .then((r: any) => r.rows[0] ?? null);
          o.work_order = wo ? { order_no: wo.order_no, title: wo.title, status: wo.status } : null;
        } else {
          o.work_order = null;
        }
      }
      return rows;
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// 订单详情：返回订单 + 轨迹点 + 引擎算出的 available（前端动态渲染动作按钮）
router.get('/orders/:id', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM transport_order WHERE id = $1 AND tenant_id = $2`, [
        req.params.id,
        tenantId,
      ]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'order not found', 404);
      const o = cur.rows[0];
      const def = await getWorkflowDefOrDefault(client, tenantId, 'transport_task', TRANSPORT_DEF);
      const available = availableTransitions(def, o.status);
      const tracks = await client
        .query(
          `SELECT * FROM transport_track_point WHERE order_id=$1 AND tenant_id=$2 ORDER BY occurred_at ASC, created_at ASC`,
          [req.params.id, tenantId],
        )
        .then((r: any) => r.rows);
      // P2：关联工单回显（无关联或为 null 时安全降级）
      let workOrder: any = null;
      if (o.work_order_id) {
        workOrder = await client
          .query('SELECT order_no, title, status FROM work_orders WHERE id=$1 AND tenant_id=$2', [o.work_order_id, tenantId])
          .then((r: any) => r.rows[0] ?? null);
      }
      return { ...o, available, tracks, work_order: workOrder ? { order_no: workOrder.order_no, title: workOrder.title, status: workOrder.status } : null };
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.post('/orders', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = orderSchema.parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const r = await client.query(
        `INSERT INTO transport_order (tenant_id, code, item_name, from_loc, to_loc, carrier, priority, plan_depart_at, item_category, order_type, work_order_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending') RETURNING *`,
        [
          tenantId,
          `T${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
          b.item_name,
          b.from_loc ?? null,
          b.to_loc ?? null,
          b.carrier ?? null,
          b.priority,
          b.plan_depart_at ?? null,
          b.item_category ?? null,
          b.order_type,
          b.work_order_id ?? null,
        ],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'transport_order', entityId: row.id, type: 'create', actor: 'config_role' });
      return row;
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 手动追加轨迹点（在途汇报/中转备注）
router.post('/orders/:id/tracks', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ event: z.string().min(1), loc: z.string().optional(), note: z.string().optional(), lat: z.number().optional(), lng: z.number().optional(), photo: z.string().optional() }).parse(req.body);
    const point = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT id, carrier FROM transport_order WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'order not found', 404);
      // #583 归属守卫：worker 仅可为自己的运送单上报轨迹
      await requireAssigneeOrConfig(client, res.locals.auth, cur.rows[0].carrier, 'transport order');
      const r = await client.query(
        `INSERT INTO transport_track_point (tenant_id, order_id, event, loc, note, lat, lng, photo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [tenantId, req.params.id, b.event, b.loc ?? null, b.note ?? null, b.lat ?? null, b.lng ?? null, b.photo ?? null],
      );
      await emitDomainEvent(client, { tenantId, entityType: 'transport_order', entityId: req.params.id, type: 'track', actor: res.locals.auth.userId ?? 'config_role', payload: { event: b.event } });
      return r.rows[0];
    });
    return res.status(201).json({ ok: true, code: 0, item: point });
  } catch (e) {
    next(e);
  }
});

// 流转：派单/取件/送达签收/异常/取消（引擎校验 + 写库 + 轨迹点）
router.post('/orders/:id/transition', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { event, ...fields } = req.body as { event: string; [k: string]: unknown };
    if (!event || typeof event !== 'string') throw new AppError('BAD_REQUEST', 'event is required', 400);
    const extra: Record<string, unknown> = {};
    const track: { loc?: string; note?: string; lat?: number; lng?: number; photo?: string } = {};
    if (fields.loc) track.loc = String(fields.loc);
    if (fields.note) track.note = String(fields.note);
    if (fields.lat != null) track.lat = Number(fields.lat);
    if (fields.lng != null) track.lng = Number(fields.lng);
    if (fields.photo) track.photo = String(fields.photo); // 取件/签收照片凭证（防造假）
    if (event === 'dispatch') {
      extra.depart_at = 'now()';
      if (fields.carrier) extra.carrier = String(fields.carrier);
    }
    if (event === 'complete') {
      extra.arrive_at = 'now()';
      extra.sign_at = 'now()';
    }
    const item = await withTenantClient(tenantId, async (client) => {
      // #583 归属守卫：worker 仅可流转自己的运送单
      const cur = await client.query(`SELECT id, carrier FROM transport_order WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'order not found', 404);
      await requireAssigneeOrConfig(client, res.locals.auth, cur.rows[0].carrier, 'transport order');
      return transitionOrder(client, tenantId, req.params.id, event, extra, track, res.locals.auth.userId ?? 'config_role');
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

export default router;
