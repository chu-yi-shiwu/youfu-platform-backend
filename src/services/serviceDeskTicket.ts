import { randomUUID } from 'node:crypto';
import { resolvePrefillPriority } from './priorityRules.js';

// 来电弹屏 → 工单 dto 纯函数（批次 C · 服务台）：映射字段并生成幂等键防双击。
// 2026-09-06 任务⑥：priority 由硬编码 'normal' 改为 resolvePrefillPriority 预填——
//   description 参与关键词规则匹配（跳闸/漏水/电梯困人等 → urgent），catalog（中文类目
//   维修/运送/陪检/其他）传给规则做双通道匹配；陪检/运送类目被 priorityRules 排除清单挡住
//   不会误升档。保持纯函数性质：零 DB 依赖。priority_source 落 ext.filled.priority_source
//   留痕（createWithIdem 会把 ext 持久化到 work_orders.ext），dto 上同时暴露 prioritySource 便于观测。
export function buildServiceDeskTicket(input: {
  tenantId: string;
  deskId: string;
  callerName: string;
  catalog: string; // 问题类型：维修/运送/陪检/其他 → business_type
  description: string;
  location?: string;
  sessionId?: string;
}) {
  const idem = input.sessionId ? `svcdesk:${input.deskId}:${input.sessionId}` : undefined;
  const prefill = resolvePrefillPriority({
    description: input.description,
    catalogName: input.catalog,
  });
  return {
    id: randomUUID(),
    tenantId: input.tenantId,
    businessType: input.catalog,
    catalog: input.catalog,
    priority: prefill.priority,
    prioritySource: prefill.source,
    ext: { filled: { priority_source: prefill.source, rule_id: prefill.ruleId ?? null } },
    title: `服务台代申告·${input.callerName}`,
    description: input.description,
    location: input.location ?? undefined,
    contact: input.callerName,
    idempotencyKey: idem,
  };
}
