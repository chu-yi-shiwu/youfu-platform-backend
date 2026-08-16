// 工单路由：4 接口，response 严格对齐 05_frontend/src/services/workOrder.ts。
//  - POST /api/v1/open/work_order        (创建 + 自动派单)
//  - POST /api/v1/open/work_order/:id/transition
//  - GET  /api/v1/open/work_orders
//  - POST /api/v1/scan                    (M3 真实解析：目录/资产码识别)
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { createWithIdem, transition, list, findOne } from '../repo/ticket.js';
import { ticketStats } from '../repo/stats.js';
import { pickWorker, resolveDispatch, getActiveRules } from '../engine/dispatch.js';
import { AppError } from '../middleware/error.js';
import { resolveScanFromDb } from '../scan.js';
import { setSlaDueAt, slaScan, type SlaScanRow } from '../engine/sla.js';
import { dispatchEvent } from '../webhook/dispatch.js';
import { StatsModelBackend, type ModelBackend } from '../engine/model/ModelBackend.js';
import { incrementalLearn } from '../services/modelTrainer.js';
import { emitDomainEvent } from '../db/eventBus.js';
import type { WorkOrderStatus } from '../engine/stateMachine.js';
import { getWorkflowDef } from '../engine/workflowDef.js';
import { doneStates, terminalStates, availableTransitions, learningTriggerStates, autoRouteFor } from '../engine/stateMachine.js';

/** pg 驱动对 jsonb 可能返回字符串；统一归一化。 */
function safeParseJsonb(v: any): any {
  if (v == null) return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}

const router = Router();

const createSchema = z.object({
  id: z.string().min(1),
  business_type: z.string().min(1),
  catalog: z.string().optional(),
  priority: z.enum(['normal', 'urgent']).optional(),
  location: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  contact: z.string().optional(),
  assets: z.array(z.any()).optional(),
  // 派单所需技能线索（来自动态字段元数据，非写死业务值）
  skill_tags: z.array(z.string()).optional(),
  // UOne 颗粒度维度（取之所长）
  source: z.enum(['wechat', 'backend', 'phone']).optional(),
  fault_type: z.string().optional(),
  service_desk: z.string().optional(),
  ext: z.record(z.string(), z.unknown()).optional(),
});

// T-①：to 放开为任意状态字符串，合法性由 workflow_def（可配置状态机）在 transition() 内校验。
// 这样 C1 优化建议注入的 recheck / escalated 等新状态也能正常流转，无需改前端契约。
// score 为可选满意度评分（评价完成时回写 satisfaction_score）。
// .passthrough()：允许流转必填字段（return_reason/suspend_reason/close_reason/cancel_reason/assignee 等）透传校验。
const transitionSchema = z.object({
  to: z.string().min(1),
  score: z.number().int().min(0).max(5).optional(),
}).passthrough();

// 生成对齐前端的响应：未命中派单诚实返回 claim_hall（A 点确认）
// DEF-1 修复：code 仅作成功标记（0），真实业务工单号通过 order_no 返回。
// DEF-3 修复：返回内部 id（uuid）—— /transition/:id 需要它，否则建单后无法流转（契约错配）。
export function toCreateRes(row: any, autoFlow: boolean, assignee: string | null, reason: string, landedStatus = 'assigned') {
  const status: string = autoFlow ? landedStatus : 'claim_hall';
  return {
    ok: true, code: 0, id: row.id, order_no: row.order_no, status, auto_flow: autoFlow, assignee, reason,
    source: row.source ?? 'backend', fault_type: row.fault_type ?? null,
    service_desk: row.service_desk ?? null, ext: row.ext ?? {},
  };
}

