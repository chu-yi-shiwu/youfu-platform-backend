// 工单路由：管理面 /admin/work-orders/*（模块门禁）与执行面 /open/*（仅 worker）双契约。
//  - POST /api/v1/admin/work-orders        (管理端创建 + 自动派单)
//  - POST /api/v1/open/work_order          (worker 执行建单：陪检/代报修)
//  - POST /api/v1/admin/work-orders/:id/transition / POST /api/v1/open/work_order/:id/transition
//  - GET  /api/v1/admin/work-orders        / GET /api/v1/open/work_orders
//  - POST /api/v1/scan                    (M3 真实解析：目录/资产码识别)
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { withTenantClient } from '../db/pool.js';
import { withTenantScope } from '../db/scope.js';
import { createWithIdem, transition, list, findOne, findOneForUpdate } from '../repo/ticket.js';
import { resolveWorkerIds } from '../repo/workerIdentity.js';
import { notificationOrphanGuardSql } from '../repo/notificationVisibility.js';
import { pickWorker, resolveDispatch, getActiveRules } from '../engine/dispatch.js';
import { resolveNeed } from '../engine/dispatch/needResolver.js';
import { AppError } from '../middleware/error.js';
import { requirePermission, requireAnyPermission, assertOpsRole, hasPerm } from '../middleware/role.js';
import { requireModule } from '../middleware/moduleGuard.js';
import { isSelfScope } from '../middleware/dataScope.js';
import { resolveScanFromDb } from '../scan.js';
import { resolveWorkbenchBuckets } from '../engine/workbenchBuckets.js';
import { setSlaDueAtWithMinutes } from '../engine/sla.js';
import { loadSlaPolicy, pickSlaPolicy, resolveSlaMinutesWithPolicy } from '../engine/slaPolicy.js';
import { runSlaScanForTenant } from '../scheduler/slaScheduler.js';
import { dispatchEvent } from '../webhook/dispatch.js';
import { StatsModelBackend, type ModelBackend } from '../engine/model/ModelBackend.js';
import { incrementalLearn } from '../services/modelTrainer.js';
// V2-F4（派单纵切 P0-10/11）：学习写回开关判定唯一来源（租户开关 + env 熔断/强制）
import { isAutoTuneEffective } from '../repo/tenantSettings.js';
import { emitDomainEvent } from '../db/eventBus.js';
import { insertNotification, wechatSelfTest } from '../services/notify.js';
import { claimWorkOrder } from '../services/claimWorkOrder.js';
import type { WorkOrderStatus, WorkflowDef } from '../engine/stateMachine.js';
import {
  getWorkflowDef,
  getWorkflowDefAtVersion,
  getDefsForVersions,
  getDefsAcrossAllVersions,
  unionStates,
  intersectStates,
} from '../engine/workflowDef.js';
import { CLAIM_HALL_STATE } from '../engine/claimHallEdges.js'; // F8：落抢单大厅走主通道（机制态单一事实源）
// 2026-11-01 抢单池统一：巡检/运送两区的池态用各自内置模板兜底（租户未配 def 时）
import { INSPECTION_DEF, TRANSPORT_DEF } from '../engine/themes.js';
import {
  DEFAULT_WORK_ORDER_DEF,
  availableTransitions, learningTriggerStates, shouldTriggerLearning,
  resolveDispatchTarget, activeStates, doneStates, terminalStates, claimableStates, evaluatedStates,
} from '../engine/stateMachine.js';
import { fetchMeTaskStats } from '../repo/meTaskStats.js';
import { safeParseJsonb } from '../util/jsonb.js';
import { validateIntake } from '../services/dataQuality.js';
import { buildRecommend } from '../services/dispatchRecommend.js';
import { assertAcceptanceBackdoorGuard } from '../services/acceptance.js'; // 批次三 Y3 防后门守卫
import { autoCreateSettlementForOrder, AUTO_SETTLEMENT_OPERATOR } from '../repo/settlement.js'; // E-9 自动结算（BUG-004）
import { autoRedispatchAfterReturn } from '../services/autoRedispatch.js'; // 洞①：退回自动回派

const router = Router();

// 管理面模块边界：/admin/work-orders/* 统一要求 work_order 模块。
// 移动端执行端点仍走 /open/*，但只允许 worker 角色，且只看到自己的任务。
router.use('/admin/work-orders', requireModule('work_order'));

