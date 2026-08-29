import { randomUUID } from 'node:crypto';

// 来电弹屏 → 工单 dto 纯函数（批次 C · 服务台）：映射字段并生成幂等键防双击。
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
  return {
    id: randomUUID(),
    tenantId: input.tenantId,
    businessType: input.catalog,
    catalog: input.catalog,
    priority: 'normal',
    title: `服务台代申告·${input.callerName}`,
    description: input.description,
    location: input.location ?? undefined,
    contact: input.callerName,
    idempotencyKey: idem,
  };
}
