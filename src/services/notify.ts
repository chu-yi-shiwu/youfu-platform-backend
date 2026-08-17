// 派单通知服务（Phase A）：把"派单/转台/退回/改派/抢单/挂起/关闭/满意度"等事件落库为通知。
// 诚实边界：in_app 通知落库即视为已读可达；sms/push 仅落库 + 记日志，未真实发送（无短信/推送网关），
// 避免伪造"已通知"。接入网关后只需在此把 delivered 置 true 并真正投递即可，调用方不变。
import type { PoolClient } from 'pg';

export type NotifyChannel = 'in_app' | 'sms' | 'push';
export type NotifyRecipientKind = 'worker' | 'account' | 'desk';

export interface NotifyInput {
  tenantId: string;
  recipient: string; // worker.id / account id / desk id
  recipientKind?: NotifyRecipientKind;
  type: string;
  workOrderId: string;
  title: string;
  body?: string;
  channel?: NotifyChannel;
  payload?: Record<string, unknown>;
}

/** 落库一条通知（sms/push 为 stub：仅记录意图，delivered 恒 false，诚实未发送）。 */
export async function insertNotification(client: PoolClient, input: NotifyInput): Promise<void> {
  const channel = input.channel ?? 'in_app';
  await client.query(
    `INSERT INTO notification
       (tenant_id, recipient, recipient_kind, type, work_order_id, title, body, channel, delivered, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      input.tenantId,
      input.recipient,
      input.recipientKind ?? 'worker',
      input.type,
      input.workOrderId,
      input.title,
      input.body ?? null,
      channel,
      channel === 'in_app', // in_app 落库即可达；sms/push 接入前未真实送达
      JSON.stringify(input.payload ?? {}),
    ],
  );
  if (channel !== 'in_app') {
    console.info('[notify] stub channel (NOT actually sent, pending gateway)', {
      type: input.type,
      channel,
      recipient: input.recipient,
      workOrderId: input.workOrderId,
    });
  }
}