const requireWorkerExecution: RequestHandler = (_req, res, next) => {
  const auth = res.locals.auth as { role?: string } | undefined;
  if (!auth || auth.role !== 'worker') {
    return next(new AppError('FORBIDDEN', 'worker execution endpoint', 403));
  }
  return next();
};

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
  row: { id: string; order_no: string; department_id?: string | null; department_source?: string | null },
  need: { business_type: string; skill_tags?: string[] | null; priority?: string | null; catalog?: string | null },
): Promise<{ autoFlow: boolean; assignee: string | null; reason: string; dispatchTarget: string }> {
  // P4：建单即起算 SLA（draft 态即计时，符合"建单进入 SLA 计时"）。
  // 租户在基础数据里配了 sla_policy ⇒ 以配置为准；没配（空表）⇒ 回退内置常量，分钟数逐字不变。
  const prio = need.priority === 'urgent' || need.priority === 'normal' ? need.priority : undefined;
  const slaPolicyRows = await loadSlaPolicy(client, tenantId);
  const slaPolicy = pickSlaPolicy(slaPolicyRows, {
    entityType: 'work_order',
    priority: need.priority ?? null,
  });
  const slaMinutes = resolveSlaMinutesWithPolicy({
    policy: slaPolicy,
    catalog: need.catalog ?? undefined,
    priority: need.priority ?? undefined,
  });
  const sla = setSlaDueAtWithMinutes(slaMinutes);
  await client.query('UPDATE work_orders SET sla_minutes = $1, sla_due_at = $2 WHERE id = $3', [sla.slaMinutes, sla.dueAt, row.id]);
  // 自动派单：优先按 dispatch_rule 配置匹配；无命中降级 least_load 兜底（保持 M1-M3 已验证行为）
  const workers = await client.query('SELECT id, skill_tags, load, active, department_id FROM worker WHERE tenant_id = $1', [tenantId]);
  const workerRows = workers.rows.map((w: any) => ({ ...w, skill_tags: safeParseJsonb(w.skill_tags) ?? [] }));
  // 需求走解析器链（engine/dispatch/needResolver.ts），不再在路由里写死"技能只能由调用方传"：
  // 调用方显式传了 → 以显式为准；没传 → 由目录/故障分类上配的技能派生（运营可配，用户零感知）。
  // 与影子回放共用同一个 resolveNeed，两侧不可能各造各的口径。
  const needPayload = await resolveNeed(
    {
      tenantId,
      entityType: 'work_order',
      business_type: need.business_type,
      priority: prio,
      skill_tags: need.skill_tags ?? undefined,
      catalog: need.catalog ?? undefined,
    },
    client,
  );
  // 默认部门是“待定归属”，不是派单范围：不按部门过滤，选中后再 late-bind 到师傅部门。
  // 明确部门（explicit/rule/manual）才做硬过滤；机动人员（department_id 为空）仍可参与。
  const dispatchDepartmentId = row.department_source === 'default' ? null : (row.department_id ?? null);
  const dispatchNeed = { ...needPayload, department_id: dispatchDepartmentId };
  const rules = await getActiveRules(client, tenantId);
  // ④⑤ 模数共振：读 workflow_def 决定本租户自动派发的目标态（resolveDispatchTarget：
  //   autoRoutes 优先 → 初态首条非终态转移 → 都没有则 422，绝不硬编码回退 'assigned'——
  //   租户 def 可能没有 assigned 态，写未知态=造失管单。见 engine/stateMachine.ts 注释）。
  const def = await getWorkflowDef(client, tenantId, 'work_order');
  const initial = def.initial;
  const dispatchTarget = resolveDispatchTarget(def, initial);
  if (!dispatchTarget) {
    throw new AppError(
      'BAD_REQUEST',
      '本租户流程未配置可用的自动派单路径：请在工作流配置里设置 autoRoutes（如 draft → assigned），或为初始态配置一条非终态转移边',
      422,
    );
  }
  // 系统派单唯一能自带的字段是 assignee（下方 picked.id）；解析边若要求其他必填字段，
  // 系统无法提供 → 明确 422，绝不静默跳过客户配在派单边上的门禁（那正是本修复要消灭的行为）。
  const dispatchEdge = (def.transitions ?? []).find((t) => t.from === initial && t.to === dispatchTarget);
  const unmetFields = (dispatchEdge?.requiredFields ?? []).filter((f) => f !== 'assignee');
  if (unmetFields.length > 0) {
    throw new AppError(
      'BAD_REQUEST',
      `自动派单目标转移要求必填字段 ${unmetFields.join(',')}，系统派单无法提供；请调整流程配置后重试`,
      422,
    );
  }
  // 2026-09-14 纵切② P0-1：strategy:'least_load' 不再短路规则匹配（t-phasea 实证规则被静默废掉；
  // 规则未命中时 resolveDispatch 返回 null，自然落 pickWorker 兜底，无规则租户行为不变）。
  // dispatchTarget（route?.to）逻辑不动：目标态仍由 autoRoutes 决定。
  // 派单自适应：加载租户模型（无则默认新模型），用模型评分参与候选排序
  const modelParams = await client.query<{ params: any }>(
    'SELECT params FROM model_state WHERE tenant_id = $1 AND model_key = $2',
    [tenantId, 'dispatch_score'],
  );
  const loadedParams = safeParseJsonb(modelParams.rows[0]?.params) ?? undefined;
  const model: ModelBackend = new StatsModelBackend(loadedParams);
  const resolved = resolveDispatch(workerRows, rules, dispatchNeed, model);
  // 洞③-2a（修「假中」）：兜底必须与 :196 **同一份口径**，用派生后的 needPayload.skill_tags，
  //   而不是调用方的原始 need.skill_tags。
  //   改前的问题链：resolveNeed 把目录/故障分类上配的技能派生进 needPayload.skill_tags，
  //   但兜底这一行仍读 need.skill_tags ⇒ 公开报修 / AI 建单不传 skill_tags 时它恒为 undefined
  //   ⇒ 传给 pickWorker 的 required=[] ⇒ dispatch.ts:43-45 的 [].every() 恒真
  //   ⇒ **只要有 1 名在岗工人就必中**，命中率的 71%~85% 是这么来的（数字好看，单派错人）。
  //   初一裁决 D-3：修假中，要真数字不要好看数字 ⇒ 派不中就老实落抢单大厅。
  const picked = resolved
    ? resolved.worker
    : pickWorker(workerRows, {
        skillTags: needPayload.skill_tags ?? undefined,
        departmentId: dispatchDepartmentId,
      });
  let autoFlow = false;
  let assignee: string | null = null;
  let reason = 'manual claim required';
  if (picked) {
    autoFlow = true;
    assignee = picked.id;
    reason = resolved ? resolved.reason : 'auto dispatched by least_load fallback';
    // F4（2026-10-19 根治）：派单从旁路手写 UPDATE 改为走 transition() 主通道——
    //   客户配在派单边上的 requiredFields / sideEffects / 自动审核规则（tryAutoAdvance）
    //   从此在自动路径同样生效，不再"人走门、系统翻墙"。
    //   F4 深修（systemActor）：allowedRoles/allowedPerms 是**人类**门禁（约束"谁能点按钮"），
    //   系统 actor 无角色可谈。客户在同一份 def 里配 autoRoutes（=显式授权系统沿此路自动
    //   派单）与 allowedRoles（=约束人类操作者）不矛盾：前者授权系统，后者约束人。
    //   若系统也守 allowedRoles，则任何配了角色门禁的派单边 = 自动派单永远 403，两个配置
    //   互相抵消——那不是从严，是让客户的配置变得无意义（生产实证：demo_tenant 开通样板
    //   的 submit 边带 allowedRoles=['admin','operator']，F4 首版即 403，见
    //   src/test/dispatchSystemActor.test.ts）。与 tryAutoAdvance 的 systemAuto 同源头：
    //   配置须客户显式启用，系统执行只跳过人类门禁；拓扑/必填/副作用/自动审核一个不跳。
    // 自动派单是系统动作：assignee 会改成别人。PostgreSQL UPDATE 新行还要过 SELECT 策略，
    // 所以只在这条赋值语句期间切 system；不把整个请求升级成 system。
    await withTenantScope(client, 'system', () =>
      transition(client, tenantId, row.id, dispatchTarget as WorkOrderStatus, {
        actor: 'auto_dispatch',
        fields: { assignee: picked.id },
        autoFlow: true,
        systemAuto: true,
        eventLogType: 'assign', // 事件流保持 assign 类型（publicReport 平均响应时长按它聚合）
        eventOverride: dispatchEdge?.event,
      }),
    );
    // A5 派单通知：落库通知被派单人（sms/push 为 stub，诚实未真实发送）。
    // transition() 不发通知（人工流转的通知由各端点负责），系统派单的 fan-out 保留在此。
    await insertNotification(client, {
      tenantId, recipient: picked.id, recipientKind: 'worker', type: 'dispatch', workOrderId: row.id,
      title: '您有一条新工单', body: `工单 ${row.order_no} 已自动派给您`,
      payload: { order_no: row.order_no, from_status: initial, to_status: dispatchTarget, page: `pages/worker/task-detail/task-detail?id=${row.id}` },
    });
  } else {
    // 滴滴式未命中自动派单：归属抢单大厅（claim_hall），待人员抢单。
    // F8（2026-10-19 根治）：与 F4 自动派单、F6 抢单同源——此处原本旁路手写 UPDATE，
    //   客户配在入厅边上的门禁（谁能落/要填什么/落了做什么）与留痕、里程碑全部落空。
    //   现走 transition() 主通道：拓扑、必填、副作用、里程碑、ticket_event/domain_event
    //   全部生效；入厅边（初态→claim_hall）由 claimHallEdges 机制注入，流程图上可见。
    //   systemAuto=true：系统执行只跳过人类角色/权限门禁（同 F4/F6 论证），拓扑/必填/
    //   副作用/自动审核一个不跳。事件 type 仍 'enter_hall'（存量消费方口径零影响）。
    // V2-F3（派单纵切 P0-8 失配观测，2026-09-14）：落大厅原因细分——
    //   no_available_worker = 本租户根本没有 active 工人（容量问题）；
    //   no_rule_matched      = 有在岗工人但规则/兜底都没接住（配置/技能失配问题，正是
    //                          §A-2「空调单派给电工」类历史事故的观测口）。
    //   计数经 GET /stats 的 claim_hall_reasons 聚合（repo/stats.ts 按 enter_hall 事件
    //   payload->>'reason' 分组），管理员可从 stats 面板直接看到两种失配的量级。
    //   走主通道后 reason 由 transition 的 payloadExtra 携带，聚合口径逐字保住。
    const hallReason = workerRows.some((w: { active: boolean }) => w.active)
      ? 'no_rule_matched'
      : 'no_available_worker';
    await transition(client, tenantId, row.id, CLAIM_HALL_STATE as WorkOrderStatus, {
      actor: 'auto_dispatch',
      autoFlow: false,
      systemAuto: true,
      eventLogType: 'enter_hall',
      eventOverride: 'enter_hall',
      payloadExtra: { reason: hallReason },
    });
    // 2026-09-14 纵切② P0-4：自动派单未命中此前无任何管理员感知（断链）——镜像
    // slaScheduler.ts admin fan-out 模式，通知本租户全部 active admin。
    // QA-P1 修正（2026-09-14）：withTenantClient 是 BEGIN→fn→COMMIT（db/pool.ts），通知段 SQL
    // 一旦真出错，整个 PG 事务进入 aborted 态——单纯 try/catch 吞错后外层 COMMIT 实为 ROLLBACK，
    // 工单创建静默消失但 API 谎报成功。故用 SAVEPOINT 隔离通知段（同 runIncrementalLearnStep 的
    // incremental_learn_sp 模式）：失败仅回滚通知段，事务恢复可用，claim_hall 主流程保真。
    await client.query('SAVEPOINT dispatch_notify_sp');
    try {
      const admins = await client.query<{ id: string }>(
        `SELECT id FROM account_user WHERE tenant_id=$1 AND role='admin' AND active=true`,
        [tenantId],
      );
      for (const a of admins.rows) {
        await insertNotification(client, {
          tenantId, recipient: a.id, recipientKind: 'account', type: 'dispatch', workOrderId: row.id,
          title: '工单进入抢单大厅', body: `工单 ${row.order_no} 自动派单未命中，已转入抢单大厅，请关注`,
          payload: { order_no: row.order_no, from_status: initial },
        });
      }
      await client.query('RELEASE SAVEPOINT dispatch_notify_sp');
    } catch (notifyErr) {
      await client.query('ROLLBACK TO SAVEPOINT dispatch_notify_sp');
      console.error('[autoDispatch] admin notification failed (non-blocking)', { workOrderId: row.id, err: notifyErr });
    }
  }
  return { autoFlow, assignee, reason, dispatchTarget };
}

/**
 * 完成态触发增量学习（④⑤ 数→模闭环）——2026-08-31 全维度审查 F2：从 transition handler
 * 抽取为可单测单元（原内联逻辑无法测试，SAVEPOINT 修复零回归护栏）。行为与抽取前逐行等价：
 *  - 仅"首次踏入学习触发态"才学（锁内 from 判定 + ticket_learn_log 唯一键结构性幂等双保险）；
 *  - SAVEPOINT 隔离学习段：incrementalLearn 内任何 SQL 错误仅回滚学习段，主流转（状态+事件）
 *    保真，learn_error 诚实回传（T-A 缺陷1修复，2026-08-29）。
 */
export async function runIncrementalLearnStep(
  client: PoolClient,
  tenantId: string,
  workOrderId: string,
  to: string,
  fromStatus: string | null | undefined,
  // 批 8：调用方可把同一份 defs 传进来复用。本函数在一个流转事务里与「评价态回写」相邻调用，
  //   各自取一次 = 两次 `SELECT DISTINCT def_version` 全租户扫描，且发生在持行锁期间。
  //   不传时行为与改动前完全一致（自己取一次）⇒ 其它调用点零影响。
  defs?: WorkflowDef[],
): Promise<{ triggered: boolean; learnError: string | null }> {
  // ⑤ 模数共振：学习触发态优先读 def.config.learningTriggers（per-def 控制），缺省回退 doneStates（向后兼容）
  // T1-B 多版本并存兜底：触发态是「包含」判定 ⇒ 取各版本**并集**——
  //   老单按旧流程走到学习触发态，若新流程里该态不再触发 ⇒ **老单不再产生学习样本**。
  const woDefs = defs ?? (await getDefsAcrossAllVersions(client, tenantId, 'work_order', 'work_orders', DEFAULT_WORK_ORDER_DEF));
  const learnOn = unionStates(woDefs.map(learningTriggerStates));
  if (!shouldTriggerLearning(to, String(fromStatus ?? ''), learnOn)) {
    return { triggered: false, learnError: null };
  }
  // 结构性幂等守卫（支柱④⑤ 兜底）：唯一键 (tenant_id, work_order_id, trigger_state) 保证
  // 即便过程式判定被绕过（如未来事件驱动 at-least-once 重放），同一"工单+触发态"也仅学一次。
  // INSERT ... ON CONFLICT DO NOTHING：rowCount===1 表示本次是首条，才真正调用增量学习。
  const guard = await client.query(
    `INSERT INTO ticket_learn_log (tenant_id, work_order_id, trigger_state, model_version)
     VALUES ($1,$2,$3,(SELECT version FROM model_state WHERE tenant_id=$1 AND model_key='dispatch_score'))
     ON CONFLICT (tenant_id, work_order_id, trigger_state) DO NOTHING`,
    [tenantId, workOrderId, to],
  );
  if (guard.rowCount !== 1) {
    // 唯一键已存在：本次被结构性守卫拦截（重复学习），不调用、不报错（属正常幂等）。
    console.info('[T-A incrementalLearn] SKIPPED by idempotency guard', { workOrderId, tenantId, triggerState: to });
    return { triggered: true, learnError: null };
  }
  // 事务语义修复（2026-08-29 主轮加深测试轮3发现）：incrementalLearn 内任何 SQL 错误会把
  // 整个 PG 事务置为 aborted——原 try/catch 只是"记日志"，实际状态/事件全部回滚，接口却
  // 返回锁内内存值谎报成功。SAVEPOINT 隔离：学习失败仅回滚学习段，主流转（状态+事件）保真。
  await client.query('SAVEPOINT incremental_learn_sp');
  try {
    // V2-F4（派单纵切 P0-10/11）：学习写回开关判定统一收敛到 isAutoTuneEffective 单一来源
    //（复用同事务 client 读租户开关，不再散读 env——此前 unset 恒 false ⇒ 租户开关对学习写回免疫）。
    // env=false 全局熔断语义保持：fail-safe 覆盖租户开关（生产行为不变）。
    const autoTune = await isAutoTuneEffective(tenantId, client);
    await incrementalLearn(client, tenantId, workOrderId, autoTune);
    await client.query('RELEASE SAVEPOINT incremental_learn_sp');
    return { triggered: true, learnError: null };
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT incremental_learn_sp');
    const learnError = e instanceof Error ? e.message : String(e);
    console.error('[T-A incrementalLearn] FAILED (rolled back to savepoint, transition preserved)', { workOrderId, tenantId, err: e });
    return { triggered: true, learnError };
  }
}

