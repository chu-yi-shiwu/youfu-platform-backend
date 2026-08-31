// SLA 守护真 cron 调度（拆雷三件套②，2026-08-31）——接续 P4 / R13-005。
// 此前 /sla/scan 只能由登录用户按租户手动触发，且命中仅落事件不落通知：
//   ① 断链修复：抽 scan 为可复用函数 runSlaScanForTenant，/sla/scan 端点与本 cron 共用同一实现；
//   ② cron：进程内 setInterval 每 60s 扫一轮（单进程部署，无重复触发风险），跨进程互斥走
//      advisory lock（R25-001 同款），跨租户枚举走 SECURITY DEFINER 函数 sla_escalation_tenants()
//      （064 迁移，绕 RLS 只返回 tenant_id 列表，逐租户回 withTenantClient 隔离执行）；
//   ③ 通知闭环：命中升级时 insertNotification 通知 该单在身 assignee（若有）+ 租户在岗管理员，
//      in_app 渠道落库即可达；sms/push/wechat 仍按网关配置诚实 stub（delivered=false）。
import pool from '../db/pool.js';
import { withTenantClient } from '../db/pool.js';
import { getWorkflowDef } from '../engine/workflowDef.js';
import { doneStates, terminalStates, type WorkOrderStatus } from '../engine/stateMachine.js';
import { slaScan, type SlaScanRow } from '../engine/sla.js';
import { emitDomainEvent } from '../db/eventBus.js';
import { dispatchEvent } from '../webhook/dispatch.js';
import { insertNotification } from '../services/notify.js';
import { tryAcquireSchedulerLock, releaseSchedulerLock } from './lock.js';

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false; // 防重入：单次扫描超过 tick 间隔时避免叠加执行

export interface SlaHit {
  workOrderId: string;
  orderNo: string;
  fromStatus: WorkOrderStatus;
  escalMinutes: number;
  dueAt: Date;
}

/**
 * 单租户 SLA 扫描：超时未升级的活跃工单 → 标记 escalated_at + 事件 + webhook + 通知。
 * 与原 /sla/scan 端点逻辑逐行等价（R13-005 活跃态派生口径不变），仅补两段：
 *   - SELECT 增列 assignee_id / order_no（供通知定位与文案）；
 *   - 命中后 insertNotification（原断链：命中无任何落库通知）。
 * 返回命中清单（供端点透出 / cron 统计）。
 */
export async function runSlaScanForTenant(tenantId: string): Promise<SlaHit[]> {
  return withTenantClient(tenantId, async (client) => {
    // A+ Phase1.5：SLA 活跃集由 workflow_def 派生（排除完成态 ∪ 终态 ∪ 挂起态），
    // 与富模板对齐且不写死 4 态（R13-005 修复口径，保持不变）。
    const def = await getWorkflowDef(client, tenantId, 'work_order');
    const slaExclude = Array.from(new Set([...doneStates(def), ...terminalStates(def)]));
    const activeStates = def.states.filter(
      (s) => !slaExclude.includes(s) && s !== 'paused' && s !== 'suspended',
    );
    const active = await client.query<SlaScanRow & { assignee_id: string | null; order_no: string }>(
      `SELECT id, status, sla_due_at, escalated_at, assignee_id, order_no FROM work_orders
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
    const orderNoById = new Map(active.rows.map((r) => [r.id, r.order_no] as const));
    const assigneeById = new Map(active.rows.map((r) => [r.id, r.assignee_id] as const));
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
      // 通知闭环（本次新增）：在身 assignee 优先，其次租户在岗管理员；均无则仅留事件痕迹。
      const orderNo = orderNoById.get(h.workOrderId) ?? h.workOrderId;
      const assignee = assigneeById.get(h.workOrderId) ?? null;
      const title = 'SLA 超时升级';
      const body = `工单 ${orderNo} 已超时 ${h.escalMinutes} 分钟（状态 ${h.fromStatus}），请跟进处理`;
      if (assignee) {
        await insertNotification(client, {
          tenantId, recipient: assignee, recipientKind: 'worker', type: 'sla_escalated', workOrderId: h.workOrderId,
          title, body,
          payload: { order_no: orderNo, from_status: h.fromStatus, escal_minutes: h.escalMinutes },
        });
      }
      const admins = await client.query<{ id: string }>(
        `SELECT id FROM account_user WHERE tenant_id=$1 AND role='admin' AND active=true`,
        [tenantId],
      );
      for (const a of admins.rows) {
        await insertNotification(client, {
          tenantId, recipient: a.id, recipientKind: 'account', type: 'sla_escalated', workOrderId: h.workOrderId,
          title, body,
          payload: { order_no: orderNo, from_status: h.fromStatus, escal_minutes: h.escalMinutes, assignee_id: assignee },
        });
      }
    }
    return hits.map((h) => ({ ...h, orderNo: orderNoById.get(h.workOrderId) ?? h.workOrderId }));
  });
}

export async function runSlaSchedulerOnce(): Promise<number> {
  if (running) return 0; // 本进程上次未完成则跳过本轮
  // 跨进程互斥，多副本部署下仅一个进程执行本轮（与巡检 scheduler 同款）。
  if (!(await tryAcquireSchedulerLock('sla'))) return 0;
  running = true;
  try {
    const { rows } = await pool.query('SELECT tenant_id FROM sla_escalation_tenants()');
    let total = 0;
    for (const r of rows) {
      try {
        const hits = await runSlaScanForTenant(r.tenant_id);
        total += hits.length;
        for (const h of hits) {
          console.warn(`[scheduler] SLA escalated tenant=${r.tenant_id} wo=${h.workOrderId} status=${h.fromStatus} over=${h.escalMinutes}min`);
        }
      } catch (e) {
        console.error('[scheduler] tenant', r.tenant_id, 'sla scan failed:', e);
      }
    }
    if (total > 0) console.log(`[scheduler] sla escalated ${total} work orders`);
    return total;
  } catch (e) {
    console.error('[scheduler] tick failed (sla enumeration):', e);
    return 0;
  } finally {
    running = false;
    await releaseSchedulerLock('sla');
  }
}

export function startSlaScheduler(): void {
  if (timer) return; // 幂等：避免重复启动
  runSlaSchedulerOnce();
  timer = setInterval(runSlaSchedulerOnce, TICK_MS);
  console.log('[scheduler] sla scheduler started (tick 60s)');
}

export function stopSlaScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
