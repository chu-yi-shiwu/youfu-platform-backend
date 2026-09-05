// 验收业务逻辑（注册制批次三 卡4 · P0-2）：完工凭证落库 + 状态流转钉死事件 + 联动。
// 抽离为独立 service（路由薄壳）：全部函数接收 client（PoolClient）参数，可 mock 单测真实调用路径。
//
// 联动（D1=A 第一阶段只记账）：
//   - pass  → transition(completed→closed, event=acceptance_pass)
//   - reject → transition(completed→processing, event=acceptance_reject)
//              + 清除草稿结算单中该单明细（清空后连草稿单一起删，CASCADE 语义）
//              + SLA 重算（架构🟡7）：按本单 sla_minutes 重算 sla_due_at = now() + sla_minutes 分钟；
//                sla_minutes 缺失（NULL/非正）才退回置 NULL —— src/engine/sla.ts slaScan 对
//                !sla_due_at 的行直接 continue 跳过（已核实），调度器不会误升级返工单。
//   - 无任何支付/收款端点（支付字段预留，接微信支付待 D1 后续拍板）。
import type { PoolClient } from 'pg';
import { AppError } from '../middleware/error.js';
import { transition } from '../repo/ticket.js';
import { getWorkflowDef } from '../engine/workflowDef.js';
import { ACCEPTANCE_EVENT_PREFIX, hasAcceptanceEdges } from '../engine/acceptanceEdges.js';
import type { WorkOrderStatus, WorkflowDef } from '../engine/stateMachine.js';

// 审查修复（架构🔴2 / QA🟡4）：此处原硬编码 ACCEPTANCE_ROLES 白名单，与 workflow_def 边里的
// allowedRoles 形成两份事实源——租户在流程配置里改了 allowedRoles 也不生效，违反设计支柱②。
// 现删除硬编码判定：角色由 transition() 既有门禁（ticket.ts 的 tdef.allowedRoles）统一判定，
// 验收走 eventOverride 调 transition()，引擎自然按该租户边的 allowedRoles 放行/403。
// 单一事实源 = workflow_def；事件名前缀与边定义只在 src/engine/acceptanceEdges.ts。

export interface AcceptanceInput {
  result: 'pass' | 'reject';
  note?: string;
  media?: string[];
  actor?: string;
  role?: string;
}

export interface AcceptanceOutcome {
  acceptanceId: string;
  status: WorkOrderStatus;
}

/**
 * 老租户（或未升级租户）def 缺验收边时的可操作错误（QA🔴①连带）：
 * 直接落到 transition 会抛 422 `illegal transition completed --acceptance_pass-->`，管理员看不懂。
 * 统一转 409 + 指明自救路径（流程配置 → 启用完工验收）。
 */
export function assertAcceptanceEdgesReady(def: WorkflowDef): void {
  if (!hasAcceptanceEdges(def)) {
    throw new AppError(
      'CONFLICT',
      '当前租户的工单流程尚未启用「完工验收」（缺少 acceptance_pass / acceptance_reject 转移）。请管理员到 业务规则设置 → 工单流程 → 启用完工验收 后重试。',
      409,
    );
  }
}

/**
 * Y3 防后门（纯函数，可单测）：通用 transition 端点内调用——
 * QA 修复②（无条件版）：流转事件以 acceptance_ 开头 → 一律 403（验收必须走专用验收端点）。
 * 不再看任何客户端自证标记（via 可被任意伪造，自证 = 无证）；专用验收端点走 service 层
 * 直调 transition()，不经过该路由守卫，无功能损失。
 */
export function assertAcceptanceBackdoorGuard(event: string | undefined | null): void {
  if (event && event.startsWith(ACCEPTANCE_EVENT_PREFIX)) {
    throw new AppError('FORBIDDEN', '验收必须走专用验收端点（/open/work_order/:id/acceptance）', 403);
  }
}

/**
 * 验收主流程（单事务，调用方持 withTenantClient 的 client）：
 * ① 行锁查工单，校验存在 + status='completed'（否则 404/409）；
 * ② 落 work_acceptance 完工凭证；
 * ③ transition 到目标态，事件钉死为 acceptance_pass / acceptance_reject（eventOverride）；
 * ④ reject 联动：清草稿结算明细（含清空后删草稿单）；
 * ⑤ reject 联动：SLA 按 sla_minutes 重算（无时长来源才置 NULL，slaScan 跳过 NULL，已核实）。
 */
