// 通知服务抽象层（#355）
// 契约：调用方只依赖 insertNotification(client, input)，不感知渠道实现细节。
// 抽象：NotificationChannel 接口 + 多渠道 adapter（in_app / sms / push），由分发器按 input.channel 路由。
// 诚实边界：in_app 落库即可达（delivered=true）；sms/push 当前为 stub（仅落库 + 日志，delivered=false，未真实发送）。
// 网关接入点：见 SMS_GATEWAY / PUSH_GATEWAY 环境变量位；接入后由对应 adapter 真正投递并把 delivered 置响应结果，
//            调用方契约不变。当前无网关 → 自动 graceful 降级为 stub，绝不谎报"已送达"。
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

/** 单条投递结果：delivered 必须反映真实送达状态（stub 渠道恒 false）。 */
export interface DeliveryResult {
  channel: NotifyChannel;
  delivered: boolean;
  note?: string; // 诚实说明：stub 未真实发送 / 网关失败原因
}

/** 通知渠道抽象：每个渠道实现 send，返回真实送达结果。 */
export interface NotificationChannel {
  readonly name: NotifyChannel;
  send(client: PoolClient, input: NotifyInput): Promise<DeliveryResult>;
}

// ---- 持久化（所有渠道共用：落库一条 notification 记录） ----
async function persist(
  client: PoolClient,
  input: NotifyInput,
  channel: NotifyChannel,
  delivered: boolean,
  note?: string,
): Promise<void> {
  const payload = { ...(input.payload ?? {}) };
  if (note) (payload as Record<string, unknown>)._note = note;
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
      delivered,
      JSON.stringify(payload),
    ],
  );
}

// ---- in_app 渠道：落库即可达 ----
class InAppChannel implements NotificationChannel {
  readonly name = 'in_app' as const;
  async send(client: PoolClient, input: NotifyInput): Promise<DeliveryResult> {
    await persist(client, input, 'in_app', true);
    return { channel: 'in_app', delivered: true };
  }
}

// ---- sms 渠道：真实网关 env-gated；未配置时 stub 诚实降级 ----
class SmsChannel implements NotificationChannel {
  readonly name = 'sms' as const;
  async send(client: PoolClient, input: NotifyInput): Promise<DeliveryResult> {
    const gateway = process.env.SMS_GATEWAY; // 真实短信网关接入点（需外部资源：网关地址 + 凭证）
    if (gateway) {
      // 接入后在此用网关实际投递，delivered 取网关响应；失败则 graceful 降级为 false。
      try {
        const ok = await deliverToGateway(gateway, input);
        await persist(client, input, 'sms', ok, ok ? undefined : 'SMS_GATEWAY deliver failed');
        return { channel: 'sms', delivered: ok };
      } catch (e) {
        const note = `SMS_GATEWAY error: ${(e as Error).message}`;
        await persist(client, input, 'sms', false, note);
        console.error('[notify:sms] gateway delivery failed, degraded', { note, workOrderId: input.workOrderId });
        return { channel: 'sms', delivered: false, note };
      }
    }
    // 无网关 → 仅落库 + 记日志，delivered=false，诚实标注未真实发送。
    const note = 'STUB: SMS_GATEWAY not configured, not actually sent';
    await persist(client, input, 'sms', false, note);
    console.info('[notify:sms] stub (NOT actually sent, pending gateway)', {
      type: input.type, recipient: input.recipient, workOrderId: input.workOrderId,
    });
    return { channel: 'sms', delivered: false, note };
  }
}

// ---- push 渠道：真实网关 env-gated；未配置时 stub 诚实降级 ----
class PushChannel implements NotificationChannel {
  readonly name = 'push' as const;
  async send(client: PoolClient, input: NotifyInput): Promise<DeliveryResult> {
    const gateway = process.env.PUSH_GATEWAY; // 真实推送网关接入点（需外部资源：网关地址 + 凭证）
    if (gateway) {
      try {
        const ok = await deliverToGateway(gateway, input);
        await persist(client, input, 'push', ok, ok ? undefined : 'PUSH_GATEWAY deliver failed');
        return { channel: 'push', delivered: ok };
      } catch (e) {
        const note = `PUSH_GATEWAY error: ${(e as Error).message}`;
        await persist(client, input, 'push', false, note);
        console.error('[notify:push] gateway delivery failed, degraded', { note, workOrderId: input.workOrderId });
        return { channel: 'push', delivered: false, note };
      }
    }
    const note = 'STUB: PUSH_GATEWAY not configured, not actually sent';
    await persist(client, input, 'push', false, note);
    console.info('[notify:push] stub (NOT actually sent, pending gateway)', {
      type: input.type, recipient: input.recipient, workOrderId: input.workOrderId,
    });
    return { channel: 'push', delivered: false, note };
  }
}

/**
 * 真实网关投递（占位实现）：接入真实短信/推送网关时在此实现 HTTP 调用并据响应返回是否送达。
 * 当前未实现（需外部资源），调用方（SmsChannel/PushChannel）仅在对应 env 配置时才进入此分支，
 * 未配置时不会到达，故不影响现有 stub 行为、绝不谎报。
 */
async function deliverToGateway(_gateway: string, _input: NotifyInput): Promise<boolean> {
  // TODO(外部资源): 对接真实短信/推送网关（地址 + 凭证由 SMS_GATEWAY/PUSH_GATEWAY 提供）。
  //   实现：POST gateway，解析响应，返回 delivered 布尔。未完成前保持 throw，由上层 catch 降级。
  throw new Error('gateway delivery not implemented (external resource required)');
}

const CHANNELS: Record<NotifyChannel, NotificationChannel> = {
  in_app: new InAppChannel(),
  sms: new SmsChannel(),
  push: new PushChannel(),
};

/** 通知服务分发器：按 input.channel 选择 adapter；默认 in_app。 */
export async function dispatchNotification(client: PoolClient, input: NotifyInput): Promise<DeliveryResult> {
  const channel = input.channel ?? 'in_app';
  return CHANNELS[channel].send(client, input);
}

/**
 * 兼容导出：保持既有调用方（routes/workOrder.ts）签名不变。
 * 落库一条通知；sms/push 为 stub，delivered 恒 false，诚实未发送。
 */
export async function insertNotification(client: PoolClient, input: NotifyInput): Promise<void> {
  await dispatchNotification(client, input);
}
