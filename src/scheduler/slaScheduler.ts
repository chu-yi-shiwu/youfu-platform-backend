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
import { getDefsAcrossAllVersions, getDefsForVersions, intersectStates, unionStates } from '../engine/workflowDef.js';
import { doneStates, terminalStates, holdStates, activeStates as engineActiveStates, CLAIM_HALL_STATE, DEFAULT_WORK_ORDER_DEF, type WorkflowDef, type WorkOrderStatus } from '../engine/stateMachine.js';
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

/** V2-F2（派单纵切 P0-5，2026-09-14）：抢单大厅超时命中记录。 */
export interface ClaimHallHit {
  workOrderId: string;
  orderNo: string;
  waitMinutes: number;
}

/**
 * V2-F2（派单纵切 P0-5）：抢单大厅停留超时扫描——此前 claim_hall 单无任何专属超时，
 * 只能等 SLA 到期（到期也仅打标记），工单可在大厅静置到被遗忘。
 * 口径：
 *   - 阈值 = env CLAIM_HALL_TIMEOUT_MIN（缺省 30；非法/非正数降级回默认，不抛错）；
 *   - 命中 = status='claim_hall' 且 updated_at 早于阈值（落大厅的 UPDATE 会刷新 updated_at，
 *     故以它作进入大厅时刻的保守近似）且尚无 'claim_hall_timeout' 事件（结构性防重，
 *     60s 一轮的 cron 不会对同一单重复轰炸）；
 *   - 动作 = 写 ticket_event(type='claim_hall_timeout'，沿用 ticket_event 既有约定)
 *     + 通知全部 active admin/dispatcher。只通知不自动改派（改派是人工裁量）。
 */
export function claimHallTimeoutMinutes(): number {
  const raw = Number(process.env.CLAIM_HALL_TIMEOUT_MIN);
  if (!Number.isFinite(raw) || raw <= 0) return 30;
  return raw;
}

export async function runClaimHallTimeoutScanForTenant(tenantId: string): Promise<ClaimHallHit[]> {
  const timeoutMin = claimHallTimeoutMinutes();
  return withTenantClient(tenantId, async (client) => {
    const rows = await client.query<{ id: string; order_no: string; updated_at: string }>(
      `SELECT w.id, w.order_no, w.updated_at FROM work_orders w
       WHERE w.tenant_id = $1 AND w.status = $2
         AND w.updated_at < now() - make_interval(mins => $3::int)
         AND NOT EXISTS (
           SELECT 1 FROM ticket_event e
           WHERE e.tenant_id = w.tenant_id AND e.work_order_id = w.id AND e.type = 'claim_hall_timeout'
         )
       LIMIT 200`,
      [tenantId, CLAIM_HALL_STATE, timeoutMin],
    );
    const hits: ClaimHallHit[] = [];
    if (rows.rows.length === 0) return hits;
    // 通知面：admin + operator（V2-F2 扩展——SLA 线只通知 admin，大厅积压是调度职责）。
    // 【用户要求①】dispatcher 退场 → 调度职责落到 operator（默认矩阵含 dispatch.override）。
    // 存量 dispatcher 账号仍在 IN 列表内照常收通知（只加不删，避免存量账号突然失联）。
    const staff = await client.query<{ id: string }>(
      `SELECT id FROM account_user WHERE tenant_id=$1 AND role IN ('admin','operator','dispatcher') AND active=true`,
      [tenantId],
    );
    for (const r of rows.rows) {
      const waitedMin = Math.max(0, Math.round((Date.now() - new Date(r.updated_at).getTime()) / 60_000));
      await client.query(
        `INSERT INTO ticket_event (tenant_id, work_order_id, type, from_status, to_status, actor, payload)
         VALUES ($1,$2,'claim_hall_timeout',$3,$3,'system',$4)`,
        [tenantId, r.id, CLAIM_HALL_STATE, JSON.stringify({ wait_minutes: waitedMin, threshold_minutes: timeoutMin })],
      );
      await emitDomainEvent(client, {
        tenantId, entityType: 'work_order', entityId: r.id, type: 'claim_hall_timeout', actor: 'system',
        payload: { wait_minutes: waitedMin, threshold_minutes: timeoutMin },
      });
      const title = '抢单大厅工单超时';
      const body = `工单 ${r.order_no} 在抢单大厅已等待 ${waitedMin} 分钟无人接单（阈值 ${timeoutMin} 分钟），请关注或人工派单`;
      for (const s of staff.rows) {
        await insertNotification(client, {
          tenantId, recipient: s.id, recipientKind: 'account', type: 'claim_hall_timeout',
          workOrderId: r.id, title, body,
          payload: { order_no: r.order_no, wait_minutes: waitedMin, threshold_minutes: timeoutMin },
        });
      }
      hits.push({ workOrderId: r.id, orderNo: r.order_no, waitMinutes: waitedMin });
    }
    return hits;
  });
}