/**
 * 评价流转自动结算（E-9 §2.1 · BUG-004）——从 transition handler 抽取为可单测单元（照 runIncrementalLearnStep 先例）。
 *
 * 事务语义（本批核心裁决）：
 *  - SAVEPOINT auto_settle 包裹整段：自动结算内任何 SQL/业务错误 → ROLLBACK TO SAVEPOINT 隔离，
 *    **评价流转（work_orders.status='evaluated' + 事件）永远成功**，失败降级为响应里的 settle_error 标记；
 *  - 幂等：该工单已有任何结算明细 → autoCreateSettlementForOrder 入口预检直接跳过（非错误、不写库）；
 *  - 不吞错：错误信息原样透出 settle_error（照 learn_error 先例），人工可经 POST /settlements 补建。
 */
export async function runAutoSettleStep(
  client: PoolClient,
  tenantId: string,
  workOrderId: string,
  operator: string = AUTO_SETTLEMENT_OPERATOR,
): Promise<{ created: boolean; skipped: boolean; settlementId: string | null; settleError: string | null }> {
  await client.query('SAVEPOINT auto_settle');
  try {
    const r = await autoCreateSettlementForOrder(client, tenantId, workOrderId, operator);
    await client.query('RELEASE SAVEPOINT auto_settle');
    return { created: r.created, skipped: r.skipped, settlementId: r.settlementId, settleError: null };
  } catch (e) {
    await client.query('ROLLBACK TO SAVEPOINT auto_settle');
    const settleError = e instanceof Error ? e.message : String(e);
    console.error('[BUG-004 autoSettle] FAILED (rolled back to savepoint, transition preserved)', {
      workOrderId,
      tenantId,
      err: e,
    });
    return { created: false, skipped: false, settlementId: null, settleError };
  }
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
  department: z.string().optional(), // 旧字段兼容：值按 department_id 处理
  department_id: z.string().uuid().optional(),
  ext: z.record(z.string(), z.unknown()).optional(),
});

// T-①：to 放开为任意状态字符串，合法性由 workflow_def（可配置状态机）在 transition() 内校验。
// 这样 C1 优化建议注入的 recheck / escalated 等新状态也能正常流转，无需改前端契约。
// score 为可选满意度评分（评价完成时回写 satisfaction_score）。
// .passthrough()：允许流转必填字段（return_reason/suspend_reason/close_reason/cancel_reason/assignee 等）透传校验。
// 批次三（QA 修复②）：schema 不收 via——客户端自证 via='acceptance' 不可信（可绕过验收联动），
// 通用端点对 acceptance_* 事件一律 403（守卫无条件，见下方 handler）；
// 专用验收端点走 service 层（applyAcceptance）直调 transition()，不经本路由守卫，无功能损失。
const transitionSchema = z.object({
  to: z.string().min(1),
  score: z.number().int().min(0).max(5).optional(),
}).passthrough();

// 生成对齐前端的响应：未命中派单诚实返回 claim_hall（A 点确认）
// DEF-1 修复：code 仅作成功标记（0），真实业务工单号通过 order_no 返回。
// DEF-3 修复：返回内部 id（uuid）—— /transition/:id 需要它，否则建单后无法流转（契约错配）。
// F10：删掉从未被使用的 _landedStatus 形参——它的默认值 assigned 是个隐患：
//   默认值暗示派单目标可以兜底成 assigned，与 F4「严禁硬编码回退」的决议正面冲突，
//   而返回体根本不含这个字段，纯粹是误导。
/**
 * 工单流转后的共享副作用：增量学习、评价自动结算、资产维修状态回写。
 * 通用 /open/work_order/:id/transition 与公共报修 token 评价共用，避免两套口径漂移。
 */
export async function finalizeTransitionSideEffects(
  client: PoolClient,
  tenantId: string,
  workOrderId: string,
  to: string,
  from: string,
): Promise<{ learnError: string | null; settleError: string | null }> {
  const woDefs = await getDefsAcrossAllVersions(client, tenantId, 'work_order', 'work_orders', DEFAULT_WORK_ORDER_DEF);
  const learnStep = await runIncrementalLearnStep(client, tenantId, workOrderId, to, from, woDefs);
  const evaluatedSet = unionStates(woDefs.map(evaluatedStates));
  let settleError: string | null = null;
  if (evaluatedSet.includes(to)) {
    const settleStep = await runAutoSettleStep(client, tenantId, workOrderId);
    settleError = settleStep.settleError;
  }
  const woDoneSet = unionStates(woDefs.map(doneStates));
  const isDone = woDoneSet.includes(to);
  const isTerminal = isDone || to === 'cancelled' || to === 'closed';
  if (isTerminal) {
    const woActiveSet = unionStates(woDefs.map(activeStates));
    const restored = await client.query(
      `UPDATE asset SET status='in_use', updated_at=now()
        WHERE tenant_id=$1 AND status='repairing' AND $2::text = ANY(linked_order_ids::text[])
          AND NOT EXISTS (
            SELECT 1 FROM work_orders w
             WHERE w.tenant_id=$1 AND w.id = ANY(linked_order_ids::text[])
               AND w.id <> $2::text AND w.status = ANY($3::text[])
          )
        RETURNING id`,
      [tenantId, workOrderId, woActiveSet],
    );
    for (const a of restored.rows as Array<{ id: string }>) {
      await emitDomainEvent(client, {
        tenantId,
        entityType: 'asset',
        entityId: a.id,
        type: isDone ? 'asset_repair_done' : 'asset_repair_cancelled',
        actor: 'system',
        payload: { work_order_id: workOrderId, to_status: to },
      });
    }
  }
  return { learnError: learnStep.learnError, settleError };
}

export function toCreateRes(row: any, autoFlow: boolean, assignee: string | null, reason: string) {
  return {
    ok: true, code: 0, id: row.id, order_no: row.order_no, status: row.status, auto_flow: autoFlow, assignee, reason,
    source: row.source ?? 'backend', fault_type: row.fault_type ?? null,
    department_id: row.department_id ?? null,
    department_source: row.department_source ?? null,
    department_name: row.department_name ?? null,
    ext: row.ext ?? {},
  };
}

// POST /api/v1/open/work_order
const handleCreateWorkOrder: RequestHandler = async (req, res, next) => {
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
      // #942 R15 修复：建单权限点由 ticket.manage 改为 intake.create | ticket.manage（任一）。
      // 背景：陪检登记（#6）等登录态录入复用建单引擎且入口在工人工作台全员可见，
      // 仅挂 ticket.manage 把 worker 登记陪检当场 403（真机实锤 permission denied）。
      // 语义对齐 serviceDesk 建单（intake.create）——录入≠管理；worker 仅解锁录入面，
      // ticket.manage 的其余管理面（流转配置等）对 worker 仍 403，无权限放大。
      // C 端公开报修走 /public/report（publicReportRouter，免登录），不受本门禁影响。
      await requireAnyPermission(res.locals.auth, client, ['intake.create', 'ticket.manage']);
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
        departmentId: body.department_id ?? body.department,
        ext: body.ext,
          idempotencyKey: idem,
        });
        // R9-001 修复：幂等重放（created=false）必须短路返回已存在工单，
        // 绝不能再跑派单 / 改状态 / 加 worker load —— 否则同键重试会重置在途工单并虚增负载。
        if (!created) {
          // 幂等重放：工单可能已自动派给别人，worker 的 self RLS 看不到；
          // 响应读取必须切 system，否则重试会 500（2026-11-10 实锤）。
          const final = await withTenantScope(client, 'system', () => findOne(client, tenantId, row.id));
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
      // 自动派单可能把单派给别人，worker 的 self RLS 看不到自己刚建的单；
      // 这里读的是“本次创建的工单”用于响应，切 system 只影响这一条读取。
      const final = await withTenantScope(client, 'system', () => findOne(client, tenantId, row.id));
      return { final, autoFlow: dispatch.autoFlow, assignee: dispatch.assignee, reason: dispatch.reason, created, dispatchTarget: dispatch.dispatchTarget };
    });
    // P5 Webhook：主事务提交后 fire-and-forget 投递事件（失败不阻断主流程）
    const woId = result.final!.id;
    void dispatchEvent(tenantId, { type: 'create', workOrderId: woId, fromStatus: null, toStatus: 'draft', actor: 'system' }).catch(() => {});
    if (result.autoFlow) {
      void dispatchEvent(tenantId, { type: 'assign', workOrderId: woId, fromStatus: 'draft', toStatus: result.dispatchTarget, actor: 'auto_dispatch', payload: { worker_id: result.assignee } }).catch(() => {});
    }
    return res.status(result.created ? 201 : 200).json({
      ...toCreateRes(result.final, result.autoFlow, result.assignee, result.reason),
      warnings: q.warnings, // D3：软提示（位置/电话/术语建议），不阻断
    });
  } catch (e) {
    next(e);
  }
};
// 执行面建单：worker 陪检/代报修等移动执行场景，不得被 work_order 模块门禁误伤。
router.post('/open/work_order', requireWorkerExecution, handleCreateWorkOrder);
// 管理面建单：PC/员工管理端，受 work_order 模块门禁。
router.post('/admin/work-orders', handleCreateWorkOrder);

