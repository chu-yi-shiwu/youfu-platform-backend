// Webhook 投递模块（P5 事件溯源对外推送）。
// 设计要点：
//  - 纯函数（signWebhook / buildWebhookBody / buildWebhookHeaders / selectSubscriptions）可在无 DB 环境下单测。
//  - dispatchEvent 在工单主事务提交后 fire-and-forget 调用：查订阅 → 逐个 POST（5s 超时）→ 写投递记录。
//  - 投递失败（连接/超时/非 2xx）只落 webhook_delivery.error，**绝不抛出**，工单主流程不受影响（红线）。
//  - 签名：HMAC-SHA256(secret, body)，头 X-Youfu-Signature: sha256=<hex>，外部可据此校验来源真实性。
import crypto from 'node:crypto';
import { withTenantClient } from '../db/pool.js';

export interface WebhookEvent {
  type: string; // create | assign | transition | sla_escalated | webhook_test
  workOrderId: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  actor?: string;
  payload?: unknown;
}

/** 可注入的 fetch 实现（便于测试替换；默认全局 fetch）。 */
export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number; text: () => Promise<string> }>;

let fetchImpl: FetchFn = (globalThis as unknown as { fetch?: FetchFn }).fetch?.bind(globalThis) as FetchFn;
export function setWebhookFetch(fn: FetchFn): void {
  fetchImpl = fn;
}

/** HMAC-SHA256 签名（密钥 + 请求体）。 */
export function signWebhook(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/** 构造对外投递 JSON 体（统一信封，事件详情在 event 字段内）。 */
export function buildWebhookBody(event: WebhookEvent): string {
  const envelope = {
    event: {
      type: event.type,
      work_order_id: event.workOrderId,
      from_status: event.fromStatus ?? null,
      to_status: event.toStatus ?? null,
      actor: event.actor ?? 'system',
      payload: event.payload ?? {},
      occurred_at: new Date().toISOString(),
    },
  };
  return JSON.stringify(envelope);
}

/** 构造投递请求头（含事件类型、投递 ID、签名）。 */
export function buildWebhookHeaders(eventType: string, deliveryId: string, signature: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'User-Agent': 'Youfu-Webhook/1.0',
    'X-Youfu-Event': eventType,
    'X-Youfu-Delivery-Id': deliveryId,
    'X-Youfu-Signature': `sha256=${signature}`,
  };
}

export interface SubscriptionRow {
  id: string;
  url: string;
  secret: string;
  events: string[];
}

/** 按事件类型筛选命中订阅（events 含 '*' 或含该事件类型）。 */
export function selectSubscriptions(subs: SubscriptionRow[], eventType: string): SubscriptionRow[] {
  return subs.filter((s) => s.events.includes('*') || s.events.includes(eventType));
}

const DELIVERY_TIMEOUT_MS = 5000;

/**
 * 向本租户所有命中订阅投递事件。失败仅记录，不抛出。
 * 投递动作发生在工单主事务提交之后，因此在此处新开租户连接即可（不会长时间占用主事务连接）。
 */
export async function dispatchEvent(tenantId: string, event: WebhookEvent): Promise<void> {
  try {
    await withTenantClient(tenantId, async (client) => {
      const subsRes = await client.query<SubscriptionRow>(
        `SELECT id, url, secret, events FROM webhook_subscription
         WHERE tenant_id = $1 AND active = true`,
        [tenantId],
      );
      const targets = selectSubscriptions(subsRes.rows, event.type);
      for (const sub of targets) {
        const deliveryId = crypto.randomUUID();
        const body = buildWebhookBody(event);
        const signature = signWebhook(sub.secret, body);
        const headers = buildWebhookHeaders(event.type, deliveryId, signature);
        let statusCode: number | null = null;
        let responseBody: string | null = null;
        let error: string | null = null;
        try {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), DELIVERY_TIMEOUT_MS);
          const resp = await fetchImpl(sub.url, { method: 'POST', headers, body, signal: ac.signal });
          clearTimeout(timer);
          statusCode = resp.status;
          try {
            responseBody = await resp.text();
          } catch {
            responseBody = null;
          }
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        await client.query(
          `INSERT INTO webhook_delivery
             (tenant_id, subscription_id, event_type, work_order_id, attempt, status_code, response_body, error)
           VALUES ($1,$2,$3,$4,1,$5,$6,$7)`,
          [tenantId, sub.id, event.type, event.workOrderId, statusCode, responseBody, error],
        );
      }
    });
  } catch (e) {
    // 投递链路故障绝不影响主流程
    console.error('[webhook] dispatch failed (non-fatal):', e instanceof Error ? e.message : String(e));
  }
}

/**
 * 探针：向指定 URL 发送一次 webhook_test 事件，校验可达性与签名。
 * 用于 /api/v1/webhooks/test，帮助用户在上线订阅前确认回调地址可用。
 */
export async function probeWebhook(url: string, secret?: string): Promise<{ statusCode: number | null; error: string | null; signature: string }> {
  const probeSecret = secret ?? crypto.randomBytes(24).toString('hex');
  const event: WebhookEvent = {
    type: 'webhook_test',
    workOrderId: 'probe',
    fromStatus: null,
    toStatus: null,
    actor: 'system',
    payload: { probe: true },
  };
  const body = buildWebhookBody(event);
  const signature = signWebhook(probeSecret, body);
  const deliveryId = crypto.randomUUID();
  const headers = buildWebhookHeaders('webhook_test', deliveryId, signature);
  let statusCode: number | null = null;
  let error: string | null = null;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), DELIVERY_TIMEOUT_MS);
    const resp = await fetchImpl(url, { method: 'POST', headers, body, signal: ac.signal });
    clearTimeout(timer);
    statusCode = resp.status;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { statusCode, error, signature: `sha256=${signature}` };
}