/**
 * 运送线的 dead 集（不受 SLA 约束）：doneStates ∪ terminalStates ∪ holdStates。
 * 【为什么必须抽成一个函数】SQL 预过滤与 JS 按行判定**共用同一表达式**——
 *   两处各写一份就会口径漂移（一处加了 holdStates 另一处没加 ⇒ 同一张单在两层结论相反）。
 *   与工单线 activeStates/doneStates 派生同源的纪律一致。
 */
function deadStatesOf(d: WorkflowDef): string[] {
  return Array.from(new Set([...doneStates(d), ...terminalStates(d), ...holdStates(d)]));
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
 *   - 受 SLA 约束 = **按每张单自己锁的那版** transport_task 流程判定：不在该版的
 *     doneStates ∪ terminalStates ∪ holdStates（挂起态）里才算在途，租户可定制不写死；
 *   - 命中 = sla_due_at 已过（sla_due_at < now()）且未升级（escalated_at IS NULL）且已设期
 *     （sla_due_at IS NOT NULL——建单未传 sla_due_at 的单诚实不扫，不替租户估时）；
 *   - 命中后置 escalated_at（防重复告警）+ domain_event + 通知（在身承运人 carrier + 租户在岗管理员）。
 * 与工单线 runSlaScanForTenant 同租户隔离（withTenantClient），复用 cron 的逐租户枚举。
 */
export async function runTransportSlaScanForTenant(tenantId: string): Promise<TransportSlaHit[]> {
  return withTenantClient(tenantId, async (client) => {
    // ============================ T1-B 批 8 · 根治（独立评审 M1） ============================
    // 【批 5 的老写法为什么挡不住洞】那时候手上没有具体行，只能"读各版本的 def 求集合"：
    //   SQL 用 `status <> ALL(各版本终态的**交集**)` 排除。客户把完成态改名（v1='done'
    //   → v2='finished'）⇒ 两版终态**零交集** ⇒ 交集为空 ⇒ PG 里 `x <> ALL('{}')` **恒真**
    //   ⇒ 所有 `sla_due_at < now() AND escalated_at IS NULL` 的历史单（含已完成、已取消）
    //   全被捞出来升级 + 通知 carrier 和**全部 admin** + 写 escalated_at（**不可逆，无自动回滚**）。
    // 【批 7 的二道过滤为什么也不够】它补的是「status ∈ 各版本 activeStates 的**并集**」。
    //   但 activeStates = 全态 − done − terminal − hold，**跨版本后不再互斥**：
    //   'done' 在 v1 是终态，在 v2 因为客户加了 `done --close--> finished` 变成中间态 ⇒ 活跃
    //   ⇒ 并集里含 'done' ⇒ 锁着 v1、status='done' 的单（按它自己那版**早已终结**）
    //   仍被判成在途 ⇒ 照样误升级。并集的方向是"宁可多算"，用在**放行闸**上就把误报面放大了。
    //   两条防线方向都是"猜"，而猜的前提（各版本口径一致）恰恰是版本化之后不再成立的。
    //
    // 【根治：不猜，按行判定】transport_order 表上**本来就有 def_version 列**
    //   （102_inflight_def_version.sql:55，T1-B 加的在途单锁版本列）。
    //   ⇒ 这里根本不属于"手上没行、只能读 live"的场景——SQL 把 def_version 一起查出来，
    //   再用 getDefsForVersions 按行取**该单自己锁的那一版** def 来判定。
    //   代价：getDefsForVersions 按版本分组，**每个在跑的版本只查一次**（不是逐行查）；
    //   输入行集已由下面的 SQL（三个时间/状态条件 + 交集预过滤）收窄，不是全表扫描。
    // =======================================================================================
    // P3-② / F8 的口径不变：受 SLA 约束 = 不在该版的 doneStates ∪ terminalStates ∪ holdStates
    //   （挂起态由 holdStates 派生，不再硬编码 paused/suspended，与工单线同源）。
    // 【两道闸的分工】
    //  ① SQL 交集预过滤（本段）：**保守侧**——状态 S 只有在「每一个版本里都 dead」时才被排除，
    //     那么无论该行锁哪一版，S 在它自己那版里也必然是 dead ⇒ 排除它**一定不会漏告警**。
    //     作用是把终态行挡在库里：否则终态行永不被升级 ⇒ escalated_at 恒为 NULL ⇒
    //     它们会永久留在结果集里，每 60s 逐租户重捞一遍且只增不减。
    //     单版本（最常见）时交集 = 该版 dead 集 ⇒ 终态行在 SQL 里就被挡掉。
    //     ⚠️ 这里必须是**交集**：写成并集会把"只在某些版本里 dead"的状态也挡掉 ⇒ 静默漏告警
    //     （违反 E3，比误升级更隐蔽）。由 slaScheduler.test.ts 的变异守卫用例钉住。
    //  ② JS 按行精确判定（下一段）：兜住 ① 兜不住的两种情形——两版 dead 集零交集（①不挡），
    //     以及同名状态跨版本从 dead 变活跃（① 也不挡，但按该行锁的版本它不是 dead ⇒ 必须放行）。
    const acrossDefs = await getDefsAcrossAllVersions(
      client, tenantId, 'transport_task', 'transport_order', TRANSPORT_DEF,
    );
    const exclude = intersectStates(acrossDefs.map(deadStatesOf));
    const rows = await client.query(
      `SELECT id, code, status, carrier, sla_due_at, def_version FROM transport_order
       WHERE tenant_id = $1 AND status <> ALL($2::text[])
         AND sla_due_at IS NOT NULL AND escalated_at IS NULL AND sla_due_at < now()`,
      [tenantId, exclude],
    );
    const defs = await getDefsForVersions(client, tenantId, 'transport_task', rows.rows, TRANSPORT_DEF);
    const candidates = rows.rows.filter((r) => {
      // getDefsForVersions 的 key 就是 `Number(row.def_version) || 0`，永远命中（查不到的版本
      // 已在函数内降级到 live 并保留自己的 key）⇒ 取不到只可能是 Map 本身为空（rows 为空），保守跳过。
      const d = defs.get(Number(r.def_version) || 0);
      if (!d) return false;
      return !deadStatesOf(d).includes(String(r.status));
    });
    const hits: TransportSlaHit[] = [];
    for (const r of candidates) {
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
    // F8：挂起态与 load 结算共用 holdStates 派生（客户自定义挂起态名不再被漏排）。
    // T1-B 多版本并存兜底：SQL 排除集取**交集**、activeStates 取**并集**——
    //   老单锁着旧版本，其状态在新流程里可能既不算终态也不算活跃 ⇒ 两头都不沾，
    //   结果是这批老单**超时了也不告警**。宁可多扫一单，不可静默丢单。
    const workOrderDefs = await getDefsAcrossAllVersions(
      client, tenantId, 'work_order', 'work_orders', DEFAULT_WORK_ORDER_DEF,
    );
    const slaExclude = intersectStates(
      workOrderDefs.map((d) => Array.from(new Set([...doneStates(d), ...terminalStates(d)]))),
    );
    const activeStates = unionStates(workOrderDefs.map((d) => engineActiveStates(d)));
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
      try {
        // V2-F2（派单纵切 P0-5）：抢单大厅停留超时扫描；失败只记日志不阻断其余扫描线。
        const chHits = await runClaimHallTimeoutScanForTenant(r.tenant_id);
        for (const h of chHits) {
          console.warn(`[scheduler] claim_hall timeout tenant=${r.tenant_id} wo=${h.workOrderId} waited=${h.waitMinutes}min`);
        }
      } catch (e) {
        console.error('[scheduler] tenant', r.tenant_id, 'claim_hall timeout scan failed:', e);
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
