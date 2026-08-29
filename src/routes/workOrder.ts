// 工单路由：4 接口，response 严格对齐 05_frontend/src/services/workOrder.ts。
//  - POST /api/v1/open/work_order        (创建 + 自动派单)
//  - POST /api/v1/open/work_order/:id/transition
//  - GET  /api/v1/open/work_orders
//  - POST /api/v1/scan                    (M3 真实解析：目录/资产码识别)
import { Router } from 'express';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { withTenantClient } from '../db/pool.js';
import { createWithIdem, transition, list, findOne, findOneForUpdate } from '../repo/ticket.js';
import { ticketStats } from '../repo/stats.js';
import { pickWorker, resolveDispatch, getActiveRules } from '../engine/dispatch.js';
import { AppError } from '../middleware/error.js';
import { requirePermission } from '../middleware/role.js';
import { resolveScanFromDb } from '../scan.js';
import { setSlaDueAt, slaScan, type SlaScanRow } from '../engine/sla.js';
import { dispatchEvent } from '../webhook/dispatch.js';
import { StatsModelBackend, type ModelBackend } from '../engine/model/ModelBackend.js';
import { incrementalLearn } from '../services/modelTrainer.js';
import { emitDomainEvent } from '../db/eventBus.js';
import { insertNotification, wechatSelfTest } from '../services/notify.js';
import type { WorkOrderStatus } from '../engine/stateMachine.js';
import { getWorkflowDef } from '../engine/workflowDef.js';
import { doneStates, terminalStates, availableTransitions, learningTriggerStates, autoRouteFor, shouldTriggerLearning } from '../engine/stateMachine.js';
import { safeParseJsonb } from '../util/jsonb.js';
import { validateIntake } from '../services/dataQuality.js';
import { buildRecommend } from '../services/dispatchRecommend.js';

const router = Router();

/**
 * 建单后自动派单（2026-08-29 从 POST /open/work_order handler 抽取为共享函数）：
 * 修复「公开报修单卡 draft、无派单、无通知、小程序通知点不开」的断链——公开报修与后台建单
 * 同一引擎待遇：SLA 起算 → dispatch_rule 匹配（降级 least_load）→ 流转 assigned + worker load+1
 * → 事件流 + domain_event + 派单通知 fan-out（含小程序 task-detail 深链）；无匹配落抢单大厅。
 * 须在 createWithIdem 的同一事务 client 内调用；幂等重放（created=false）不得调用（R9-001）。
 */
export async function autoDispatchAfterCreate(
  client: PoolClient,
  tenantId: string,
  row: { id: string; order_no: string },
  need: { business_type: string; skill_tags?: string[] | null; priority?: string | null; catalog?: string | null },
): Promise<{ autoFlow: boolean; assignee: string | null; reason: string; dispatchTarget: string }> {
  // P4：建单即起算 SLA（draft 态即计时，符合"建单进入 SLA 计时"）
  const prio = need.priority === 'urgent' || need.priority === 'normal' ? need.priority : undefined;
  const sla = setSlaDueAt(need.catalog ?? undefined, prio);
  await client.query('UPDATE work_orders SET sla_minutes = $1, sla_due_at = $2 WHERE id = $3', [sla.slaMinutes, sla.dueAt, row.id]);
  // 自动派单：优先按 dispatch_rule 配置匹配；无命中降级 least_load 兜底（保持 M1-M3 已验证行为）
  const workers = await client.query('SELECT id, skill_tags, load, active FROM worker WHERE tenant_id = $1', [tenantId]);
  const workerRows = workers.rows.map((w: any) => ({ ...w, skill_tags: safeParseJsonb(w.skill_tags) ?? [] }));
  const needPayload = { business_type: need.business_type, skill_tags: need.skill_tags ?? undefined, priority: prio };
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
  const resolved = useLeastLoadOnly ? null : resolveDispatch(workerRows, rules, needPayload, model);
  const picked = resolved ? resolved.worker : pickWorker(workerRows, { skillTags: need.skill_tags ?? undefined });
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
    await client.query('UPDATE worker SET load = load + 1 WHERE id = $1', [picked.id]);
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
      payload: { order_no: row.order_no, from_status: initial, to_status: dispatchTarget, page: `pages/worker/task-detail/task-detail?id=${row.id}` },
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
  return { autoFlow, assignee, reason, dispatchTarget };
}

