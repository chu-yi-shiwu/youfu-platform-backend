// 共享服务：一键把"巡检异常 / 网管异常"转换为一条标准维修工单，进入既有派单流程。
// 设计要点：
//  - 复用 repo.createWithIdem（含 order_no 生成、SLA、初始事件、幂等键），不裸 INSERT，避免漏字段/绕过契约。
//  - 幂等键 linked:<sourceType>:<sourceId>：同一来源记录重复点"生成工单"只会建一次，防重单（真实需求）。
//  - 自动派单逻辑与 workOrder.ts 创建接口完全一致（优先 dispatch_rule，无命中降级 least_load），
//    保持 M1-M3 已验证行为，不破坏既有工单生命周期。
//  - 不改动已验证的 workOrder.ts；本文件为增量新增。
import type { PoolClient } from 'pg';
import { createWithIdem } from '../repo/ticket.js';
import { pickWorker, resolveDispatch, getActiveRules } from '../engine/dispatch.js';
import { autoRouteFor, timestampColumnFor } from '../engine/stateMachine.js';
import { getWorkflowDef } from '../engine/workflowDef.js';
import { setSlaDueAt } from '../engine/sla.js';
import { emitDomainEvent } from '../db/eventBus.js';
// R12-F1（十轮审查）：K2 dispatch 影子回填——自动派单也是"人工实际"信号源（模型建议 vs 实际派单），
// 此前仅 transition() 人工派单回填，导致 dispatch 影子 actual 永远空置（R12 live 查证 7/7 NULL）。
import { resolveDispatchShadow } from './k2Shadow.js';
// 2026-09-14 纵切② P0-4：派单未命中通知管理员（与 workOrder.ts / slaScheduler.ts 同源 notify 抽象层）
import { insertNotification } from './notify.js';

export interface LinkedWoPayload {
  id: string;
  tenantId: string;
  businessType: string;
  catalog?: string;
  priority?: 'normal' | 'urgent';
  location?: string;
  title?: string;
  description?: string;
  contact?: string;
  assets?: unknown[];
  skillTags?: string[];
  sourceType: string; // 'inspection' | 'monitor'
  sourceId: string; // 来源记录 id（用于幂等键）
}

export interface LinkedWoResult {
  id: string;
  orderNo: string;
  autoFlow: boolean;
  assignee: string | null;
  reason: string;
  created: boolean;
}