// POST /api/v1/open/work_order
router.post('/open/work_order', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const idem = res.locals.auth.idempotencyKey;
    const body = createSchema.parse(req.body);
    const result = await withTenantClient(tenantId, async (client) => {
      const { row, created } = await createWithIdem(client, {
        id: body.id,
        tenantId,
        businessType: body.business_type,
        catalog: body.catalog,
        priority: body.priority,
        location: body.location,
        title: body.title,
        description: body.description,
        contact: body.contact,
        assets: body.assets,
        source: body.source,
        faultType: body.fault_type,
        serviceDesk: body.service_desk,
        ext: body.ext,
        idempotencyKey: idem,
      });
      // P4：建单即起算 SLA（draft 态即计时，符合"建单进入 SLA 计时"）
      const sla = setSlaDueAt(body.catalog, body.priority);
      await client.query(
        'UPDATE work_orders SET sla_minutes = $1, sla_due_at = $2 WHERE id = $3',
        [sla.slaMinutes, sla.dueAt, row.id],
      );
      // 自动派单：优先按 dispatch_rule 配置匹配；无命中降级 least_load 兜底（保持 M1-M3 已验证行为）
      const workers = await client.query(
        'SELECT id, skill_tags, load, active FROM worker WHERE tenant_id = $1',
        [tenantId],
      );
      const workerRows = workers.rows.map((w) => ({ ...w, skill_tags: safeParseJsonb(w.skill_tags) ?? [] }));
      const need = {
        business_type: body.business_type,
        skill_tags: body.skill_tags,
        priority: body.priority,
      };
      const rules = await getActiveRules(client, tenantId);
      // ④⑤ 模数共振：读 workflow_def.autoRoutes，决定本租户自动派发的目标态与策略（缺省保持旧行为：落 assigned、规则优先）
      const def = await getWorkflowDef(client, tenantId, 'work_order');
      const initial = def.initial;
      const route = autoRouteFor(def, initial);
      const dispatchTarget = route?.to ?? 'assigned';
      const useLeastLoadOnly = route?.strategy === 'least_load';
      // 派单自适应：加载租户模型（无则默认新模型），用模型评分参与候选排序
      const modelParams = await client.query<{ params: any }>(
        'SELECT params FROM model_state WHERE tenant_id = $1 AND model_key = $2',
        [tenantId, 'dispatch_score'],
      );
      const loadedParams = safeParseJsonb(modelParams.rows[0]?.params) ?? undefined;
      const model: ModelBackend = new StatsModelBackend(loadedParams);
      const resolved = useLeastLoadOnly ? null : resolveDispatch(workerRows, rules, need, model);
      const picked = resolved ? resolved.worker : pickWorker(workerRows, { skillTags: body.skill_tags });
      let autoFlow = false;
      let assignee: string | null = null;
      let reason = 'manual claim required';
      if (picked) {
        autoFlow = true;
        assignee = picked.id;
        reason = resolved ? resolved.reason : 'auto dispatched by least_load fallback';
        await client.query(
          'UPDATE work_orders SET status = $1, assignee_id = $2, auto_flow = true, updated_at = now() WHERE id = $3',
          [dispatchTarget, picked.id, row.id],
        );
        await client.query(
          'UPDATE worker SET load = load + 1 WHERE id = $1',
          [picked.id],
        );
        await client.query(
          `INSERT INTO ticket_event (tenant_id, work_order_id, type, from_status, to_status, actor, payload)
           VALUES ($1,$2,'assign',$3,$4,'auto_dispatch', $5)`,
          [tenantId, row.id, initial, dispatchTarget, JSON.stringify({ worker_id: picked.id })],
        );
        // ④ 口径对齐：domain_event.type 一律为"结果状态"（与 transition() 一致），自动派单落入 dispatchTarget。
        await emitDomainEvent(client, { tenantId, entityType: 'work_order', entityId: row.id, type: dispatchTarget, actor: 'auto_dispatch', payload: { worker_id: picked.id } });
      }
      const final = await findOne(client, tenantId, row.id);
      return { final, autoFlow, assignee, reason, created, dispatchTarget };
    });
    // P5 Webhook：主事务提交后 fire-and-forget 投递事件（失败不阻断主流程）
    const woId = result.final!.id;
    void dispatchEvent(tenantId, { type: 'create', workOrderId: woId, fromStatus: null, toStatus: 'draft', actor: 'system' }).catch(() => {});
    if (result.autoFlow) {
      void dispatchEvent(tenantId, { type: 'assign', workOrderId: woId, fromStatus: 'draft', toStatus: result.dispatchTarget, actor: 'auto_dispatch', payload: { worker_id: result.assignee } }).catch(() => {});
    }
    return res.status(result.created ? 201 : 200).json(
      toCreateRes(result.final, result.autoFlow, result.assignee, result.reason, result.dispatchTarget),
    );
  } catch (e) {
    next(e);
  }
});