// POST /api/v1/open/work_order/:id/transition
const handleWorkOrderTransition: RequestHandler = async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    // 批次三（QA 修复②）：via 已从 schema 移除；显式丢弃 body 里的 via（防 passthrough 污染 fields/payload）
    const { to, score, via: _ignoredVia, ...rest } = transitionSchema.parse(req.body);
    void _ignoredVia;
    const role = res.locals.auth.role;
    // 评分只能走受 zod 校验的 score（0-5）；passthrough 的 satisfaction_score 一律丢弃，
    // 防止绕过 min/max 直接写库（113 CHECK 会拒，但那是 500 而不是 422）。
    delete rest.satisfaction_score;
    // 必填字段透传（含满意度评分映射），供 transition() 做 A+ 必填校验
    const fields: Record<string, unknown> = { ...rest };
    if (typeof score === 'number') fields.satisfaction_score = score;
    let learnError: string | null = null;
    let settleError: string | null = null; // E-9：自动结算失败标记（SAVEPOINT 隔离后透出，不阻断评价）
    const row = await withTenantClient(tenantId, async (client) => {
      // P0-4（2026-11-04）：worker 只能流转本人名下工单。
      // 身份解析与 /open/notifications/read 同口径：account_id 或 worker.id 任一命中，
      // 返回**全部**档案 id（同人多档案脏数据不漏判）。非 worker 不解析、不传参 ⇒ 行为不变。
      const actorWorkerIds =
        isSelfScope(role)
          ? await resolveWorkerIds(client, tenantId, res.locals.auth.userId)
          : undefined;
      const r = await transition(client, tenantId, req.params.id, to as WorkOrderStatus, {
        actor: role ?? 'system',
        // 评价分数出现即视为“本人评价”动作；不允许管理员/工人代评。
        requireReporterUserId: typeof score === 'number' ? res.locals.auth.userId : undefined,
        role,
        // 地基第二步：allowedPerms 门禁由 transition() 内部惰性取权限点（仅声明 allowedPerms
        // 的转移才查库），调用方无需透传——存量路径零额外查询、零行为变化。
        fields,
        actorWorkerIds,
      });
      // 审查修复（架构🔴1）：本端点**不加** ticket.manage 权限点——
      //   ① 流转已由引擎的 tdef.allowedRoles 门禁把关（src/repo/ticket.ts transition()），
      //      再叠权限点属双重门禁且会误伤 worker 接单/完成动作（工人默认矩阵无 ticket.manage）；
      //   ② 验收类事件另有 Y3 无条件守卫，通用端点绝不可走验收流转。
      // 批次三 Y3 防后门（QA 修复②：无条件版）：验收事件只允许走专用验收端点。
      // 通用 transition 端点只要触发 acceptance_* 事件 → 一律 403（不看任何客户端自证标记），
      // 抛错令整个事务回滚（验收状态/凭证/事件全部不落库），堵"传 via 绕过验收联动"的后门路径。
      assertAcceptanceBackdoorGuard(r.transition?.event);
      // 洞①（2026-10-28，初一裁定）：工人退回 ⇒ 自动回派给别人，**排除刚退回的那个工人**。
      //   排除集 = row.assignee_id（退回不清空该列，见 repo/ticket.ts:264→:290→:308 实证）∪ 显式排除。
      //   回派失败（排除后无人在岗 / 达上限）⇒ **落池 + 升级喊人**（D-1），**绝不自动关单**（D-2）。
      // 挂在路由层而非 transition() 内核的理由见设计文档 §1.1（内核拿不到操作人 + systemAuto 递归风险）。
      const redispatch = await autoRedispatchAfterReturn(client, tenantId, r.row, {
        event: r.transition?.event,
        actor: role ?? 'system',
      });
      // 回派成功 ⇒ r.row 里的 status/assignee 已过期（transition 已把单推进 assigned）。
      //   不修正会让客户端拿到"待派单"的假状态（工单实际已派给新人，但界面还停在池里）。
      if (redispatch.redispatch && redispatch.assignee) {
        r.row = { ...r.row, status: redispatch.target ?? r.row.status, assignee_id: redispatch.assignee };
      }
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
            recipientKind: 'worker',
            type: r.transition.event === 'forward' ? 'forward' : 'dispatch',
            workOrderId: req.params.id,
            title: '工单已改派给您',
            body: `工单 ${r.row.order_no} 已指派给您`,
            payload: { order_no: r.row.order_no, event: r.transition.event, page: `pages/worker/task-detail/task-detail?id=${req.params.id}` },
          });
        }
      }
      // 完成态触发增量学习——抽取为 runIncrementalLearnStep（2026-08-31 审查 F2：原内联逻辑
      // 无法单测，SAVEPOINT 修复零回归护栏）。行为与抽取前逐行等价，learn_error 语义不变。
      // 批 8：学习段与评价段**共用同一份 defs** —— 各取一次会让一次流转跑两条
      //   `SELECT DISTINCT def_version FROM work_orders`（全租户扫描，且发生在 FOR UPDATE 持锁期间）。
      //   由 evaluatedStatesHttp.test.ts「一次流转只扫一次 def_version」守卫。
      const side = await finalizeTransitionSideEffects(client, tenantId, req.params.id, to, r.from);
      learnError = side.learnError;
      settleError = side.settleError;
      return r;
    });
    void dispatchEvent(tenantId, { type: 'transition', workOrderId: req.params.id, fromStatus: row.from ?? null, toStatus: to, actor: 'system' }).catch(() => {});
      return res.json({ ok: true, code: 0, status: row.row.status, auto_flow: row.row.auto_flow, assignee: row.row.assignee_id, reason: 'transition ok', learn_error: learnError, settle_error: settleError });
  } catch (e) {
    next(e);
  }
};
router.post('/open/work_order/:id/transition', requireWorkerExecution, handleWorkOrderTransition);
router.post('/admin/work-orders/:id/transition', handleWorkOrderTransition);

