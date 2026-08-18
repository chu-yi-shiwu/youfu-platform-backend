// 工单路由：4 接口，response 严格对齐 05_frontend/src/services/workOrder.ts。
//  - POST /api/v1/open/work_order        (创建 + 自动派单)
//  - POST /api/v1/open/work_order/:id/transition
//  - GET  /api/v1/open/work_orders
//  - POST /api/v1/scan                    (M3 真实解析：目录/资产码识别)
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { createWithIdem, transition, list, findOne, findOneForUpdate } from '../repo/ticket.js';
import { ticketStats } from '../repo/stats.js';
import { pickWorker, resolveDispatch, getActiveRules } from '../engine/dispatch.js';
import { AppError } from '../middleware/error.js';
import { resolveScanFromDb } from '../scan.js';
import { setSlaDueAt, slaScan, type SlaScanRow } from '../engine/sla.js';
import { dispatchEvent } from '../webhook/dispatch.js';
import { StatsModelBackend, type ModelBackend } from '../engine/model/ModelBackend.js';
import { incrementalLearn } from '../services/modelTrainer.js';
import { emitDomainEvent } from '../db/eventBus.js';
import { insertNotification } from '../services/notify.js';
import type { WorkOrderStatus } from '../engine/stateMachine.js';
import { getWorkflowDef } from '../engine/workflowDef.js';
import { doneStates, terminalStates, availableTransitions, learningTriggerStates, autoRouteFor, shouldTriggerLearning } from '../engine/stateMachine.js';
import { safeParseJsonb } from '../util/jsonb.js';

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
  department: z.string().optional(),
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
export function toCreateRes(row: any, autoFlow: boolean, assignee: string | null, reason: string, _landedStatus = 'assigned') {
  return {
    ok: true, code: 0, id: row.id, order_no: row.order_no, status: row.status, auto_flow: autoFlow, assignee, reason,
    source: row.source ?? 'backend', fault_type: row.fault_type ?? null,
    service_desk: row.service_desk ?? null, department: row.department ?? null, ext: row.ext ?? {},
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
        department: body.department,
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
        // A5 派单通知：落库通知被派单人（sms/push 为 stub，诚实未真实发送）
        await insertNotification(client, {
          tenantId, recipient: picked.id, type: 'dispatch', workOrderId: row.id,
          title: '您有一条新工单', body: `工单 ${row.order_no} 已自动派给您`,
          payload: { order_no: row.order_no, from_status: initial, to_status: dispatchTarget },
        });
      } else {
        // 滴滴式未命中自动派单：归属抢单大厅（claim_hall），待人员抢单
        await client.query(
          'UPDATE work_orders SET status = $1, auto_flow = false, updated_at = now() WHERE id = $2',
          ['claim_hall', row.id],
        );
        await client.query(
          `INSERT INTO ticket_event (tenant_id, work_order_id, type, from_status, to_status, actor, payload)
           VALUES ($1,$2,'enter_hall',$3,$3,'system', $4)`,
          [tenantId, row.id, 'claim_hall', JSON.stringify({ reason: 'no worker auto-matched' })],
        );
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
    let learnError: string | null = null;
    const row = await withTenantClient(tenantId, async (client) => {
      const r = await transition(client, tenantId, req.params.id, to as WorkOrderStatus, {
        actor: role ?? 'system',
        role,
        fields,
      });
      const woRow = r.row;
      // A5 手动派单/改派通知（forward/dispatched 经通用 transition 触发）
      if (r.transition?.event === 'forward' || r.transition?.event === 'dispatch') {
        const newAssignee =
          (typeof fields.assignee === 'string' && fields.assignee)
            ? fields.assignee
            : r.row.assignee_id;
        if (newAssignee) {
          await insertNotification(client, {
            tenantId,
            recipient: newAssignee,
            type: r.transition.event === 'forward' ? 'forward' : 'dispatch',
            workOrderId: req.params.id,
            title: '工单已改派给您',
            body: `工单 ${r.row.order_no} 已指派给您`,
            payload: { order_no: r.row.order_no, event: r.transition.event },
          });
        }
      }
      // 工单进入"完成态"（def 派生：DEFAULT=completed；RICH=completed/closed/evaluated）即增量学习（数→模闭环）；
      // 仅在"首次踏入完成态"触发（避免 completed→closed→evaluated 间重复学习）；受 MODEL_AUTO_TUNE 控制是否写回。
      // 不静默吞错：失败记日志并回传 learn_error，便于试点验证定位根因（T-A 缺陷1修复）
      const def = await getWorkflowDef(client, tenantId, 'work_order');
      // ⑤ 模数共振：学习触发态优先读 def.config.learningTriggers（per-def 控制），缺省回退 doneStates（向后兼容）
      const learnOn = learningTriggerStates(def);
      // 用 transition() 锁内返回的 r.from（已加行锁，并发串行化）判定"首次进入"，杜绝事务外快照并发双触发。
      if (shouldTriggerLearning(to, r.from, learnOn)) {
        // 结构性幂等守卫（支柱④⑤ 兜底）：唯一键 (tenant_id, work_order_id, trigger_state) 保证
        // 即便过程式判定被绕过（如未来事件驱动 at-least-once 重放），同一"工单+触发态"也仅学一次。
        // INSERT ... ON CONFLICT DO NOTHING：rowCount===1 表示本次是首条，才真正调用增量学习。
        const guard = await client.query(
          `INSERT INTO ticket_learn_log (tenant_id, work_order_id, trigger_state, model_version)
           VALUES ($1,$2,$3,(SELECT version FROM model_state WHERE tenant_id=$1 AND model_key='dispatch_score'))
           ON CONFLICT (tenant_id, work_order_id, trigger_state) DO NOTHING`,
          [tenantId, req.params.id, to],
        );
        if (guard.rowCount === 1) {
          try {
            await incrementalLearn(client, tenantId, req.params.id, process.env.MODEL_AUTO_TUNE === 'true');
          } catch (e) {
            learnError = e instanceof Error ? e.message : String(e);
            console.error('[T-A incrementalLearn] FAILED', { workOrderId: req.params.id, tenantId, err: e });
          }
        } else {
          // 唯一键已存在：本次被结构性守卫拦截（重复学习），不调用、不报错（属正常幂等）。
          console.info('[T-A incrementalLearn] SKIPPED by idempotency guard', { workOrderId: req.params.id, tenantId, triggerState: to });
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
    void dispatchEvent(tenantId, { type: 'transition', workOrderId: req.params.id, fromStatus: row.from ?? null, toStatus: to, actor: 'system' }).catch(() => {});
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

// GET /api/v1/open/notifications —— 当前租户通知列表（按创建时间倒序，验证 A5 派单通知钩子用）
router.get('/open/notifications', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT id, recipient, recipient_kind, type, work_order_id, title, body, channel, delivered, read, created_at
           FROM notification WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100`,
          [tenantId],
        )
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items, total: items.length });
  } catch (e) {
    next(e);
  }
});

// POST /api/v1/open/work_order/:id/transpond —— 转台（把工单从一个服务台转移到另一个服务台）
// 门禁同 dispatch/forward：仅 admin/dispatcher/service_desk 可操作。
router.post('/open/work_order/:id/transpond', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const role = res.locals.auth.role;
    if (role && !['admin', 'dispatcher', 'service_desk'].includes(role)) {
      throw new AppError('FORBIDDEN', `role ${role} not allowed to transpond`, 403);
    }
    const b = z.object({ deskId: z.string().min(1), reason: z.string().optional() }).parse(req.body);
    const ticket = await withTenantClient(tenantId, async (client) => {
      const desk = await client.query('SELECT id, name FROM service_desk WHERE id=$1 AND tenant_id=$2', [b.deskId, tenantId]);
      if (desk.rowCount === 0) throw new AppError('NOT_FOUND', 'target service desk not found', 404);
      const cur = await findOneForUpdate(client, tenantId, req.params.id);
      if (!cur) throw new AppError('NOT_FOUND', 'work order not found', 404);
      await client.query(
        'UPDATE work_orders SET service_desk=$1, updated_at=now() WHERE id=$2 AND tenant_id=$3',
        [b.deskId, req.params.id, tenantId],
      );
      await client.query(
        `INSERT INTO ticket_event (tenant_id, work_order_id, type, from_status, to_status, actor, payload)
         VALUES ($1,$2,'transpond',$3,$3,'system',$4)`,
        [tenantId, req.params.id, cur.status, JSON.stringify({ from_desk: cur.service_desk, to_desk: b.deskId, reason: b.reason ?? null })],
      );
      await emitDomainEvent(client, { tenantId, entityType: 'work_order', entityId: req.params.id, type: 'transpond', actor: 'system', payload: { from_desk: cur.service_desk, to_desk: b.deskId } });
      // A5 转台通知：通知目标服务台（desk 级）+ 现任处理人
      await insertNotification(client, {
        tenantId, recipient: b.deskId, recipientKind: 'desk', type: 'transpond', workOrderId: req.params.id,
        title: '工单已转入本服务台', body: `工单 ${cur.order_no} 已转入服务台 ${desk.rows[0].name}`,
        payload: { order_no: cur.order_no, from_desk: cur.service_desk, to_desk: b.deskId },
      });
      if (cur.assignee_id) {
        await insertNotification(client, {
          tenantId, recipient: cur.assignee_id, type: 'transpond', workOrderId: req.params.id,
          title: '工单已转台', body: `工单 ${cur.order_no} 已转至服务台 ${desk.rows[0].name}`,
          payload: { order_no: cur.order_no, from_desk: cur.service_desk, to_desk: b.deskId },
        });
      }
      return findOne(client, tenantId, req.params.id);
    });
    return res.json({ ok: true, code: 0, ticket });
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/open/claim-hall —— 抢单大厅：列出未分配(claim_hall/pending_dispatch)工单，可按部门过滤
router.get('/open/claim-hall', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const department = req.query.department as string | undefined;
    const items = await withTenantClient(tenantId, (client) => {
      const conds = ['tenant_id=$1', "status IN ('claim_hall','pending_dispatch')"];
      const params: unknown[] = [tenantId];
      if (department) { params.push(department); conds.push(`department = $${params.length}`); }
      return client
        .query(`SELECT * FROM work_orders WHERE ${conds.join(' AND ')} ORDER BY created_at ASC`, params)
        .then((r) => r.rows);
    });
    const def = await withTenantClient(tenantId, (client) => getWorkflowDef(client, tenantId, 'work_order'));
    const out = items.map((it: any) => ({
      ...it,
      code: it.order_no,
      available: availableTransitions(def, it.status).map((t) => ({
        to: t.to, event: t.event, requiredFields: t.requiredFields ?? [], allowedRoles: t.allowedRoles ?? [], sideEffects: t.sideEffects ?? [],
      })),
    }));
    return res.json({ ok: true, code: 0, items: out, total: out.length });
  } catch (e) {
    next(e);
  }
});

// POST /api/v1/open/work_order/:id/claim —— 抢单（人员认领未分配工单，部门不匹配驳回）
// 门禁同 RICH def claim 转移：worker/admin/dispatcher/service_desk 可抢。
router.post('/open/work_order/:id/claim', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const role = res.locals.auth.role;
    if (role && !['worker', 'admin', 'dispatcher', 'service_desk', 'operator'].includes(role)) {
      throw new AppError('FORBIDDEN', `role ${role} not allowed to claim`, 403);
    }
    const b = z.object({ workerId: z.string().min(1), department: z.string().optional() }).parse(req.body);
    const ticket = await withTenantClient(tenantId, async (client) => {
      const cur = await findOneForUpdate(client, tenantId, req.params.id);
      if (!cur) throw new AppError('NOT_FOUND', 'work order not found', 404);
      if (cur.status !== 'claim_hall' && cur.status !== 'pending_dispatch') {
        throw new AppError('CONFLICT', `work order not in claim hall (status=${cur.status})`, 409);
      }
      const worker = await client.query('SELECT id, department FROM worker WHERE id=$1 AND tenant_id=$2', [b.workerId, tenantId]);
      if (worker.rowCount === 0) throw new AppError('NOT_FOUND', 'worker not found', 404);
      const wDept = worker.rows[0].department;
      const woDept = cur.department;
      // 部门级抢单：工单与人员均有部门且不一致 → 驳回（保持简单，跨部由调度/管理员另行处理）
      if (woDept && wDept && woDept !== wDept) {
        throw new AppError('FORBIDDEN', `worker department ${wDept} mismatch work order department ${woDept}`, 403);
      }
      await client.query(
        'UPDATE work_orders SET status=$1, assignee_id=$2, auto_flow=false, updated_at=now() WHERE id=$3 AND tenant_id=$4',
        ['assigned', b.workerId, req.params.id, tenantId],
      );
      await client.query('UPDATE worker SET load = load + 1 WHERE id=$1', [b.workerId]);
      await client.query(
        `INSERT INTO ticket_event (tenant_id, work_order_id, type, from_status, to_status, actor, payload)
         VALUES ($1,$2,'claim',$3,$4,'worker',$5)`,
        [tenantId, req.params.id, cur.status, 'assigned', JSON.stringify({ worker_id: b.workerId })],
      );
      await emitDomainEvent(client, { tenantId, entityType: 'work_order', entityId: req.params.id, type: 'assigned', actor: 'worker', payload: { worker_id: b.workerId, via: 'claim' } });
      await insertNotification(client, {
        tenantId, recipient: b.workerId, type: 'claim', workOrderId: req.params.id,
        title: '您已抢到工单', body: `工单 ${cur.order_no} 已由您认领`,
        payload: { order_no: cur.order_no },
      });
      return findOne(client, tenantId, req.params.id);
    });
    return res.json({ ok: true, code: 0, ticket });
  } catch (e) {
    next(e);
  }
});

export default router;