const createSchema = z.object({
  id: z.string().min(1),
  business_type: z.string().min(1),
  catalog: z.string().optional(),
  priority: z.enum(['normal', 'urgent']).optional(),
  location: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  contact: z.string().optional(),
  reporter_name: z.string().optional(), // P1 收尾：申告人真实姓名（顶层列）
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
    // D3：录入端质量闸门（标题去噪/长度硬拒 + 电话/位置软提示）
    const q = validateIntake({
      title: body.title,
      location: body.location,
      reporter_phone: body.contact, // 建单电话字段为 contact
      contact: body.contact,
    });
    if (!q.ok) {
      return res.status(400).json({
        ok: false,
        code: 'BAD_DATA',
        message: '工单信息质量校验未通过',
        issues: q.issues,
        warnings: q.warnings,
      });
    }
    const result = await withTenantClient(tenantId, async (client) => {
      const { row, created } = await createWithIdem(client, {
        id: body.id,
        tenantId,
        businessType: body.business_type,
        catalog: body.catalog,
        priority: body.priority,
        location: body.location,
        title: q.normalized_title || body.title, // 用去噪后的标题
        description: body.description,
        contact: body.contact,
        reporterName: body.reporter_name,
        assets: body.assets,
        source: body.source,
        faultType: body.fault_type,
        serviceDesk: body.service_desk,
        department: body.department,
        ext: body.ext,
          idempotencyKey: idem,
        });
        // R9-001 修复：幂等重放（created=false）必须短路返回已存在工单，
        // 绝不能再跑派单 / 改状态 / 加 worker load —— 否则同键重试会重置在途工单并虚增负载。
        if (!created) {
          const final = await findOne(client, tenantId, row.id);
          return {
            final,
            autoFlow: final?.auto_flow ?? false,
            assignee: final?.assignee_id ?? null,
            reason: 'idempotent replay',
            created,
            dispatchTarget: final?.status ?? 'draft',
          };
        }
      // 自动派单（共享函数：公开报修路径复用同一逻辑，2026-08-29 抽取）
      const dispatch = await autoDispatchAfterCreate(client, tenantId, row, {
        business_type: body.business_type,
        skill_tags: body.skill_tags,
        priority: body.priority,
        catalog: body.catalog,
      });
      const final = await findOne(client, tenantId, row.id);
      return { final, autoFlow: dispatch.autoFlow, assignee: dispatch.assignee, reason: dispatch.reason, created, dispatchTarget: dispatch.dispatchTarget };
    });
    // P5 Webhook：主事务提交后 fire-and-forget 投递事件（失败不阻断主流程）
    const woId = result.final!.id;
    void dispatchEvent(tenantId, { type: 'create', workOrderId: woId, fromStatus: null, toStatus: 'draft', actor: 'system' }).catch(() => {});
    if (result.autoFlow) {
      void dispatchEvent(tenantId, { type: 'assign', workOrderId: woId, fromStatus: 'draft', toStatus: result.dispatchTarget, actor: 'auto_dispatch', payload: { worker_id: result.assignee } }).catch(() => {});
    }
    return res.status(result.created ? 201 : 200).json({
      ...toCreateRes(result.final, result.autoFlow, result.assignee, result.reason, result.dispatchTarget),
      warnings: q.warnings, // D3：软提示（位置/电话/术语建议），不阻断
    });
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
            payload: { order_no: r.row.order_no, event: r.transition.event, page: `pages/worker/task-detail/task-detail?id=${req.params.id}` },
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
          // 事务语义修复（2026-08-29 主轮加深测试轮3发现）：incrementalLearn 内任何 SQL 错误会把
          // 整个 PG 事务置为 aborted——原 try/catch 只是"记日志"，实际状态/事件全部回滚，接口却
          // 返回锁内内存值谎报成功。SAVEPOINT 隔离：学习失败仅回滚学习段，主流转（状态+事件）保真。
          await client.query('SAVEPOINT incremental_learn_sp');
          try {
            await incrementalLearn(client, tenantId, req.params.id, process.env.MODEL_AUTO_TUNE === 'true');
            await client.query('RELEASE SAVEPOINT incremental_learn_sp');
          } catch (e) {
            await client.query('ROLLBACK TO SAVEPOINT incremental_learn_sp');
            learnError = e instanceof Error ? e.message : String(e);
            console.error('[T-A incrementalLearn] FAILED (rolled back to savepoint, transition preserved)', { workOrderId: req.params.id, tenantId, err: e });
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
    // C-2：assignee 过滤（我的任务/某工人任务视图）；不传=全部
    const assignee = typeof req.query.assignee === 'string' && req.query.assignee ? req.query.assignee : undefined;
    // P-3：limit/offset 强制上限，防止调用方拉取整表（DoS 面）。
    const limit = Math.min(Math.max(1, Math.floor(Number(req.query.limit) || 20)), 200);
    const offset = Math.max(0, Math.min(Math.floor(Number(req.query.offset) || 0), 10000));
    const data = await withTenantClient(tenantId, (client) =>
      list(client, tenantId, { status, limit, offset, assignee }),
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

// POST /api/v1/open/work_order/:id/photos —— P0 移动 H5「现场拍照真落库」
// 把 base64 data URL 追加进 ext.photos（租户内隔离，跨 PC/H5 可见、刷新不丢）。
// 诚实：文件本身存于 DB jsonb（pilot 规模足够）；后续接入对象存储只需改此端点落 URL。
const photoSchema = z.object({
  photo: z.string().min(1).max(8 * 1024 * 1024), // data URL，限 8MB 防滥用
  caption: z.string().max(200).optional(),
});
const voiceSchema = z.object({
  url: z.string().min(1).max(500),           // /upload 返回的 URL
  voices: z.array(z.string().max(500)).optional(),
});
router.post('/open/work_order/:id/photos', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { photo, caption } = photoSchema.parse(req.body);
    const result = await withTenantClient(tenantId, async (client) => {
      const row = await findOneForUpdate(client, tenantId, req.params.id);
      if (!row) return null;
      const ext: Record<string, unknown> = row.ext && typeof row.ext === 'object' ? { ...row.ext } : {};
      const photos = Array.isArray(ext.photos) ? (ext.photos as any[]) : [];
      photos.push({ url: photo, caption: caption ?? null, at: new Date().toISOString() });
      ext.photos = photos;
      await client.query(
        'UPDATE work_orders SET ext = $1::jsonb, updated_at = now() WHERE id = $2 AND tenant_id = $3',
        [JSON.stringify(ext), req.params.id, tenantId],
      );
      return ext;
    });
    if (!result) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'work order not found' });
    return res.json({ ok: true, code: 0, ext: result });
  } catch (e) {
    next(e);
  }
});