// GET /api/v1/open/work_orders
const handleListWorkOrders: RequestHandler = async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const status = req.query.status as WorkOrderStatus | undefined;
    // C-2：assignee 过滤（我的任务/某工人任务视图）；不传=全部
    const assignee = typeof req.query.assignee === 'string' && req.query.assignee ? req.query.assignee : undefined;
    // 决策 #8：服务端筛选四参（可选、精确匹配、语义同 status/assignee）；query 全是 string，
    // 缺省/空串统一归一为 undefined = 不过滤（与旧版行为完全一致）。
    const qstr = (k: string): string | undefined => {
      const v = req.query[k];
      return typeof v === 'string' && v ? v : undefined;
    };
    const departmentId = qstr('department_id') ?? qstr('department');
    const departmentUnassigned = req.query.department_unassigned === '1' || req.query.department_unassigned === 'true';
    const bucket = qstr('bucket');
    if (bucket && status) {
      throw new AppError('BAD_PARAM', 'bucket 与 status 互斥，不能同时传', 400);
    }
    if (departmentId && departmentUnassigned) {
      throw new AppError('BAD_PARAM', 'department_id 与 department_unassigned 互斥，不能同时传', 400);
    }
    const priority = qstr('priority');
    const source = qstr('source');
    // P1：business_type 精确匹配过滤（不传=不过滤，零回归）
    const businessType = qstr('business_type');
    // P-3：limit/offset 强制上限，防止调用方拉取整表（DoS 面）。
    const limit = Math.min(Math.max(1, Math.floor(Number(req.query.limit) || 20)), 200);
    const offset = Math.max(0, Math.min(Math.floor(Number(req.query.offset) || 0), 10000));
    // 批次三：unsettled=1 → 只返回未被任何结算单占用的工单（结算页"新建结算"数据源）
    const unsettled = req.query.unsettled === '1' || req.query.unsettled === 'true';
    // 工作台下钻（#949 续）纯加法：三个可选布尔开关（'1'/'true' 均真，风格同 unsettled），不传=不过滤。
    //   auto_flow=1 → 只回自动流转单（auto_flow = true）；
    //   today=1     → 只回当日创建单（created_at::date = CURRENT_DATE，与统计卡 today_new 同口径）；
    //   timeout=1   → 只回超时且未闭环单（sla_due_at 已过且未进终态，终态口径复用 SLA 扫描排除集）。
    const autoFlow = req.query.auto_flow === '1' || req.query.auto_flow === 'true';
    const todayOnly = req.query.today === '1' || req.query.today === 'true';
    const timeoutOnly = req.query.timeout === '1' || req.query.timeout === 'true';
    // 行级可见性由 work_orders RLS 兜底（110_principal_rls.sql）：
    //   worker → 本人 / 自己创建且未分派；operator/admin/reviewer → 全租户。
    // 路由不再写 MASTER_ROLES，也不再“查不到档案就放行全量”。
    const data = await withTenantClient(tenantId, async (client) => {
      // bucket 下钻：用与 /stats/workbench 同一个桶映射转成状态集合。
      let effectiveStatus = status as string | undefined;
      if (bucket) {
        const def = await getWorkflowDef(client, tenantId, 'work_order');
        const map = resolveWorkbenchBuckets(def);
        if (bucket === 'other') {
          const known = new Set<string>([
            ...map.pending, ...map.hall, ...map.active, ...map.done, ...map.cancelled,
          ]);
          const r = await client.query<{ status: string }>(
            `SELECT DISTINCT status FROM work_orders WHERE tenant_id = $1`,
            [tenantId],
          );
          const other = r.rows.map((x) => x.status).filter((s) => !known.has(s));
          effectiveStatus = other.length ? other.join(',') : '__none__';
        } else {
          const statuses = (map as Record<string, string[]>)[bucket];
          if (!statuses) throw new AppError('BAD_PARAM', `unknown bucket: ${bucket}`, 400);
          effectiveStatus = statuses.length ? statuses.join(',') : '__none__';
        }
      }
      return list(client, tenantId, {
        status: effectiveStatus as WorkOrderStatus | undefined,
        limit, offset, assignee, unsettledOnly: unsettled,
        // 决策 #8：四参透传（不传 = 不过滤，零回归）
        departmentId, departmentUnassigned,
        priority, source,
        // P1：business_type 透传（不传 = 不过滤，零回归）
        businessType,
        // 工作台下钻（#949 续）：三参透传（不传 = 不过滤，零回归）
        autoFlow, todayOnly, timeoutOnly,
      });
    });
    // A+ Phase3：随列表下发每个工单"当前状态可执行的转移"（含必填/角色门禁），供 SPA 动态渲染动作按钮。
    // T1-B 批4：N 行可能锁着不同版本 ⇒ 改前「先读一次 def 再 .map() 套到 N 行」本质上不成立
    //   （老单会凭空拿到新版本的按钮，点了才 422）。按 def_version 分组，几个版本查几次。
    //   list() 的行是 `SELECT wo.*` ⇒ def_version 天然在位，无需拓宽 SELECT。
    const defs = await withTenantClient(tenantId, (client) => getDefsForVersions(client, tenantId, 'work_order', data.items, DEFAULT_WORK_ORDER_DEF));
    // DEF-2 修复：列表项补充 order_no，供前端展示业务工单号
    const items = data.items.map((it: any) => ({
      ...it,
      code: it.order_no,
      available: availableTransitions(defs.get(Number(it.def_version) || 0)!, it.status).map((t) => ({
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
};
router.get('/open/work_orders', requireWorkerExecution, handleListWorkOrders);
router.get('/admin/work-orders', handleListWorkOrders);

// GET /api/v1/open/work_order/available?status=  —— 返回某状态下可执行的转移规则（前端动态渲染/权限判断用）。
// status 省略时返回初始态(initial)的可用转移。
const handleWorkOrderAvailable: RequestHandler = async (req, res, next) => {
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
};
router.get('/admin/work-orders/available', handleWorkOrderAvailable);

// GET /api/v1/open/work_order/:id/events —— 工单事件流（前端工单详情时间线）
const handleWorkOrderEvents: RequestHandler = async (req, res, next) => {
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
};
router.get('/admin/work-orders/:id/events', handleWorkOrderEvents);

// GET /api/v1/open/work_order/:id —— 工单详情（单条）：含当前状态可执行的转移规则 + 事件流。
// A+ Phase4：供 SPA TicketDetail 动态渲染动作按钮（不再前端硬编码状态→事件映射）。
const handleWorkOrderDetail: RequestHandler = async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const result = await withTenantClient(tenantId, async (client) => {
      // RLS 已按请求 scope 过滤：worker 查别人单返回 null → 404，不再需要端点守卫。
      const ticketRow = await findOne(client, tenantId, req.params.id);
      if (!ticketRow) return null;
      // 与列表接口对齐：补充 code（业务工单号）= order_no，供 SPA 详情页展示（DEF-2 修复一致性）。
      const ticket = { ...ticketRow, code: ticketRow.order_no };
      // T1-B 批4：详情 available 必须与写侧用同一个版本化 def，否则按钮与实际校验不一致
      //   （列表按锁版本渲染 → 点了 transition 才发现这条边在那版里不存在 ⇒ 422）。
      //   ticketRow 来自 findOne（`SELECT wo.*`）⇒ def_version 天然在位，无需拓宽 SELECT。
      const def = await getWorkflowDefAtVersion(client, tenantId, 'work_order', Number(ticketRow.def_version) || 0, DEFAULT_WORK_ORDER_DEF);
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
      // 工单 → 资产互通：以 asset.linked_order_ids 为唯一事实源，不新增重复的外键列。
      // 工单 ID 是 text（陪检单存在 escort-* 非 UUID），linked_order_ids 是 uuid[]；
      // 统一按 text 比较，避免非 UUID 工单详情被 ::uuid 强转打成 400。
      const asset = await client
        .query(
          `SELECT id, asset_no, name, location, status
             FROM asset
            WHERE tenant_id=$1 AND $2::text = ANY(linked_order_ids::text[])
            LIMIT 1`,
          [tenantId, req.params.id],
        )
        .then((r) => r.rows[0] ?? null);
      return { ticket, available, events, asset };
    });
    if (!result) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'work order not found' });
    return res.json({ ok: true, code: 0, ...result });
  } catch (e) {
    next(e);
  }
};
router.get('/open/work_order/:id', requireWorkerExecution, handleWorkOrderDetail);
router.get('/admin/work-orders/:id', handleWorkOrderDetail);

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
const handleWorkOrderPhotos: RequestHandler = async (req, res, next) => {
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
};
router.post('/open/work_order/:id/photos', requireWorkerExecution, handleWorkOrderPhotos);
// 管理面代报修创建后同样要能补照片；与执行面共用同一个 handler，只按契约分路径。
router.post('/admin/work-orders/:id/photos', handleWorkOrderPhotos);

// D1：语音留言追加（worker 录语音 → /upload 得 URL → 追加 ext.voice 数组）
const handleWorkOrderVoice: RequestHandler = async (req, res, next) => {
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
};
router.post('/open/work_order/:id/voice', requireWorkerExecution, handleWorkOrderVoice);
router.post('/admin/work-orders/:id/voice', handleWorkOrderVoice);

// GET /api/v1/open/notifications —— 通知列表（?recipient= 可选过滤；缺省=本人收件箱）
// 审查修复：合并原 454(recipient 版) 与 585(全量版) 重复注册——Express 先注册先匹配，585 版永不生效。
// P0-3（2026-11-04）：原缺省路径返回**全租户** in_app 通知，任意登录账号可读取他人消息。
//   现与 /open/notifications/read 同口径：当前身份集合 = auth.userId ∪ resolveWorkerIds，
//   ?recipient= 只允许是集合内身份（否则 403）；身份解析不出 → 422，绝不降级为全租户。
// in_app 落库即可达；sms/push 为 stub 未真发，诚实标注。
router.get('/open/notifications', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const recipient = typeof req.query.recipient === 'string' ? req.query.recipient.trim() : '';
    // 收件箱仅展示用户可见的站内信（in_app）。sms/push/wechat 为投递凭证（delivery receipt），
    // 已随 fan-out 在 dispatchNotification 落库，但不计入用户消息列表/未读数，避免每条派单出现重复条目。
    const rows = await withTenantClient(tenantId, async (client) => {
      // 本人身份集合（recipient 可能是 worker.id 或 account_user.id，双路并集）。
      const identity = new Set<string>([auth.userId || '']);
      for (const wid of await resolveWorkerIds(client, tenantId, auth.userId)) identity.add(wid);
      identity.delete('');
      if (identity.size === 0) {
        throw new AppError('IDENTITY_UNRESOLVED', '无法解析当前账号收件身份，拒绝读取通知', 422);
      }
      if (recipient && !identity.has(recipient)) {
        throw new AppError('FORBIDDEN', '只能查看本人收件箱', 403);
      }
      const recipients = Array.from(identity);
      const conds = ['n.tenant_id = $1', "n.channel = 'in_app'", 'n.recipient = ANY($2::text[])'];
      const params: unknown[] = [tenantId, recipients];
      if (recipient) {
        params.push(recipient);
        conds.push(`n.recipient = $${params.length}`);
      }
      // 孤儿通知过滤（2026-08-29 bug 修复）：测试/清理路径删单不级联删通知时，
      // 通知指向已删工单 → 小程序点击进详情 404「打不开」。列表只展示单仍存在的通知。
      // P0-6（2026-11-07）：运送单通知借位存放 work_order_id，按 payload.entity_type 分流；
      //   单一事实源见 repo/notificationVisibility.ts（含跨租户对齐说明）。
      conds.push(notificationOrphanGuardSql());
      return client
        .query(
          `SELECT n.id, n.recipient, n.recipient_kind, n.type, n.title, n.body, n.channel, n.delivered, n.read, n.work_order_id, n.payload, n.created_at
           FROM notification n WHERE ${conds.join(' AND ')} ORDER BY n.created_at DESC LIMIT 100`,
          params,
        )
        .then((r) => r.rows);
    });
    return res.json({ ok: true, code: 0, items: rows });
  } catch (e) {
    next(e);
  }
});