// POST /api/v1/open/work_order/:id/transition
router.post('/open/work_order/:id/transition', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { to, score, ...rest } = transitionSchema.parse(req.body);
    const role = res.locals.auth.role;
    // 必填字段透传（含满意度评分映射），供 transition() 做 A+ 必填校验
    const fields: Record<string, unknown> = { ...rest };
    if (typeof score === 'number') fields.satisfaction_score = score;
    const before = await withTenantClient(tenantId, (client) => findOne(client, tenantId, req.params.id));
      let learnError: string | null = null;
      const row = await withTenantClient(tenantId, async (client) => {
        const r = await transition(client, tenantId, req.params.id, to as WorkOrderStatus, {
          actor: role ?? 'system',
          role,
          fields,
        });
        const woRow = r.row;
        // 工单进入"完成态"（def 派生：DEFAULT=completed；RICH=completed/closed/evaluated）即增量学习（数→模闭环）；
        // 仅在"首次踏入完成态"触发（避免 completed→closed→evaluated 间重复学习）；受 MODEL_AUTO_TUNE 控制是否写回。
        // 不静默吞错：失败记日志并回传 learn_error，便于试点验证定位根因（T-A 缺陷1修复）
        const def = await getWorkflowDef(client, tenantId, 'work_order');
        // ⑤ 模数共振：学习触发态优先读 def.config.learningTriggers（per-def 控制），缺省回退 doneStates（向后兼容）
        const learnOn = learningTriggerStates(def);
        if (learnOn.includes(to) && !(before?.status && learnOn.includes(before.status))) {
          try {
            await incrementalLearn(client, tenantId, req.params.id, process.env.MODEL_AUTO_TUNE === 'true');
          } catch (e) {
            learnError = e instanceof Error ? e.message : String(e);
            console.error('[T-A incrementalLearn] FAILED', { workOrderId: req.params.id, tenantId, err: e });
          }
        }
        // 评价完成回写满意度评分（UOne 满意度颗粒度）
        if (to === 'evaluated' && typeof score === 'number') {
          await client.query(
            'UPDATE work_orders SET satisfaction_score = $1 WHERE id = $2 AND tenant_id = $3',
            [score, req.params.id, tenantId],
          );
        }
        return r;
      });
      void dispatchEvent(tenantId, { type: 'transition', workOrderId: req.params.id, fromStatus: before?.status ?? null, toStatus: to, actor: 'system' }).catch(() => {});
      return res.json({ ok: true, code: 0, status: row.row.status, auto_flow: row.row.auto_flow, assignee: row.row.assignee_id, reason: 'transition ok', learn_error: learnError });
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/open/work_orders
router.get('/open/work_orders', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const status = req.query.status as WorkOrderStatus | undefined;
    const limit = Number(req.query.limit ?? 20);
    const offset = Number(req.query.offset ?? 0);
    const data = await withTenantClient(tenantId, (client) =>
      list(client, tenantId, { status, limit, offset }),
    );
    // A+ Phase3：随列表下发每个工单"当前状态可执行的转移"（含必填/角色门禁），供 SPA 动态渲染动作按钮。
    const def = await withTenantClient(tenantId, (client) => getWorkflowDef(client, tenantId, 'work_order'));
    // DEF-2 修复：列表项补充 order_no，供前端展示业务工单号
    const items = data.items.map((it: any) => ({
      ...it,
      code: it.order_no,
      available: availableTransitions(def, it.status).map((t) => ({
        to: t.to,
        event: t.event,
        requiredFields: t.requiredFields ?? [],
        allowedRoles: t.allowedRoles ?? [],
        sideEffects: t.sideEffects ?? [],
      })),
    }));
    return res.json({ ok: true, code: 0, items, total: data.total });
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/open/work_order/available?status=  —— 返回某状态下可执行的转移规则（前端动态渲染/权限判断用）。
// status 省略时返回初始态(initial)的可用转移。
router.get('/open/work_order/available', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const def = await withTenantClient(tenantId, (client) => getWorkflowDef(client, tenantId, 'work_order'));
    const status = (req.query.status as string) || def.initial;
    const available = availableTransitions(def, status).map((t) => ({
      from: t.from,
      to: t.to,
      event: t.event,
      requiredFields: t.requiredFields ?? [],
      allowedRoles: t.allowedRoles ?? [],
      sideEffects: t.sideEffects ?? [],
    }));
    return res.json({ ok: true, code: 0, status, available });
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/open/work_order/:id/events —— 工单事件流（前端工单详情时间线）
router.get('/open/work_order/:id/events', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT id, type, from_status, to_status, actor, payload, created_at
           FROM ticket_event WHERE tenant_id = $1 AND work_order_id = $2 ORDER BY created_at ASC`,
          [tenantId, req.params.id],
        )
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/open/work_order/:id —— 工单详情（单条）：含当前状态可执行的转移规则 + 事件流。
// A+ Phase4：供 SPA TicketDetail 动态渲染动作按钮（不再前端硬编码状态→事件映射）。
router.get('/open/work_order/:id', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const result = await withTenantClient(tenantId, async (client) => {
      const ticketRow = await findOne(client, tenantId, req.params.id);
      if (!ticketRow) return null;
      // 与列表接口对齐：补充 code（业务工单号）= order_no，供 SPA 详情页展示（DEF-2 修复一致性）。
      const ticket = { ...ticketRow, code: ticketRow.order_no };
      const def = await getWorkflowDef(client, tenantId, 'work_order');
      const available = availableTransitions(def, ticket.status).map((t) => ({
        from: t.from,
        to: t.to,
        event: t.event,
        requiredFields: t.requiredFields ?? [],
        allowedRoles: t.allowedRoles ?? [],
        sideEffects: t.sideEffects ?? [],
      }));
      const events = await client
        .query(
          `SELECT id, type, from_status, to_status, actor, payload, created_at
           FROM ticket_event WHERE tenant_id = $1 AND work_order_id = $2 ORDER BY created_at ASC`,
          [tenantId, req.params.id],
        )
        .then((r) => r.rows);
      return { ticket, available, events };
    });
    if (!result) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'work order not found' });
    return res.json({ ok: true, code: 0, ...result });
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/stats —— P6 自动派单率/自动闭环率口径（诚实，不编造演示数据）
router.get('/stats', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const stats = await withTenantClient(tenantId, (client) => ticketStats(client, tenantId));
    return res.json({ ok: true, code: 0, ...stats });
  } catch (e) {
    next(e);
  }
});

// POST /api/v1/scan —— M3 真实解析：目录码/资产码识别（替代前端 MSW 写死 mock）
// 生产化②：优先查库（asset_catalog/asset_registry），DB 权威、查不到诚实 unresolved。
// 契约与前端 services.scan 对齐：{ok,code,asset:{qr,resolved,note,...}}
router.post('/scan', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const schema = z.object({ raw: z.string().min(1) });
    const { raw } = schema.parse(req.body);
    const result = await resolveScanFromDb(tenantId, raw);
    // code 仅作成功标记（0），解析结构统一经 asset 字段透出（与前端 ScanButton 对齐）
    return res.json({ ok: true, code: 0, asset: result.asset });
  } catch (e) {
    next(e);
  }
});

// POST /api/v1/sla/scan —— P4 SLA 守护：扫本租户超时单，标记升级并 emit sla_escalated 事件
// 真实落库（与契约 §3.4 wo.sla_escalated 对齐）；纯扫描逻辑在 src/engine/sla.ts，便于单测。
router.post('/sla/scan', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
      const escalations = await withTenantClient(tenantId, async (client) => {
      // A+ Phase1.5：SLA 活跃集由 workflow_def 派生（排除完成态 ∪ 终态），
      // 与富模板对齐且不写死 4 态；DEFAULT 退化为排除 completed（同旧行为）。
      const def = await getWorkflowDef(client, tenantId, 'work_order');
      const slaExclude = Array.from(new Set([...doneStates(def), ...terminalStates(def)]));
      const active = await client.query<SlaScanRow>(
        `SELECT id, status, sla_due_at, escalated_at FROM work_orders
         WHERE tenant_id = $1 AND status <> ALL($2::text[])`,
        [tenantId, slaExclude],
      );
      const hits = slaScan(
        active.rows.map((r) => ({
          id: r.id,
          status: r.status as WorkOrderStatus,
          sla_due_at: r.sla_due_at,
          escalated_at: r.escalated_at,
        })),
        new Date(),
      );
      for (const h of hits) {
        await client.query(
          'UPDATE work_orders SET escalated_at = now() WHERE id = $1',
          [h.workOrderId],
        );
        await client.query(
          `INSERT INTO ticket_event (tenant_id, work_order_id, type, from_status, to_status, actor, payload)
           VALUES ($1,$2,'sla_escalated',$3,$3,'system',$4)`,
          [tenantId, h.workOrderId, h.fromStatus, JSON.stringify({ escal_minutes: h.escalMinutes, due_at: h.dueAt })],
        );
        await emitDomainEvent(client, { tenantId, entityType: 'work_order', entityId: h.workOrderId, type: 'sla_escalated', actor: 'system', payload: { escal_minutes: h.escalMinutes, due_at: h.dueAt } });
        // P5 Webhook：SLA 升级事件也对外投递
        void dispatchEvent(tenantId, {
          type: 'sla_escalated',
          workOrderId: h.workOrderId,
          fromStatus: h.fromStatus,
          toStatus: h.fromStatus,
          actor: 'system',
          payload: { escal_minutes: h.escalMinutes, due_at: h.dueAt },
        }).catch(() => {});
      }
      return hits;
    });
    return res.json({
      ok: true,
      code: 0,
      escalated: escalations.length,
      items: escalations.map((h) => ({ work_order_id: h.workOrderId, from_status: h.fromStatus, escal_minutes: h.escalMinutes })),
    });
  } catch (e) {
    next(e);
  }
});

export default router;
