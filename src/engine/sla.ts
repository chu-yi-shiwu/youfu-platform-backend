// P4 SLA 扫描真实化 —— 纯函数 + 数据派生，不依赖 DB（便于单测与复用）。
// 设计口径见 PRD 需求规格 §7 / P0 技术设计 §2：
//   - 维修（electrician/plumber 等技能）：紧急 30min / 一般 4h(240min)
//   - 运送（specimen/escort）：紧急 15min
// 这里以"目录/技能"派生 SLA 时限，原型阶段用固定常量表；真实化后可下沉为租户可配 sla_policy 表。
import type { WorkOrderStatus } from './stateMachine.js';

// 目录 -> { urgent, normal } 时限（分钟）。未命中目录按一般维修 240 兜底。
const SLA_MINUTES: Record<string, { urgent: number; normal: number }> = {
  // 维修类（电工/水工）
  electrician: { urgent: 30, normal: 240 },
  plumber: { urgent: 30, normal: 240 },
  // 运送类（标本/陪检）
  specimen: { urgent: 15, normal: 120 },
  patient_escort: { urgent: 15, normal: 120 },
};

const DEFAULT_SLA = { urgent: 30, normal: 240 };

/**
 * 由目录 + 优先级派生 SLA 时限（分钟）。
 * 纯函数，确定式，供单测与建单落库共用。
 */
export function resolveSlaMinutes(catalog?: string | null, priority: 'normal' | 'urgent' = 'normal'): number {
  const entry = (catalog && SLA_MINUTES[catalog]) || DEFAULT_SLA;
  return priority === 'urgent' ? entry.urgent : entry.normal;
}

/**
 * 计算 SLA 应付截止时刻（在 now 基础上加时限分钟）。
 * 返回 { slaMinutes, dueAt }；调用方负责写 work_orders.sla_minutes / sla_due_at。
 */
export function setSlaDueAt(
  catalog?: string | null,
  priority: 'normal' | 'urgent' = 'normal',
  now: Date = new Date(),
): { slaMinutes: number; dueAt: Date } {
  const slaMinutes = resolveSlaMinutes(catalog, priority);
  return { slaMinutes, dueAt: new Date(now.getTime() + slaMinutes * 60_000) };
}

// slaScan 可识别的"活跃"状态：尚未完成即受 SLA 约束。
const SLA_ACTIVE: WorkOrderStatus[] = ['draft', 'assigned', 'processing'];

export interface SlaScanRow {
  id: string;
  status: WorkOrderStatus;
  sla_due_at: Date | null;
  escalated_at: Date | null;
}

export interface SlaEscalation {
  workOrderId: string;
  fromStatus: WorkOrderStatus;
  escalMinutes: number;
  dueAt: Date;
}

/**
 * 纯函数：给定当前时刻，挑出"应付已到期 + 尚未升级 + 处于活跃态"的工单。
 * 不落库、不写事件——由调用方在事务里 emit sla_escalated（保持 repo 单一写路径）。
 * 返回需升级清单；空数组表示无超时。
 */
export function slaScan(rows: SlaScanRow[], now: Date = new Date()): SlaEscalation[] {
  const out: SlaEscalation[] = [];
  for (const r of rows) {
    if (!SLA_ACTIVE.includes(r.status)) continue;        // 已完成/挂起等不计时
    if (!r.sla_due_at) continue;                          // 无 SLA 设定（如 claim_hall 兜底）
    if (r.escalated_at) continue;                         // 已升级过，不重复
    if (r.sla_due_at.getTime() <= now.getTime()) {
      out.push({
        workOrderId: r.id,
        fromStatus: r.status,
        escalMinutes: Math.round((now.getTime() - r.sla_due_at.getTime()) / 60_000),
        dueAt: r.sla_due_at,
      });
    }
  }
  return out;
}