// POST /api/v1/open/notifications/read —— 标记已读（body { ids?: string[] }；缺省=本人收件箱全部已读）
// 审查修复（横切⑦ B-1）：原实现两条路径均只按 tenant_id 限定——任意登录账号可把
// **全租户**（含他人）的通知置已读（缺省路径），或按 id 把**他人**的通知置已读
// （ids 路径无 recipient 校验）。已读不可逆（读态覆盖未读提醒），必须收口到本人收件箱。
// 口径：当前登录身份集合 = auth.userId ∪ resolveWorkerIds 结果（worker 通知 recipient=
// worker.id、账号通知 recipient=account_user.id，双路身份覆盖两种 recipient_kind）。
// 身份解析不出（空集合）→ 422 拒绝：置已读不可逆，绝不做"全租户"降级放行。
router.post('/open/notifications/read', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const body = z.object({ ids: z.array(z.string().uuid()).optional() }).parse(req.body ?? {});
    const result = await withTenantClient(tenantId, async (client) => {
      // 本人身份集合（recipient 可能是 worker.id 或 account_user.id，双路并集）
      const identity = new Set<string>([auth.userId || '']);
      for (const wid of await resolveWorkerIds(client, tenantId, auth.userId)) identity.add(wid);
      identity.delete('');
      if (identity.size === 0) {
        throw new AppError('IDENTITY_UNRESOLVED', '无法解析当前账号收件身份，拒绝批量置已读', 422);
      }
      const recipients = Array.from(identity);
      if (body.ids && body.ids.length > 0) {
        const r = await client.query(
          `UPDATE notification SET read = true
           WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND recipient = ANY($3::text[]) AND read = false
           RETURNING id`,
          [tenantId, body.ids, recipients],
        );
        return r.rowCount ?? 0;
      }
      // 缺省路径收窄为「本人收件箱全部已读」，禁止全租户
      const r = await client.query(
        `UPDATE notification SET read = true WHERE tenant_id = $1 AND recipient = ANY($2::text[]) AND read = false`,
        [tenantId, recipients],
      );
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
    // 自检会真实调用微信订阅消息接口（消耗接口配额）——
    // 运维角色保留门禁；worker 是自检的实际使用者，只允许对自己的档案发起。
    if (res.locals.auth.role !== 'worker') assertOpsRole(res.locals.auth);
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
// 权限（2026-11-10 放宽，窄口）：ticket.manage 可改全部白名单字段；
//   工单承接人（worker 且 assignee_id 命中本人档案）只允许改 feedback_note（现场备注）。
// 白名单：patch 键 ⊆ 租户 workflow_def(work_order).config.fields 键集 + 内置 feedback_note。
//   保留键 public_view_token / attachments / voice 仍硬拒（uploads.ts / 专属端点依赖）。
const extPatchSchema = z.object({ patch: z.record(z.string(), z.unknown()) });
const EXT_RESERVED_KEYS: readonly string[] = ['public_view_token', 'attachments', 'voice'];
const handleWorkOrderExt: RequestHandler = async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const { patch } = extPatchSchema.parse(req.body);
    const patchKeys = Object.keys(patch);
    const reservedHit = patchKeys.filter((k) => EXT_RESERVED_KEYS.includes(k));
    if (reservedHit.length > 0) {
      throw new AppError('EXT_RESERVED_KEY', `保留键不可经本端点修改: ${reservedHit.join(', ')}`, 403);
    }
    const result = await withTenantClient(tenantId, async (client) => {
      const row = await findOneForUpdate(client, tenantId, req.params.id);
      if (!row) return null;

      // 窄口：承接人只改现场备注；管理面仍走 ticket.manage。
      const isWorkerNoteOnly =
        auth.role === 'worker' &&
        patchKeys.length > 0 &&
        patchKeys.every((k) => k === 'feedback_note');
      let workerOwnsTicket = false;
      if (isWorkerNoteOnly) {
        const workerIds = await resolveWorkerIds(client, tenantId, auth.userId);
        workerOwnsTicket = !!row.assignee_id && workerIds.includes(row.assignee_id);
      }
      const canManage = await hasPerm(auth, client, 'ticket.manage');
      if (!canManage && !workerOwnsTicket) {
        throw new AppError('FORBIDDEN', 'permission denied: ticket.manage', 403);
      }

      // 白名单口径：与 FE TicketDetail 同源——租户 workflow_def(work_order).config.fields 键集
      // + 内置 feedback_note（mini program 现场备注字段）。
      const def = await getWorkflowDef(client, tenantId, 'work_order');
      const rawFields = def.config?.fields;
      const configuredKeys = Array.isArray(rawFields)
        ? rawFields
            .map((f: unknown) => (f && typeof f === 'object' && 'key' in (f as Record<string, unknown>) ? String((f as Record<string, unknown>).key) : ''))
            .filter((k) => k !== '')
        : [];
      const allowed = [...configuredKeys, 'feedback_note'];
      const illegal = patchKeys.filter((k) => !allowed.includes(k));
      if (illegal.length > 0) {
        throw new AppError('EXT_FIELD_NOT_ALLOWED', `字段不在流程自定义字段白名单内: ${illegal.join(', ')}`, 422);
      }
      if ('feedback_note' in patch && (typeof patch.feedback_note !== 'string' || patch.feedback_note.length > 2000)) {
        throw new AppError('BAD_PARAM', 'feedback_note 必须是不超过 2000 字的字符串', 422);
      }

      const ext: Record<string, unknown> = row.ext && typeof row.ext === 'object' ? { ...row.ext } : {};
      const before: Record<string, unknown> = {};
      for (const k of patchKeys) before[k] = ext[k] ?? null;
      Object.assign(ext, patch);
      await client.query(
        'UPDATE work_orders SET ext = $1::jsonb, updated_at = now() WHERE id = $2 AND tenant_id = $3',
        [JSON.stringify(ext), req.params.id, tenantId],
      );
      // audit 留痕：仅在有实际变更键时写（空 patch 不产生事件噪音）
      if (patchKeys.length > 0) {
        await client.query(
          `INSERT INTO ticket_event (tenant_id, work_order_id, type, from_status, to_status, actor, payload)
           VALUES ($1,$2,'ext_patch',$3,$3,$4,$5)`,
          [tenantId, req.params.id, row.status, auth.username ?? 'user', JSON.stringify({ fields: patchKeys, before, after: patch })],
        );
      }
      return ext;
    });
    if (!result) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'work order not found' });
    return res.json({ ok: true, code: 0, ext: result });
  } catch (e) {
    next(e);
  }
};
router.patch('/open/work_order/:id/ext', requireWorkerExecution, handleWorkOrderExt);
router.patch('/admin/work-orders/:id/ext', handleWorkOrderExt);

// GET /api/v1/stats —— P6 自动派单率/自动闭环率口径（诚实，不编造演示数据）
// 权限墙（修复批次 X-8）：挂 dashboard.view——默认矩阵 admin/operator/dispatcher/reviewer/
// service_desk 均含该权限点，worker 不含（403）。调用方核实：FE Dashboard.tsx:216 /
// DataScreen.tsx:144 / Statistics.tsx:55（MainLayout.tsx:109,125-126 三页菜单本就按
// dashboard.view 过滤，挂墙与 FE 既有口径完全对齐）+ mp overview.js:33 / report.js:45
// 两个 admin 页。worker/未登录端点层零调用 → 挂墙零回归。
// POST /api/v1/open/work_order/:id/urge —— 报修人/管理员催办（2026-11-14 方向 C）
// 口径：
//   - 仅活跃态可催办（完成/取消等终态 409）；
//   - 发起人 = 建单人本人，或持 ticket.manage 的管理角色；
//   - 同人同单 30 分钟限一次（ticket_event 结构性防重），避免重复轰炸处理人；
//   - 通知在身处理人；无处理人时通知租户管理员。
const handleUrgeWorkOrder: RequestHandler = async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const result = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(
        `SELECT id, order_no, status, assignee_id, created_by, title FROM work_orders WHERE id=$1 AND tenant_id=$2`,
        [req.params.id, tenantId],
      );
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'work order not found', 404);
      const order = cur.rows[0];
      const defs = await getDefsAcrossAllVersions(client, tenantId, 'work_order', 'work_orders', DEFAULT_WORK_ORDER_DEF);
      const activeSet = unionStates(defs.map(activeStates));
      if (!activeSet.includes(order.status)) {
        throw new AppError('BAD_STATE', '当前状态不可催办（工单已结束/已取消）', 409);
      }
      const isCreator = order.created_by && String(order.created_by) === String(auth.userId ?? '');
      if (!isCreator) await requirePermission(auth, client, 'ticket.manage');
      const actor = auth.username ?? auth.role ?? 'user';
      const recent = await client.query(
        `SELECT 1 FROM ticket_event
          WHERE tenant_id=$1 AND work_order_id=$2 AND type='urge' AND actor=$3
            AND created_at > now() - interval '30 minutes' LIMIT 1`,
        [tenantId, req.params.id, actor],
      );
      if ((recent.rowCount ?? 0) > 0) {
        throw new AppError('URGE_TOO_FREQUENT', '催办过于频繁，请 30 分钟后再试', 429);
      }
      await client.query(
        `INSERT INTO ticket_event (tenant_id, work_order_id, type, from_status, to_status, actor, payload)
         VALUES ($1,$2,'urge',$3,$3,$4,$5)`,
        [tenantId, req.params.id, order.status, actor, JSON.stringify({ by: actor })],
      );
      await emitDomainEvent(client, {
        tenantId, entityType: 'work_order', entityId: req.params.id, type: 'urge', actor,
        payload: { order_no: order.order_no },
      });
      const title = '工单催办提醒';
      const body = `工单 ${order.order_no}（${order.title ?? ''}）已被 ${actor} 催办，请尽快处理`;
      if (order.assignee_id) {
        await insertNotification(client, {
          tenantId, recipient: order.assignee_id, recipientKind: 'worker', type: 'urge',
          workOrderId: req.params.id, title, body,
          payload: { order_no: order.order_no, page: `pages/worker/task-detail/task-detail?id=${req.params.id}` },
        });
      } else {
        const admins = await client.query(`SELECT id FROM account_user WHERE tenant_id=$1 AND role='admin' AND active=true`, [tenantId]);
        for (const a of admins.rows as Array<{ id: string }>) {
          await insertNotification(client, {
            tenantId, recipient: a.id, recipientKind: 'account', type: 'urge',
            workOrderId: req.params.id, title, body,
            payload: { order_no: order.order_no, page: `tickets/${req.params.id}` },
          });
        }
      }
      return { order_no: order.order_no };
    });
    return res.json({ ok: true, code: 0, urged: true, ...result });
  } catch (e) {
    next(e);
  }
};
router.post('/admin/work-orders/:id/urge', handleUrgeWorkOrder);