// D1：语音留言追加（worker 录语音 → /upload 得 URL → 追加 ext.voice 数组）
router.post('/open/work_order/:id/voice', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { url, voices } = voiceSchema.parse(req.body);
    const result = await withTenantClient(tenantId, async (client) => {
      const row = await findOneForUpdate(client, tenantId, req.params.id);
      if (!row) return null;
      const ext: Record<string, unknown> = row.ext && typeof row.ext === 'object' ? { ...row.ext } : {};
      // 以服务端现有 voices 为基，合并客户端传入（去重）
      const existing = Array.isArray(ext.voice) ? (ext.voice as string[]) : [];
      const merged = Array.from(new Set([...existing, url, ...(Array.isArray(voices) ? voices : [])]));
      ext.voice = merged;
      await client.query(
        'UPDATE work_orders SET ext = $1::jsonb, updated_at = now() WHERE id = $2 AND tenant_id = $3',
        [JSON.stringify(ext), req.params.id, tenantId],
      );
      return ext;
    });
    if (!result) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'work order not found' });
    return res.json({ ok: true, code: 0, ext: result });
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/open/notifications —— 通知列表（?recipient= 过滤；缺省=租户全部）
// 审查修复：合并原 454(recipient 版) 与 585(全量版) 重复注册——Express 先注册先匹配，585 版永不生效。
// in_app 落库即可达；sms/push 为 stub 未真发，诚实标注。
router.get('/open/notifications', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const recipient = (req.query.recipient as string) || '';
    // 收件箱仅展示用户可见的站内信（in_app）。sms/push/wechat 为投递凭证（delivery receipt），
    // 已随 fan-out 在 dispatchNotification 落库，但不计入用户消息列表/未读数，避免每条派单出现重复条目。
    const conds = ['n.tenant_id = $1', "n.channel = 'in_app'"];
    const params: unknown[] = [tenantId];
    if (recipient) { params.push(recipient); conds.push(`n.recipient = $${params.length}`); }
    // 孤儿通知过滤（2026-08-29 bug 修复）：测试/清理路径删单不级联删通知时，
    // 通知指向已删工单 → 小程序点击进详情 404「打不开」。列表只展示工单仍存在的通知。
    conds.push(`EXISTS (SELECT 1 FROM work_orders wo WHERE wo.id = n.work_order_id)`);
    const rows = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT n.id, n.recipient, n.recipient_kind, n.type, n.title, n.body, n.channel, n.delivered, n.read, n.work_order_id, n.payload, n.created_at
           FROM notification n WHERE ${conds.join(' AND ')} ORDER BY n.created_at DESC LIMIT 100`,
          params,
        )
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items: rows });
  } catch (e) {
    next(e);
  }
});

// POST /api/v1/open/notifications/read —— 标记已读（body { ids?: string[] }；缺省=全部已读）
router.post('/open/notifications/read', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const body = z.object({ ids: z.array(z.string()).optional() }).parse(req.body ?? {});
    const result = await withTenantClient(tenantId, async (client) => {
      if (body.ids && body.ids.length > 0) {
        const r = await client.query(
          `UPDATE notification SET read = true WHERE tenant_id = $1 AND id = ANY($2::text[]) AND read = false RETURNING id`,
          [tenantId, body.ids],
        );
        return r.rowCount ?? 0;
      }
      const r = await client.query(`UPDATE notification SET read = true WHERE tenant_id = $1 AND read = false`, [tenantId]);
      return r.rowCount ?? 0;
    });
    return res.json({ ok: true, code: 0, marked: result });
  } catch (e) {
    next(e);
  }
});

// POST /api/v1/open/notify/selftest —— 微信订阅消息自检（工人单点：先授权→立即真发→返回原始 errcode）
// 不落库，直接对当前登录工人发起一次真实订阅消息发送，返回微信原始 errcode，供前端「微信通知自检」按钮屏上展示。
// 目的：消除「用户点允许 → relay 给后端手动重跑」的来回，实现通知链路自助验证闭环。
router.post('/open/notify/selftest', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const accountId = res.locals.auth.userId || '';
    // 解析当前登录工人（account_id 或 worker.id 任一匹配，兼容两种 userId 语义）
    const workerId = await withTenantClient(tenantId, (client) =>
      client
        .query<{ id: string }>(
          `SELECT w.id FROM worker w WHERE w.tenant_id = $1 AND (w.account_id = $2 OR w.id = $2) LIMIT 1`,
          [tenantId, accountId],
        )
        .then((r) => r.rows[0]?.id || null),
    );
    if (!workerId) {
      return res.json({ ok: false, code: 1, message: '未找到工人档案，请先绑定微信或账号' });
    }
    const result = await withTenantClient(tenantId, (client) =>
      wechatSelfTest(client, {
        tenantId,
        recipient: workerId,
        recipientKind: 'worker',
        type: 'dispatch',
        workOrderId: 'SELFTEST-' + Date.now(),
        title: '微信通知自检',
        body: '这是一条测试推送，用于验证订阅消息是否可达',
        payload: { assignee: '自检', status: '测试中' },
      }),
    );
    return res.json({ ok: true, code: 0, result });
  } catch (e) {
    next(e);
  }
});

// PATCH /api/v1/open/work_order/:id/ext —— P0 字段级配置：合并自定义字段值到 ext（租户隔离）
// 用于把业务流程配置的自定义字段（config.fields）在工单/业务流表单上填写后落库。
const extPatchSchema = z.object({ patch: z.record(z.string(), z.unknown()) });
router.patch('/open/work_order/:id/ext', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { patch } = extPatchSchema.parse(req.body);
    const result = await withTenantClient(tenantId, async (client) => {
      const row = await findOneForUpdate(client, tenantId, req.params.id);
      if (!row) return null;
      const ext: Record<string, unknown> = row.ext && typeof row.ext === 'object' ? { ...row.ext } : {};
      Object.assign(ext, patch);
      await client.query(
        'UPDATE work_orders SET ext = $1::jsonb, updated_at = now() WHERE id = $2 AND tenant_id = $3',
        [JSON.stringify(ext), req.params.id, tenantId],
      );
      return ext;
    });
    if (!result) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'work order not found' });
    return res.json({ ok: true, code: 0, ext: result });
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
      // R13-005 修复：slaScan 原本硬编码 SLA_ACTIVE=['draft','assigned','processing']，
      //   会静默丢弃富模板的 pending_accept/pending_dispatch/claim_hall/pending_review 等活跃态，
      //   致其永不被 SLA 升级。此处显式把"全态 − done − terminal − 挂起态"传给 slaScan，
      //   让活跃态真正受 SLA 约束（挂起态 freeze 时钟，按 sideEffect pause_sla 语义排除）。
      const def = await getWorkflowDef(client, tenantId, 'work_order');
      const slaExclude = Array.from(new Set([...doneStates(def), ...terminalStates(def)]));
      const activeStates = def.states.filter(
        (s) => !slaExclude.includes(s) && s !== 'paused' && s !== 'suspended',
      );
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
        activeStates,
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

// POST /api/v1/open/work_order/:id/transpond —— 转台（把工单从一个服务台转移到另一个服务台）
// 门禁：dispatch.override（RBAC 默认矩阵 admin/operator/dispatcher 有，worker 无）。
router.post('/open/work_order/:id/transpond', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const b = z.object({ deskId: z.string().min(1), reason: z.string().optional() }).parse(req.body);
    const ticket = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'dispatch.override');
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
          payload: { order_no: cur.order_no, from_desk: cur.service_desk, to_desk: b.deskId, page: `pages/worker/task-detail/task-detail?id=${req.params.id}` },
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
        .query(`SELECT * FROM work_orders WHERE ${conds.join(' AND ')} ORDER BY created_at ASC LIMIT 500`, params)
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
// C-2 身份根治：token userId 即 worker.id（id 同源），body workerId 不一致 403。
router.post('/open/work_order/:id/claim', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const role = res.locals.auth.role;
    if (role && !['worker', 'admin', 'dispatcher', 'service_desk', 'operator'].includes(role)) {
      throw new AppError('FORBIDDEN', `role ${role} not allowed to claim`, 403);
    }
    const b = z.object({ workerId: z.string().min(1).optional(), department: z.string().optional() }).parse(req.body);
    // C-2 身份根治：token 的 userId 即 worker.id（worker 与 account_user id 同源）。
    // 服务端只信 token 身份；body.workerId 仅兼容旧客户端——若传且与 token 身份不一致 → 403（堵伪造/替抢）。
    const authUserId = res.locals.auth.userId;
    if (b.workerId && authUserId && b.workerId !== authUserId) {
      throw new AppError('FORBIDDEN', 'workerId mismatch with authenticated identity', 403);
    }
    // P0 修复（2026-08-23 审查）：token 的 userId 是 account_user.id（uuid），而 worker.id 是业务编码。
    // 必须经 worker.account_id 反查真实 worker.id，不能直接拿 userId 当 worker.id 查。
    const workerId = authUserId ?? b.workerId!; // 优先 token 身份；无 token 身份时回退 body（兼容）
    const ticket = await withTenantClient(tenantId, async (client) => {
      const cur = await findOneForUpdate(client, tenantId, req.params.id);
      if (!cur) throw new AppError('NOT_FOUND', 'work order not found', 404);
      if (cur.status !== 'claim_hall' && cur.status !== 'pending_dispatch') {
        throw new AppError('CONFLICT', `work order not in claim hall (status=${cur.status})`, 409);
      }
      const worker = await client.query(
        'SELECT id, department FROM worker WHERE tenant_id=$2 AND (account_id=$1 OR id=$1) LIMIT 1',
        [workerId, tenantId],
      );
      if (worker.rowCount === 0) throw new AppError('NOT_FOUND', 'worker not found', 404);
      // P0 修复：assignee_id 统一存 worker.id（业务编码），与派单路径一致——不能用 token uuid
      const realWorkerId = worker.rows[0].id;
      const wDept = worker.rows[0].department;
      const woDept = cur.department;
      // 部门级抢单：工单与人员均有部门且不一致 → 驳回（保持简单，跨部由调度/管理员另行处理）
      if (woDept && wDept && woDept !== wDept) {
        throw new AppError('FORBIDDEN', `worker department ${wDept} mismatch work order department ${woDept}`, 403);
      }
      await client.query(
        'UPDATE work_orders SET status=$1, assignee_id=$2, auto_flow=false, updated_at=now() WHERE id=$3 AND tenant_id=$4',
        ['assigned', realWorkerId, req.params.id, tenantId],
      );
      await client.query('UPDATE worker SET load = load + 1 WHERE id=$1', [realWorkerId]);
      await client.query(
        `INSERT INTO ticket_event (tenant_id, work_order_id, type, from_status, to_status, actor, payload)
         VALUES ($1,$2,'claim',$3,$4,'worker',$5)`,
        [tenantId, req.params.id, cur.status, 'assigned', JSON.stringify({ worker_id: realWorkerId })],
      );
      await emitDomainEvent(client, { tenantId, entityType: 'work_order', entityId: req.params.id, type: 'assigned', actor: 'worker', payload: { worker_id: realWorkerId, via: 'claim' } });
      await insertNotification(client, {
        tenantId, recipient: realWorkerId, type: 'claim', workOrderId: req.params.id,
        title: '您已抢到工单', body: `工单 ${cur.order_no} 已由您认领`,
        payload: { order_no: cur.order_no, page: `pages/worker/task-detail/task-detail?id=${req.params.id}` },
      });
      return findOne(client, tenantId, req.params.id);
    });
    return res.json({ ok: true, code: 0, ticket });
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/open/dispatch-recommend —— 派单智能推荐（DMR 可解释呈现，dispatcher 端）。
// 当前工人（token 身份）今日工作台统计见下方 /open/me/summary。
// 只读推荐：基于 技能匹配 + 当前负载 的确定性评分，不写回任何配置（AUTO_TUNE 无关）。
// 诚实口径：无 worker 级满意度数据 → 理由不编造满意度；技能匹配 = 分类名/码与 worker.skill_tags 子串包含（≥2 字符）。
// 冷启动（无 dispatch_rule/UCB 数据）时依然有区分度：技能命中优先、负载低次之。
router.get('/open/dispatch-recommend', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const category = String((req.query as Record<string, string>).category || '').trim();
    const limit = Math.min(Number((req.query as Record<string, string>).limit) || 5, 10);
    const out = await withTenantClient(tenantId, async (client) => {
      // 1) 分类名（code → name，供技能匹配与理由展示）
      let catName = category;
      if (category) {
        const c = await client.query('SELECT name FROM fault_category WHERE tenant_id=$1 AND code=$2 LIMIT 1', [tenantId, category]);
        if (c.rows.length > 0 && c.rows[0].name) catName = c.rows[0].name;
      }
      // 2) 在岗工人（含技能与负载）
      const w = await client.query(
        `SELECT id, name, skill_tags, load, active FROM worker WHERE tenant_id=$1 AND active=true ORDER BY load ASC, name`,
        [tenantId],
      );
      if (w.rowCount === 0) return { items: [], cat_name: catName };
      // 3) 确定性评分排序（技能匹配 60 + 负载归一 40，理由可解释）
      const ranked = buildRecommend(
        w.rows.map((r) => ({ id: r.id, name: r.name, skill_tags: r.skill_tags, load: Number(r.load) || 0 })),
        catName,
        limit,
      );
      return { items: ranked, cat_name: catName };
    });
    return res.json({ ok: true, code: 0, ...out });
  } catch (e) {
    next(e);
  }
});

router.get('/open/me/summary', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const wid = res.locals.auth.userId;
    if (!wid) throw new AppError('UNAUTHORIZED', 'missing authenticated identity', 401);
    const s = await withTenantClient(tenantId, async (client) => {
      // P0 修复（2026-08-23 审查）：JWT sub=account_user.id（uuid），而 worker.id 是业务编码（如 w-elec-001）。
      // 必须经 worker.account_id 反查（046 已建列+唯一索引），并保留 id 兜底兼容同源场景。
      const w = await client.query(
        'SELECT id, name, skill_tags, load, active FROM worker WHERE tenant_id=$2 AND (account_id=$1 OR id=$1) LIMIT 1',
        [wid, tenantId],
      );
      if (w.rowCount === 0) return null;
      const workerId = w.rows[0].id; // 真实 worker.id（业务编码），后续统计/派单均用它
      const stats = await client.query(
        `SELECT
           COUNT(*) FILTER (WHERE status NOT IN ('completed','cancelled','claim_hall')) AS active_count,
           COUNT(*) FILTER (WHERE status IN ('completed')) AS done_count,
           COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE) AS today_new
         FROM work_orders WHERE tenant_id=$1 AND assignee_id=$2`,
        [tenantId, workerId],
      );
      return { worker: w.rows[0], stats: stats.rows[0] };
    });
    if (!s) throw new AppError('NOT_FOUND', 'worker profile not found', 404);
    return res.json({ ok: true, code: 0, ...s });
  } catch (e) {
    next(e);
  }
});

export default router;
