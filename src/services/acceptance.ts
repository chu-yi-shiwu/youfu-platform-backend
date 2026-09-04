// 验收业务逻辑（注册制批次三 卡4 · P0-2）：完工凭证落库 + 状态流转钉死事件 + 联动。
// 抽离为独立 service（路由薄壳）：全部函数接收 client（PoolClient）参数，可 mock 单测真实调用路径。
//
// 联动（D1=A 第一阶段只记账）：
//   - pass  → transition(completed→closed, event=acceptance_pass)
//   - reject → transition(completed→processing, event=acceptance_reject)
//              + 清除草稿结算单中该单明细（清空后连草稿单一起删，CASCADE 语义）
//              + SLA 重置（sla_due_at=NULL）：src/engine/sla.ts slaScan 对 !sla_due_at 的行
//                直接 continue 跳过（已核实），调度器不会误升级返工单。
//   - 无任何支付/收款端点（支付字段预留，接微信支付待 D1 后续拍板）。
import type { PoolClient } from 'pg';
import { AppError } from '../middleware/error.js';
import { transition } from '../repo/ticket.js';
import { ACCEPTANCE_EVENT_PREFIX } from '../engine/acceptanceEdges.js';
import type { WorkOrderStatus } from '../engine/stateMachine.js';

/** 验收允许的角色（与 workflow_def 验收边 allowedRoles 一致）。 */
export const ACCEPTANCE_ROLES = ['admin', 'operator', 'reviewer'] as const;

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

/** 角色门禁（纯函数，可单测）：不在白名单 → 403。 */
export function assertAcceptanceRole(role: string | undefined): void {
  if (!role || !(ACCEPTANCE_ROLES as readonly string[]).includes(role)) {
    throw new AppError('FORBIDDEN', `role ${role ?? '(none)'} not allowed to accept`, 403);
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
 * ⑤ reject 联动：SLA 重置 sla_due_at=NULL（slaScan 跳过 NULL，已核实）。
 */
export async function applyAcceptance(
  client: PoolClient,
  tenantId: string,
  workOrderId: string,
  input: AcceptanceInput,
): Promise<AcceptanceOutcome> {
  assertAcceptanceRole(input.role);
  // ① 行锁读工单（与 transition() 同款 FOR UPDATE，杜绝并发双验收）
  const cur = await client.query(
    'SELECT id, status, order_no FROM work_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
    [workOrderId, tenantId],
  );
  if (cur.rows.length === 0) {
    throw new AppError('NOT_FOUND', 'work order not found', 404);
  }
  if (cur.rows[0].status !== 'completed') {
    throw new AppError('CONFLICT', `work order not completed (status=${cur.rows[0].status})，仅已完成工单可验收`, 409);
  }
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
    // ④ 清草稿结算单中该单明细
    await client.query(
      `DELETE FROM settlement_item si
       USING settlement s
       WHERE si.settlement_id = s.id
         AND s.tenant_id = $1
         AND s.status = 'draft'
         AND si.work_order_id = $2`,
      [tenantId, workOrderId],
    );
    // 明细清空后的草稿单一并删除（confirmed 单不受影响）
    await client.query(
      `DELETE FROM settlement s
       WHERE s.tenant_id = $1
         AND s.status = 'draft'
         AND NOT EXISTS (SELECT 1 FROM settlement_item si WHERE si.settlement_id = s.id)`,
      [tenantId],
    );
    // ⑤ SLA 重置：置 NULL，slaScan 对 NULL 直接跳过（返工期间不计时、不误升级）
    await client.query(
      'UPDATE work_orders SET sla_due_at = NULL WHERE id = $1 AND tenant_id = $2',
      [workOrderId, tenantId],
    );
  }
  return { acceptanceId, status: toStatus };
}