export async function createLinkedWorkOrder(
  client: PoolClient,
  p: LinkedWoPayload,
): Promise<LinkedWoResult> {
  const idemKey = `linked:${p.sourceType}:${p.sourceId}`;
  const { row, created } = await createWithIdem(client, {
    id: p.id,
    tenantId: p.tenantId,
    businessType: p.businessType,
    catalog: p.catalog,
    priority: p.priority,
    location: p.location,
    title: p.title,
    description: p.description,
    contact: p.contact,
    assets: p.assets,
    idempotencyKey: idemKey,
  });
  // 已转过：直接返回原工单，不重复建单
  if (!created) {
    return {
      id: row.id,
      orderNo: row.order_no,
      autoFlow: row.auto_flow,
      assignee: row.assignee_id,
      reason: 'already converted',
      created: false,
    };
  }
  // 建单即起算 SLA（与 workOrder.ts 一致）
  const sla = setSlaDueAt(p.catalog, p.priority);
  await client.query(
    'UPDATE work_orders SET sla_minutes = $1, sla_due_at = $2 WHERE id = $3',
    [sla.slaMinutes, sla.dueAt, row.id],
  );
  // 自动派单：优先 dispatch_rule，无命中降级 least_load（与 workOrder.ts 一致）
  const workers = await client.query(
    'SELECT id, skill_tags, load, active FROM worker WHERE tenant_id = $1',
    [p.tenantId],
  );
  const need = {
    business_type: p.businessType,
    skill_tags: p.skillTags,
    priority: p.priority,
  };
  const rules = await getActiveRules(client, p.tenantId);
  // ④⑤ 模数共振：读 workflow_def.autoRoutes，决定本租户自动派发的目标态与策略（缺省保持旧行为：落 assigned、规则优先）
  const def = await getWorkflowDef(client, p.tenantId, 'work_order');
  const initial = def.initial;
  const route = autoRouteFor(def, initial);
  const dispatchTarget = route?.to ?? 'assigned';
  // 2026-09-14 纵切② P0-1：strategy:'least_load' 不再短路规则匹配（t-phasea 实证规则被静默废掉；
  // 规则未命中时 resolveDispatch 返回 null，自然落 pickWorker 兜底，无规则租户行为不变）。
  // dispatchTarget（route?.to）逻辑不动：目标态仍由 autoRoutes 决定。
  const resolved = resolveDispatch(workers.rows, rules, need);
  const picked = resolved ? resolved.worker : pickWorker(workers.rows, { skillTags: p.skillTags });
  let autoFlow = false;
  let assignee: string | null = null;
  let reason = 'manual claim required';
  if (picked) {
    autoFlow = true;
    assignee = picked.id;
    reason = resolved ? resolved.reason : 'auto dispatched by least_load fallback';
    // 074 里程碑回填：本函数为自动派单旁路（不走 transition()），按 dispatchTarget 同步回填
    // 里程碑列（映射与 transition() 同源 stateMachine.STATUS_TIMESTAMP_COLUMNS，口径一致）。
    const milestoneCol = timestampColumnFor(dispatchTarget);
    await client.query(
      `UPDATE work_orders SET status = $1, assignee_id = $2, auto_flow = true, updated_at = now()${milestoneCol ? `, ${milestoneCol} = now()` : ''} WHERE id = $3`,
      [dispatchTarget, picked.id, row.id],
    );
    await client.query('UPDATE worker SET load = load + 1 WHERE id = $1', [picked.id]);
    await client.query(
      `INSERT INTO ticket_event (tenant_id, work_order_id, type, from_status, to_status, actor, payload)
       VALUES ($1,$2,'assign',$3,$4,'auto_dispatch',$5)`,
      [p.tenantId, row.id, initial, dispatchTarget, JSON.stringify({ worker_id: picked.id })],
    );
    // ④ 口径对齐 workOrder.ts:180：自动派单补写 domain_event，闭环过程挖掘数据源（R25-004）。
    // 注：本函数已用 autoRouteFor(def, initial) 走 workflow_def 状态机决定 dispatchTarget，
    // 故不强行套用 transitionEntity（其 ALLOWED_TABLES 仅含 business_flow_tasks/inspection_task，
    // 不含 work_orders，硬塞会直接抛 BAD_REQUEST）；缺的是 domain_event 这一条，此处补齐。
    await emitDomainEvent(client, { tenantId: p.tenantId, entityType: 'work_order', entityId: row.id, type: dispatchTarget, actor: 'auto_dispatch', payload: { worker_id: picked.id } });
    // R12-F1：自动派单回填 dispatch 影子 actual（best-effort，内部吞错不影响主链路）
    await resolveDispatchShadow(client, p.tenantId, String(row.id), String(picked.id));
  } else {
    // 2026-09-14 纵切② P0-3：联动单派单未命中此前无 else 分支——工单无声卡死在 draft，
    // 无人可见、无人派发（断链）。逐行对齐 routes/workOrder.ts 的抢单大厅样板：
    // 落 claim_hall + enter_hall 事件（from_status 用本函数的初始态 initial）。
    // V2-F3（派单纵切 P0-8 失配观测，2026-09-14）：与 workOrder.ts 同口径细分落大厅原因
    //（no_available_worker / no_rule_matched），计数经 GET /stats 的 claim_hall_reasons 聚合。
    const hallReason = workers.rows.some((w: { active: boolean }) => w.active)
      ? 'no_rule_matched'
      : 'no_available_worker';
    await client.query(
      'UPDATE work_orders SET status = $1, auto_flow = false, updated_at = now() WHERE id = $2',
      ['claim_hall', row.id],
    );
    await client.query(
      `INSERT INTO ticket_event (tenant_id, work_order_id, type, from_status, to_status, actor, payload)
       VALUES ($1,$2,'enter_hall',$3,$4,'system',$5)`,
      [p.tenantId, row.id, initial, 'claim_hall', JSON.stringify({ reason: hallReason })],
    );
    // 2026-09-14 纵切② P0-4：派单未命中通知管理员（镜像 slaScheduler.ts admin fan-out 模式）。
    // QA-P1 修正（2026-09-14）：withTenantClient 是 BEGIN→fn→COMMIT（db/pool.ts），通知段 SQL
    // 一旦真出错，整个 PG 事务进入 aborted 态——单纯 try/catch 吞错后外层 COMMIT 实为 ROLLBACK，
    // 转单静默消失但 API 谎报成功。故用 SAVEPOINT 隔离通知段（同 runIncrementalLearnStep 的
    // incremental_learn_sp 模式）：失败仅回滚通知段，事务恢复可用，claim_hall 主流程保真。
    await client.query('SAVEPOINT dispatch_notify_sp');
    try {
      const admins = await client.query<{ id: string }>(
        `SELECT id FROM account_user WHERE tenant_id=$1 AND role='admin' AND active=true`,
        [p.tenantId],
      );
      for (const a of admins.rows) {
        await insertNotification(client, {
          tenantId: p.tenantId, recipient: a.id, recipientKind: 'account', type: 'dispatch', workOrderId: row.id,
          title: '工单进入抢单大厅', body: `工单 ${row.order_no} 自动派单未命中，已转入抢单大厅，请关注`,
          payload: { order_no: row.order_no, from_status: initial, source: 'linked_order' },
        });
      }
      await client.query('RELEASE SAVEPOINT dispatch_notify_sp');
    } catch (notifyErr) {
      await client.query('ROLLBACK TO SAVEPOINT dispatch_notify_sp');
      console.error('[linkedWorkOrder] admin notification failed (non-blocking)', { workOrderId: row.id, err: notifyErr });
    }
  }
  return { id: row.id, orderNo: row.order_no, autoFlow, assignee, reason, created: true };
}