// GET /stats 已迁移到 routes/stats.ts，由 server.ts 统一挂 requireModule('analytics')。
// 不要再在共享 workOrderRouter 里注册第二份，否则模块关闭时共享路由仍可访问。

// POST /api/v1/scan —— M3 真实解析：目录码/资产码识别（替代前端 MSW 写死 mock）
// 生产化②：优先查库（asset_catalog/asset_registry），DB 权威、查不到诚实 unresolved。
// 契约与前端 services.scan 对齐：{ok,code,asset:{qr,resolved,note,...}}
router.post('/scan', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const schema = z.object({ raw: z.string().min(1) });
    const { raw } = schema.parse(req.body);
    const result = await withTenantClient(tenantId, async (client) => {
      // R35 接线：扫码查询纳入 asset.scan 权限点（租户级覆盖自此生效；默认矩阵零变化）
      await requirePermission(res.locals.auth, client, 'asset.scan');
      return resolveScanFromDb(tenantId, raw);
    });
    // code 仅作成功标记（0），解析结构统一经 asset 字段透出（与前端 ScanButton 对齐）
    return res.json({ ok: true, code: 0, asset: result.asset });
  } catch (e) {
    next(e);
  }
});

// POST /api/v1/admin/work-orders/ops/sla-scan —— P4 SLA 守护：扫本租户超时单，标记升级并 emit sla_escalated 事件
// 拆雷三件套②（2026-08-31）：扫描实现抽到 src/scheduler/slaScheduler.ts 的 runSlaScanForTenant，
// 本端点与进程内 cron 共用同一实现；命中同时落通知（在身 assignee + 租户管理员），契约不变。
const handleSlaScan: RequestHandler = async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    // 审查修复（QA🟡7）：SLA 扫描会写 escalated_at + 发通知触发全租户扫描，属运维动作——
    // 原实现零门禁，任意登录账号（含 worker）可无限触发。运维角色清单集中在 role.ts 的 OPS_ROLES
    // （单一事实源），dev 模式放行，杜绝散落硬编码字符串。
    assertOpsRole(res.locals.auth);
    const hits = await runSlaScanForTenant(tenantId);
    return res.json({
      ok: true,
      code: 0,
      escalated: hits.length,
      items: hits.map((h) => ({ work_order_id: h.workOrderId, from_status: h.fromStatus, escal_minutes: h.escalMinutes })),
    });
  } catch (e) {
    next(e);
  }
};
router.post('/admin/work-orders/ops/sla-scan', handleSlaScan);

// POST /api/v1/open/work_order/:id/change-department —— 改部门（服务台转台的替代）
// 门禁：dispatch.override。只改 department_id，不自动改状态/处理人。
const handleChangeDepartment: RequestHandler = async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const b = z
      .object({ department_id: z.string().uuid(), reason: z.string().optional() })
      .parse(req.body);
    const ticket = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'dispatch.override');
      const dept = await client.query<{ id: string; name: string }>(
        'SELECT id, name FROM dept WHERE id=$1 AND tenant_id=$2',
        [b.department_id, tenantId],
      );
      if (dept.rowCount === 0) throw new AppError('NOT_FOUND', 'target department not found', 404);
      const cur = await findOneForUpdate(client, tenantId, req.params.id);
      if (!cur) throw new AppError('NOT_FOUND', 'work order not found', 404);

      // 已派单且处理人不属于目标部门 → 先改派，避免“人在这科、单在那科”。
      if (cur.assignee_id) {
        const w = await client.query<{ department_id: string | null }>(
          'SELECT department_id FROM worker WHERE id=$1 AND tenant_id=$2',
          [cur.assignee_id, tenantId],
        );
        const wDept = w.rows[0]?.department_id ?? null;
        if (wDept && wDept !== b.department_id) {
          throw new AppError('CONFLICT', '当前处理人不属于目标部门，请先改派后再改部门', 409);
        }
      }

      await client.query(
        'UPDATE work_orders SET department_id=$1, department_source=$2, updated_at=now() WHERE id=$3 AND tenant_id=$4',
        [b.department_id, 'manual', req.params.id, tenantId],
      );
      await client.query(
        `INSERT INTO ticket_event (tenant_id, work_order_id, type, from_status, to_status, actor, payload)
         VALUES ($1,$2,'change_department',$3,$3,'system',$4)`,
        [
          tenantId,
          req.params.id,
          cur.status,
          JSON.stringify({
            from_department_id: cur.department_id ?? null,
            to_department_id: b.department_id,
            to_department_name: dept.rows[0].name,
            reason: b.reason ?? null,
          }),
        ],
      );
      await emitDomainEvent(client, {
        tenantId,
        entityType: 'work_order',
        entityId: req.params.id,
        type: 'change_department',
        actor: 'system',
        payload: {
          from_department_id: cur.department_id ?? null,
          to_department_id: b.department_id,
          to_department_name: dept.rows[0].name,
        },
      });
      if (cur.assignee_id) {
        await insertNotification(client, {
          tenantId,
          recipient: cur.assignee_id,
          recipientKind: 'worker',
          type: 'change_department',
          workOrderId: req.params.id,
          title: '工单责任部门已变更',
          body: `工单 ${cur.order_no} 已转至 ${dept.rows[0].name}`,
          payload: {
            order_no: cur.order_no,
            from_department_id: cur.department_id ?? null,
            to_department_id: b.department_id,
            page: `pages/worker/task-detail/task-detail?id=${req.params.id}`,
          },
        });
      }
      return findOne(client, tenantId, req.params.id);
    });
    return res.json({ ok: true, code: 0, ticket });
  } catch (e) {
    next(e);
  }
};
router.post('/admin/work-orders/:id/change-department', handleChangeDepartment);

// GET /api/v1/open/claim-hall —— 抢单大厅：列出可被认领的工单（池态由流程派生），可按部门过滤
const handleClaimHall: RequestHandler = async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const department = (req.query.department_id ?? req.query.department) as string | undefined;
    const { items, defs, insRows, trRows } = await withTenantClient(tenantId, async (client) => {
      // F10：池态不再写死 ('claim_hall','pending_dispatch')——与认领端点守卫共用
      //   claimableStates(def)（写在代码里的名单换成"能 claim 的态即池"的派生），
      //   杜绝「列表查得到、认领却 409」的两份字面量漂移。
      //   def 已含引擎机制注入；内置模板（RICH + 机制边）下结果逐字 = claim_hall/pending_dispatch。
      // T1-B 批5：池态集合 = **租户内所有版本的并集**（0 = live，必在内）。
      //   【为什么必须是并集】兜底原则：多版本并存时一律取向「宁可多显示，绝不静默丢单」。
      //     本处此刻还没有任何具体行，手上没有 def_version ⇒ 只能按"版本集合"求池态口径。
      //     若只读 live def：一张锁着 v1 的老单，其 v1 里的可抢态 Z 在租户把 def 改到 v2 后
      //     被删掉 ⇒ Z 不在 v2 的 claimableStates 里 ⇒ 该行被下面的 `status = ANY($2)` 滤掉，
      //     单还在库里却从抢单大厅里消失、再也没人看得到 = 静默丢数据。取所有版本的并集，
      //     任何版本认过的池态都保留 ⇒ 老单不会被漏掉。
      //   【代价】多一次 `SELECT DISTINCT def_version` 查询；且租户每多一个历史版本多一次 def
      //     查询（getDefsForVersions 内部按版本分组去重，同一版本只查一次）。
      //   【取舍】误报（个别在新版本已不可抢的旧态仍出现在大厅）优于丢单；误报行点进去会被
      //     claim 端点的 transition() 门禁按该行锁定的版本挡住，不会放行。
      const vRows = await client.query<{ def_version: number }>(
        'SELECT DISTINCT def_version FROM work_orders WHERE tenant_id = $1 AND def_version > 0',
        [tenantId],
      );
      const probeRows = [{ def_version: 0 }, ...vRows.rows.map((v) => ({ def_version: v.def_version }))];
      const poolDefs = await getDefsForVersions(client, tenantId, 'work_order', probeRows, DEFAULT_WORK_ORDER_DEF);
      // 并集去重。防御：Map 为空 ⇒ 并集为空 ⇒ 走下面的「无池」早退（实践上 probe 恒含 0，不会为空）。
      const poolSet = Array.from(new Set(Array.from(poolDefs.values()).flatMap((d) => claimableStates(d))));
      // 流程无认领边 = 工单区无池，诚实返回空（defs 为空 Map：零行 ⇒ 无需查任何版本）。
      //   2026-11-01：不再整段 return —— 巡检/运送两区与本池无关，工单区空不代表它们也空。
      let r: { rows: any[] } = { rows: [] };
      if (poolSet.length > 0) {
        const conds = ['wo.tenant_id=$1', 'wo.status = ANY($2::text[])'];
        const params: unknown[] = [tenantId, poolSet];
        if (department) { params.push(department); conds.push(`wo.department_id = $${params.length}`); }
        r = await client.query(
          `SELECT wo.*, d.name AS department_name
             FROM work_orders wo
             LEFT JOIN dept d ON d.id = wo.department_id AND d.tenant_id = wo.tenant_id
            WHERE ${conds.join(' AND ')}
            ORDER BY wo.created_at ASC LIMIT 500`,
          params,
        );
      }
      // T1-B 批4：available 是**逐行**的判定 ⇒ N 行可能锁不同版本，共用 wdef 会让老单
      //   凭空拿到新版本的按钮（点了才进不了 transition）。按 def_version 分组，几个版本查几次。
      //   上面 SQL 是 `SELECT *` ⇒ def_version 天然在位，无需拓宽 SELECT。
      const defs = await getDefsForVersions(client, tenantId, 'work_order', r.rows, DEFAULT_WORK_ORDER_DEF);

      // 2026-11-01 抢单池统一（用户决定"巡检、运送也进"）：
      //   此前大厅只查 work_orders 单表 ⇒ 工人打开大厅永远只看到工单，巡检与运送"没被指派
      //   就既看不见也接不了"，逼工人记住三套归属规则。现在三类未指派单一并进池。
      // 池态口径不写死：仍由各自的 def 经 claimableStates() 派生（与工单同一机制），
      //   租户没配认领边 = 该实体不进池（诚实返回空，不假装有）。
      const insPool = claimableStates(
        await getWorkflowDefAtVersion(client, tenantId, 'inspection_task', 0, INSPECTION_DEF),
      );
      const trPool = claimableStates(
        await getWorkflowDefAtVersion(client, tenantId, 'transport_task', 0, TRANSPORT_DEF),
      );
      const insRows = insPool.length
        ? (
            await client.query(
              `SELECT * FROM inspection_task
                WHERE tenant_id=$1 AND assignee IS NULL AND status = ANY($2::text[])
                ORDER BY scheduled_at ASC NULLS LAST, created_at ASC LIMIT 200`,
              [tenantId, insPool],
            )
          ).rows
        : [];
      const trRows = trPool.length
        ? (
            await client.query(
              `SELECT * FROM transport_order
                WHERE tenant_id=$1 AND carrier IS NULL AND status = ANY($2::text[])
                ORDER BY created_at ASC LIMIT 200`,
              [tenantId, trPool],
            )
          ).rows
        : [];
      return { items: r.rows, defs, insRows, trRows };
    }, { claimHall: true });
    const out = items.map((it: any) => ({
      ...it,
      code: it.order_no,
      available: availableTransitions(defs.get(Number(it.def_version) || 0)!, it.status).map((t) => ({
        to: t.to, event: t.event, requiredFields: t.requiredFields ?? [], allowedRoles: t.allowedRoles ?? [], sideEffects: t.sideEffects ?? [],
      })),
    }));
    // sections：三类实体分组的统一视图（新前端按 entity 分组渲染；items 保留给旧客户端不破坏）
    const sections = [
      { entity: 'work_order', label: '报修工单', claim_path: '/open/work_order/:id/claim', items: out },
      {
        entity: 'inspection_task',
        label: '巡检任务',
        claim_path: '/inspection/tasks/:id/claim',
        items: (insRows as any[]).map((it) => ({
          ...it,
          entity: 'inspection_task',
          code: it.title || it.id,
          title: it.title,
          claimed_owner: it.assignee ?? null,
        })),
      },
      {
        entity: 'transport_order',
        label: '运送单',
        claim_path: '/transport/orders/:id/claim',
        items: (trRows as any[]).map((it) => ({
          ...it,
          entity: 'transport_order',
          code: it.code || it.id,
          title: it.item_name || it.code,
          claimed_owner: it.carrier ?? null,
        })),
      },
    ].filter((s) => s.items.length > 0);
    const totalAll = sections.reduce((n, s) => n + s.items.length, 0);
    return res.json({ ok: true, code: 0, items: out, total: totalAll, sections });
  } catch (e) {
    next(e);
  }
};
router.get('/open/claim-hall', requireWorkerExecution, handleClaimHall);
router.get('/admin/work-orders/queue/claim-hall', handleClaimHall);