export async function applyAcceptance(
  client: PoolClient,
  tenantId: string,
  workOrderId: string,
  input: AcceptanceInput,
): Promise<AcceptanceOutcome> {
  // ① 行锁读工单（与 transition() 同款 FOR UPDATE，杜绝并发双验收）
  const cur = await client.query(
    'SELECT id, status, order_no, sla_minutes FROM work_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [workOrderId, tenantId],
  );
  if (cur.rows.length === 0) {
    throw new AppError('NOT_FOUND', 'work order not found', 404);
  }
  if (cur.rows[0].status !== 'completed') {
    throw new AppError('CONFLICT', `work order not completed (status=${cur.rows[0].status})，仅已完成工单可验收`, 409);
  }
  // ①b 老租户自救（QA🔴①连带）：def 缺验收边时给可操作 409，而非 422 illegal transition。
  // 角色门禁不在此处判定——由 transition() 边的 allowedRoles 统一把关（架构🔴2 单一事实源）。
  const def = await getWorkflowDef(client, tenantId, 'work_order');
  assertAcceptanceEdgesReady(def);
  // ② 完工凭证落库
  const acceptedBy = input.actor ?? input.role ?? 'system';
  const ins = await client.query(
    `INSERT INTO work_acceptance (tenant_id, work_order_id, result, note, media, accepted_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING id`,
    [
      tenantId,
      workOrderId,
      input.result,
      input.note ?? null,
      JSON.stringify(input.media ?? []),
      acceptedBy,
    ],
  );
  const acceptanceId: string = ins.rows[0].id;
  // ③ 状态流转（事件钉死）：pass→closed / reject→processing
  const toStatus: WorkOrderStatus = input.result === 'pass' ? 'closed' : 'processing';
  const event = input.result === 'pass' ? 'acceptance_pass' : 'acceptance_reject';
  await transition(client, tenantId, workOrderId, toStatus, {
    actor: acceptedBy,
    role: input.role,
    fields: {},
    eventOverride: event,
  });
  // ④⑤ reject 联动（pass 无需清理/重置）
  if (input.result === 'reject') {
    // ④ 清草稿结算单中该单明细。审查修复（架构🔴5）：原实现第二步"删本租户所有空 draft"，
    // 会连带删掉他人正在编辑的草稿单（并发互锁、一次打回卡住全租户结算）。
    // 现只对**本次受影响**的 settlement_id 做清理（DELETE ... RETURNING 精确回收）。
    const removed = await client.query(
      `DELETE FROM settlement_item si
       USING settlement s
       WHERE si.settlement_id = s.id
         AND s.tenant_id = $1
         AND s.status = 'draft'
         AND si.work_order_id = $2
       RETURNING si.settlement_id`,
      [tenantId, workOrderId],
    );
    const affectedIds: string[] = Array.from(new Set(removed.rows.map((r: any) => r.settlement_id)));
    // 仅当这些草稿单明细已清空时删除单头（confirmed 单不受影响）
    if (affectedIds.length > 0) {
      await client.query(
        `DELETE FROM settlement s
         WHERE s.tenant_id = $1
           AND s.status = 'draft'
           AND s.id = ANY($2::uuid[])
           AND NOT EXISTS (SELECT 1 FROM settlement_item si WHERE si.settlement_id = s.id)`,
        [tenantId, affectedIds],
      );
    }
    // ⑤ SLA 重置（架构🟡7）：原实现一律置 NULL = 永久取消 SLA，污染超时率统计口径。
    // 现按建单口径重算：有 sla_minutes 则 now() + sla_minutes 分钟（与 workOrder.ts 建单时
    // setSlaDueAt 的 sla_minutes 口径同源）；确实没有时长来源才退回 NULL（slaScan 跳过 NULL）。
    const slaMinutes = Number(cur.rows[0]?.sla_minutes);
    if (Number.isFinite(slaMinutes) && slaMinutes > 0) {
      await client.query(
        `UPDATE work_orders
         SET sla_due_at = now() + ($3::int * interval '1 minute')
         WHERE id = $1 AND tenant_id = $2`,
        [workOrderId, tenantId, slaMinutes],
      );
    } else {
      // 无时长来源（sla_minutes 为 NULL/0/非法）→ 退回置 NULL 并告警：
      // slaScan 跳过 NULL 行，返工单不会被误升级；但超时率口径会缺这一单，故留日志可追溯。
      // 不兜底成默认值（team-lead 实测要求：NULL 就 NULL，别瞎填）。
      console.warn('[acceptance] 返工单无 sla_minutes，SLA 置 NULL（本单退出超时率统计）', {
        tenantId, workOrderId, orderNo: cur.rows[0]?.order_no, rawSlaMinutes: cur.rows[0]?.sla_minutes,
      });
      await client.query(
        'UPDATE work_orders SET sla_due_at = NULL WHERE id = $1 AND tenant_id = $2',
        [workOrderId, tenantId],
      );
    }
  }
  return { acceptanceId, status: toStatus };
}
