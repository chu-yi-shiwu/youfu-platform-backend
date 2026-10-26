/**
 * 抢单（人员认领未分配工单）—— 从 routes/workOrder.ts claim 端点抽取，
 * 2026-10-19 F6 并入 transition() 主通道（与此前自动派单 F4 同一次根治）。
 *
 * 【为什么必须有这个函数】抢单端点与此前的自动派单同病：旁路手写 UPDATE，
 * 不调 transition()。客户配在认领边（claim 事件边）上的规矩只有 allowedRoles
 * 被消费（且是端点内另写的 claimAllowedRoles，与 transition() 门禁双口径），
 * 其余全部落空：
 *   ① requiredFields —— 不校验；
 *   ② sideEffects（pause_sla 等）—— 不执行；
 *   ③ 自动审核规则（挂在 transition() 尾部）—— 不触发；
 *   ④ allowedPerms —— 从未消费；
 *   ⑤ 目标态 —— 硬编码 'assigned'：客户把认领边指向别的态（或根本不要 assigned），
 *      单子被写进客户流程里不存在的状态 = 失管单（isKnownState 之后全堵）。
 *   产品事实：**客户配的规矩，人走的每道门也都得守**。
 *
 * 【主通道口径】transition() 一次拿到全部：拓扑校验、allowedRoles/allowedPerms
 *   （认领是人类动作，工人有角色，不跳人类门禁）、requiredFields、sideEffects、
 *   自动审核触发、load 净结算、ticket_event/domain_event 留痕。
 *   事件流类型保持 'claim'（eventLogType，存量消费方照旧）。
 */

import type { PoolClient } from 'pg';
import { transition, findOne, findOneForUpdate } from '../repo/ticket.js';
import { getWorkflowDefAtVersion } from '../engine/workflowDef.js';
import { insertNotification } from './notify.js';
import { AppError } from '../middleware/error.js';
import { DEFAULT_WORK_ORDER_DEF, type WorkOrderStatus } from '../engine/stateMachine.js';
import { claimableStates, CLAIM_EVENT } from '../engine/stateMachine.js';

// F10：池态不再写死 ['claim_hall','pending_dispatch']——由 claimableStates(def) 派生
//   （能 claim 的状态就是池），与 GET /open/claim-hall 列表 SQL 共用同一口径。
//   同理：客户在流程里另配认领边（如二次转单池）→ 池自动扩到那里，不用改代码。

export interface ClaimParams {
  orderId: string;
  /** token 身份（account_user.id）或 worker.id —— 与存量口径一致 */
  workerId: string;
  role?: string;
  /** 客户端透传的附加字段（客户在认领边配 requiredFields 时由工人端提供） */
  fields?: Record<string, unknown>;
}

export async function claimWorkOrder(
  client: PoolClient,
  tenantId: string,
  p: ClaimParams,
): Promise<{ ticket: unknown }> {
  const cur = await findOneForUpdate(client, tenantId, p.orderId);
  if (!cur) throw new AppError('NOT_FOUND', 'work order not found', 404);
  // T1-B 批4：按**这张工单行**锁定的版本读（原为逐行无关的 live def，现移到此行取到之后）。
  //   理由：下方 claimableStates 是"这张单能不能被抢"的放行判定，:76 的 transition()
  //   读的是行上锁版本 ⇒ 两边不同版本就变成「抢单按钮在、抢了才 409/422」。
  //   cur 来自 findOneForUpdate（SELECT *）⇒ def_version 天然在位，无需拓宽 SELECT。
  const def = await getWorkflowDefAtVersion(client, tenantId, 'work_order', Number(cur.def_version) || 0, DEFAULT_WORK_ORDER_DEF);
  if (!claimableStates(def).includes(cur.status)) {
    throw new AppError('CONFLICT', `work order not in claimable pool (status=${cur.status})`, 409);
  }
  // P0 修复：token 的 userId 是 account_user.id（uuid），worker.id 是业务编码，
  // 必须经 worker.account_id 反查真实 worker.id（与存量端点口径一致）。
  const worker = await client.query(
    'SELECT id, department FROM worker WHERE tenant_id=$2 AND (account_id=$1 OR id=$1) LIMIT 1',
    [p.workerId, tenantId],
  );
  if (worker.rowCount === 0) throw new AppError('NOT_FOUND', 'worker not found', 404);
  const realWorkerId = worker.rows[0].id;
  const wDept = worker.rows[0].department;
  const woDept = (cur as { department?: string }).department;
  // 部门级抢单：工单与人员均有部门且不一致 → 驳回（跨部由调度/管理员另行处理）
  if (woDept && wDept && woDept !== wDept) {
    throw new AppError('FORBIDDEN', `worker department ${wDept} mismatch work order department ${woDept}`, 403);
  }
  // 认领边：客户 def 里从当前池态出发的 claim 事件边。目标态从边派生——
  // 绝不硬编码（客户把认领边指向别的态就落那个态）。池态的 claim 边由
  // claimHallEdges 机制注入保证存在；客户自建 claim 边时以其为准（注入幂等跳过）。
  const claimEdge = (def.transitions ?? []).find((t) => t.from === cur.status && t.event === CLAIM_EVENT);
  if (!claimEdge) {
    throw new AppError('CONFLICT', `no claim edge configured from ${cur.status}`, 422);
  }
  await transition(client, tenantId, p.orderId, claimEdge.to as WorkOrderStatus, {
    actor: 'worker',
    role: p.role,
    fields: { assignee: realWorkerId, ...(p.fields ?? {}) },
    autoFlow: false, // 人工认领，显式口径（不许被"带 assignee 必是人工"猜）
    eventLogType: 'claim', // 事件流类型不变（存量消费方照旧）
    eventOverride: 'claim', // 钉死走客户配的那条认领边（同 from→to 多条边时不漂移）
  });
  await insertNotification(client, {
    tenantId, recipient: realWorkerId, type: 'claim', workOrderId: p.orderId,
    title: '您已抢到工单', body: `工单 ${(cur as { order_no?: string }).order_no} 已由您认领`,
    payload: { order_no: (cur as { order_no?: string }).order_no, page: `pages/worker/task-detail/task-detail?id=${p.orderId}` },
  });
  const ticket = await findOne(client, tenantId, p.orderId);
  return { ticket };
}