// POST /api/v1/open/work_order/:id/claim —— 抢单（人员认领未分配工单，部门不匹配驳回）
// F6（2026-10-19）：本体抽去 services/claimWorkOrder.ts，并入 transition() 主通道——
//   客户配在认领边上的 allowedRoles/allowedPerms/requiredFields/sideEffects/自动审核
//   全部生效（与此前自动派单 F4 同一次根治）；目标态从客户 def 的认领边派生。
//   门禁单一事实源 = transition()（本文件不再另写角色白名单，两处口径不再漂移）。
// C-2 身份根治：token userId 即 worker.id（id 同源），body workerId 不一致 403。
const handleClaimWorkOrder: RequestHandler = async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const role = res.locals.auth.role;
    // passthrough：客户在认领边配 requiredFields 时，工人端透传的字段原样进 transition()
    // （与通用 transition 端点同口径；workerId/department 是端点自有参数，剥离不进 fields）。
    const b = z
      .object({ workerId: z.string().min(1).optional(), department: z.string().optional() })
      .passthrough()
      .parse(req.body);
    // C-2 身份根治：token 的 userId 即 worker.id（worker 与 account_user id 同源）。
    // 服务端只信 token 身份；body.workerId 仅兼容旧客户端——若传且与 token 身份不一致 → 403（堵伪造/替抢）。
    const authUserId = res.locals.auth.userId;
    if (b.workerId && authUserId && b.workerId !== authUserId) {
      throw new AppError('FORBIDDEN', 'workerId mismatch with authenticated identity', 403);
    }
    const workerId = authUserId ?? b.workerId!; // 优先 token 身份；无 token 身份时回退 body（兼容）
    const { workerId: _w, department: _d, ...fields } = b;
    const ticket = await withTenantClient(tenantId, (client) =>
      claimWorkOrder(client, tenantId, { orderId: req.params.id, workerId, role, fields }),
    { claimHall: true });
    return res.json({ ok: true, code: 0, ticket });
  } catch (e) {
    next(e);
  }
};
router.post('/open/work_order/:id/claim', requireWorkerExecution, handleClaimWorkOrder);
router.post('/admin/work-orders/:id/claim', handleClaimWorkOrder);

// GET /api/v1/admin/work-orders/dispatch/recommend —— 派单智能推荐（DMR 可解释呈现，dispatcher 端）。
// 当前工人（token 身份）今日工作台统计见下方 /open/me/summary。
// 只读推荐：基于 技能匹配 + 当前负载 的确定性评分，不写回任何配置（AUTO_TUNE 无关）。
// 诚实口径：无 worker 级满意度数据 → 理由不编造满意度；技能匹配 = 分类名/码与 worker.skill_tags 子串包含（≥2 字符）。
// 冷启动（无 dispatch_rule/UCB 数据）时依然有区分度：技能命中优先、负载低次之。
const handleDispatchRecommend: RequestHandler = async (req, res, next) => {
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
};
router.get('/admin/work-orders/dispatch/recommend', handleDispatchRecommend);

router.get('/open/me/summary', requireWorkerExecution, async (req, res, next) => {
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
      // 「在办 / 已完成」口径必须由客户流程派生（与 ticket.ts 的 load 净结算、slaScheduler
      //   的 SLA 活跃集共用 activeStates/doneStates），杜绝三处口径漂移。
      //   此前这里把 'completed'/'cancelled'/'claim_hall' 三个状态名写死在 SQL 里，后果：
      //   ① 流程里的其它终态（closed / evaluated / 客户自定义的任意终态）**全被算成在办**
      //      ——实测 t-verification 有 4 张 evaluated + 1 张 closed 正被报成「在办」；
      //   ② 客户改完成态名 → done_count 恒 0，且那些单倒灌进 active_count（双重错）；
      //   ③ 完全没排除挂起态 → 人已离场仍算在办（当前生产无挂起单，属未触发的隐患）。
      // F10：机制态/池态不再写死 'claim_hall'/'pending_dispatch' 两个名字——它们语义上
      //   不属于任何人名下，剔除口径统一取 claimableStates(def)（= 存在认领边的池态），
      //   与 GET /open/claim-hall 列表、认领端点守卫三处同源。
      // T1-B 多版本并存兜底：这里的三组都是「包含」计数（COUNT FILTER status = ANY(...)）⇒
      //   activeSet / doneSet 取各版本**并集**（老单漏计 ⇒ 工人看起来更闲 ⇒ 派单派多）；
      //   poolSet 是**被剔除**的一方 ⇒ 取各版本交集（少剔除 = 多算在办，落在保守侧）。
      const workerDefs = await getDefsAcrossAllVersions(client, tenantId, 'work_order', 'work_orders', DEFAULT_WORK_ORDER_DEF);
      const poolSet = intersectStates(workerDefs.map(claimableStates));
      const doneSet = unionStates(workerDefs.map(doneStates));
      // done_count 是“累计完成/已结束”口径，必须包含已取消等全部终态；
      // today_done 只认成功完成态，两个集合不能混用。
      const terminalSet = unionStates(workerDefs.map(terminalStates));
      const allTerminalSet = Array.from(new Set([...doneSet, ...terminalSet]));
      // ⚠️ 修错记录：初版 activeSet 只剔除了 poolSet，没剔除 doneSet。
      //   单版本下 activeStates 与 doneStates 由构造保证互斥（stateMachine.ts:308-313），
      //   但**并集取自不同版本** ⇒ 存在 X 在 v1 是活跃态、在 v2 被声明为完成态的情况，
      //   于是 X 同时进 activeSet 和 doneSet ⇒ 同一张单既算在办又算已完成 ⇒ 在办+已完成 > 总数。
      //   ⇒ 终态优先：算过完成/结束就不再算在办。由 statusVocabDerived.test.ts ⑥ 守卫。
      const activeSet = unionStates(workerDefs.map(activeStates)).filter(
        (s) => !poolSet.includes(s) && !allTerminalSet.includes(s),
      );
      const taskStats = await fetchMeTaskStats(client, tenantId, workerId, {
        active: activeSet,
        success: doneSet,
        terminal: allTerminalSet,
      });
      return {
        worker: w.rows[0],
        stats: taskStats.total,
        stats_by_type: taskStats.by_type,
      };
    });
    if (!s) throw new AppError('NOT_FOUND', 'worker profile not found', 404);
    return res.json({ ok: true, code: 0, ...s });
  } catch (e) {
    next(e);
  }
});

export default router;
