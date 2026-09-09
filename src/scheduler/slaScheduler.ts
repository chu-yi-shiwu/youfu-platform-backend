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
import { getWorkflowDef, getWorkflowDefOrDefault } from '../engine/workflowDef.js';
import { doneStates, terminalStates, type WorkOrderStatus } from '../engine/stateMachine.js';
import { slaScan, type SlaScanRow } from '../engine/sla.js';
import { TRANSPORT_DEF } from '../engine/themes.js';
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

/** P1（B2 补 SLA）：运送线 SLA 命中记录（与工单线 SlaHit 分离，字段语义不同）。 */
export interface TransportSlaHit {
  transportOrderId: string;
  code: string | null;
  fromStatus: string;
  dueAt: Date;
}

/**
 * P1（B2 补 SLA）：运送单线 SLA 扫描——此前 cron 只扫 work_orders，运送单超时零告警
 * （实测 2 单卡 transporting 15 天，审查报告 20260908 🟡实证）。
 * 口径：
 *   - 活跃集 = transport_task workflow_def 派生（排除 doneStates ∪ terminalStates ∪ paused/suspended，
 *     与工单线口径一致，租户可定制不写死）；
 *   - 命中 = sla_due_at 已过（sla_due_at < now()）且未升级（escalated_at IS NULL）且已设期
 *     （sla_due_at IS NOT NULL——建单未传 sla_due_at 的单诚实不扫，不替租户估时）；
 *   - 命中后置 escalated_at（防重复告警）+ domain_event + 通知（在身承运人 carrier + 租户在岗管理员）。
 * 与工单线 runSlaScanForTenant 同租户隔离（withTenantClient），复用 cron 的逐租户枚举。
 */
export async function runTransportSlaScanForTenant(tenantId: string): Promise<TransportSlaHit[]> {
  return withTenantClient(tenantId, async (client) => {
    const def = await getWorkflowDefOrDefault(client, tenantId, 'transport_task', TRANSPORT_DEF);
    // P3-②：与工单线 runSlaScanForTenant 口径对齐——除 doneStates ∪ terminalStates 外，
    // 无条件追加排除挂起态 paused/suspended（防御租户自定义 def 含挂起态被误判 SLA 超时）；
    // 工单线经 activeStates 二次过滤实现同款排除，运送线无二道过滤，直接落在 SQL 排除集。
    const exclude = Array.from(
      new Set([...doneStates(def), ...terminalStates(def), 'paused', 'suspended']),
    );
    const rows = await client.query(
      `SELECT id, code, status, carrier, sla_due_at FROM transport_order
       WHERE tenant_id = $1 AND status <> ALL($2::text[])
         AND sla_due_at IS NOT NULL AND escalated_at IS NULL AND sla_due_at < now()`,
      [tenantId, exclude],
    );
    const hits: TransportSlaHit[] = [];
    for (const r of rows.rows) {
      await client.query('UPDATE transport_order SET escalated_at = now() WHERE id = $1', [r.id]);
      await emitDomainEvent(client, {
        tenantId,
        entityType: 'transport_order',
        entityId: r.id,
        type: 'sla_escalated',
        actor: 'system',
        payload: { due_at: r.sla_due_at, status: r.status, code: r.code ?? null },
      });
      const title = '运送单 SLA 超时';
      const body = `运送单 ${r.code ?? r.id} 已超过期望完成时间（状态 ${r.status}），请跟进处理`;
      if (r.carrier) {
        await insertNotification(client, {
          tenantId, recipient: r.carrier, recipientKind: 'worker', type: 'sla_escalated',
          workOrderId: r.id, title, body,
          payload: { entity_type: 'transport_order', code: r.code ?? null, from_status: r.status },
        });
      }
      const admins = await client.query<{ id: string }>(
        `SELECT id FROM account_user WHERE tenant_id=$1 AND role='admin' AND active=true`,
        [tenantId],
      );
      for (const a of admins.rows) {
        await insertNotification(client, {
          tenantId, recipient: a.id, recipientKind: 'account', type: 'sla_escalated',
          workOrderId: r.id, title, body,
          payload: { entity_type: 'transport_order', code: r.code ?? null, from_status: r.status, carrier: r.carrier ?? null },
        });
      }
      hits.push({ transportOrderId: r.id, code: r.code ?? null, fromStatus: r.status, dueAt: new Date(r.sla_due_at) });
    }
    return hits;
  });
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
    let tTotal = 0; // P1：运送线命中数（单独计数，日志分线，返回值仍为工单线命中数保持既有语义）
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
      try {
        // P1（B2 补 SLA）：运送单线与工单线同租户逐轮扫描；失败只记日志不阻断工单线。
        const tHits = await runTransportSlaScanForTenant(r.tenant_id);
        tTotal += tHits.length;
        for (const h of tHits) {
          console.warn(`[scheduler] transport SLA escalated tenant=${r.tenant_id} to=${h.transportOrderId} status=${h.fromStatus} due=${h.dueAt.toISOString()}`);
        }
      } catch (e) {
        console.error('[scheduler] tenant', r.tenant_id, 'transport sla scan failed:', e);
      }
    }
    if (total > 0) console.log(`[scheduler] sla escalated ${total} work orders`);
    if (tTotal > 0) console.log(`[scheduler] sla escalated ${tTotal} transport orders`);
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
