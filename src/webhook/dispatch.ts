// Webhook 投递模块（P5 事件溯源对外推送）。
// 设计要点：
//  - 纯函数（signWebhook / buildWebhookBody / buildWebhookHeaders / selectSubscriptions）可在无 DB 环境下单测。
//  - dispatchEvent 在工单主事务提交后 fire-and-forget 调用：查订阅 → 逐个 POST（5s 超时）→ 写投递记录。
//  - 投递失败（连接/超时/非 2xx）只落 webhook_delivery.error，**绝不抛出**，工单主流程不受影响（红线）。
//  - 签名：HMAC-SHA256(secret, body)，头 X-Youfu-Signature: sha256=<hex>，外部可据此校验来源真实性。
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { withTenantClient } from '../db/pool.js';

export interface WebhookEvent {
  type: string; // create | assign | transition | sla_escalated | webhook_test
  workOrderId: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  actor?: string;
  payload?: unknown;
}

/** 可注入的 fetch 实现（便于测试替换）。 */
export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number; text: () => Promise<string> }>;

const MAX_WEBHOOK_RESPONSE_BYTES = 1_048_576; // 1MB，防恶意订阅方无限响应撑爆内存

/**
 * 默认投递实现：用 https 模块（Node16 无全局 fetch，故不能依赖 globalThis.fetch）。
 * 返回 { status, text() }，与 FetchFn 契约一致；超时 / abort / 响应上限均受控。
 */
export function defaultWebhookFetch(
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
): Promise<{ status: number; text: () => Promise<string> }> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    // 直连时保留原始域名的 Host 头（虚拟主机兼容）；HTTPS 用其做 SNI，避免连 IP 时证书校验失败。
    const hostHeader = (init.headers && init.headers['Host']) || u.hostname;
    const transport = u.protocol === 'https:' ? https : http;
    const reqOptions: http.RequestOptions = {
      hostname: u.hostname,
      port: u.port ? Number(u.port) : undefined,
      path: u.pathname + u.search,
      method: init.method,
      headers: { ...init.headers, Host: hostHeader },
      timeout: DELIVERY_TIMEOUT_MS,
    };
    // HTTPS：SNI 用原始域名而非直连 IP，否则自定义域名目标证书校验失败（R12-001 配合 pin 直连）
    if (u.protocol === 'https:') (reqOptions as https.RequestOptions).servername = hostHeader;
    const req = transport.request(reqOptions,
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_WEBHOOK_RESPONSE_BYTES) {
            req.destroy(new Error('webhook response too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, text: async () => Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    if (init.signal) {
      init.signal.addEventListener('abort', () => req.destroy(new Error('aborted')));
    }
    req.on('timeout', () => req.destroy(new Error('webhook timeout')));
    req.on('error', reject);
    req.write(init.body);
    req.end();
  });
}

let fetchImpl: FetchFn = defaultWebhookFetch;
export function setWebhookFetch(fn: FetchFn): void {
  fetchImpl = fn;
}

// ---- SSRF 防护：禁止出站请求打到环回 / 私网 / 链路本地（含云元数据 169.254.169.254）/ CGNAT ----
function isIpv4Private(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // 环回
  if (a === 169 && b === 254) return true; // 链路本地（含云元数据）
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  return false;
}
function isIpv6Private(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === '::1' || s === '::') return true; // 环回 / 未指定
  if (s.startsWith('fe80:') || s.startsWith('fe80::')) return true; // 链路本地
  if (s.startsWith('fc') || s.startsWith('fd')) return true; // 唯一本地 fc00::/7
  const m = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4 映射
  if (m) return isIpv4Private(m[1]);
  return false;
}
/** 纯函数：判断一个 IP 字面量是否属于被封禁的私网/环回/链路本地范围。 */
export function classifyHostIp(ip: string): 'public' | 'blocked' {
  if (net.isIP(ip) === 4) return isIpv4Private(ip) ? 'blocked' : 'public';
  if (net.isIP(ip) === 6) return isIpv6Private(ip) ? 'blocked' : 'public';
  return 'public'; // 非 IP 字面量，交由调用方 DNS 解析后再判定
}

export interface ResolvedOutbound {
  protocol: 'http:' | 'https:';
  host: string; // 原始域名（用于 Host 头 / TLS SNI）
  port?: number;
  ip: string; // 固定（pin）后的首个安全地址
  pathname: string;
  search: string;
}

/**
 * 解析并校验出站 URL 安全：仅允许 http/https，且解析后的地址不得为环回/私网/链路本地（含云元数据）/CGNAT。
 * 多租户下，租户可任意填写 webhook 地址，若不打此闸，租户可借服务端出网探测宿主机内网 / 云元数据。
 * 失败即抛错（fail-closed）；DNS 解析失败同样拒绝投递。
 *
 * 与旧 assertSafeOutboundUrl 的关键差异：本函数返回「已固定（pin）的解析结果」，调用方必须拿返回的 ip
 * 直连，不再用原始 hostname 重新解析——从而封堵 DNS rebinding（解析期给公网 IP、连接期给私网 IP 的经典
 * SSRF 绕过）。R12-001。
 */
export async function resolveSafeOutboundUrl(url: string): Promise<ResolvedOutbound> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('INVALID_URL');
  }
  const proto = u.protocol;
  if (proto !== 'http:' && proto !== 'https:') throw new Error('ONLY_HTTP_HTTPS_ALLOWED');
  const host = u.hostname;
  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      const res = await dns.promises.lookup(host, { all: true });
      addresses = res.map((r) => r.address);
    } catch {
      throw new Error('DNS_RESOLVE_FAILED'); // fail-closed：解析不到不投递
    }
  }
  for (const addr of addresses) {
    if (classifyHostIp(addr) === 'blocked') throw new Error('BLOCKED_PRIVATE_OR_LOOPBACK_ADDRESS');
  }
  return {
    protocol: proto as 'http:' | 'https:',
    host,
    port: u.port ? Number(u.port) : undefined,
    ip: addresses[0],
    pathname: u.pathname,
    search: u.search,
  };
}

/** 出站 URL 安全闸（向后兼容）：校验通过即返回，否则抛错。内部复用 resolveSafeOutboundUrl。 */
export async function assertSafeOutboundUrl(url: string): Promise<void> {
  await resolveSafeOutboundUrl(url);
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
        // SSRF 闸（F-E2，R12-001 修复）：解析 + 校验一次并固定 IP，杜绝 DNS rebinding 绕过
        let resolved: ResolvedOutbound | null = null;
        try {
          resolved = await resolveSafeOutboundUrl(sub.url);
        } catch (se) {
          error = 'SSRF guard: ' + (se instanceof Error ? se.message : String(se));
        }
        if (!error && resolved) {
          // 直连固定 IP，Host 头保留原始域名（虚拟主机 / HTTPS SNI 兼容）
          const pinnedUrl = `${resolved.protocol}//${resolved.ip}${resolved.port ? ':' + resolved.port : ''}${resolved.pathname}${resolved.search}`;
          try {
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), DELIVERY_TIMEOUT_MS);
            const resp = await fetchImpl(pinnedUrl, { method: 'POST', headers: { ...headers, Host: resolved.host }, body, signal: ac.signal });
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
  let resolved: ResolvedOutbound | null = null;
  try {
    resolved = await resolveSafeOutboundUrl(url); // SSRF 闸（F-E2，R12-001）：解析+校验+固定 IP
  } catch (se) {
    return { statusCode: null, error: 'SSRF guard: ' + (se instanceof Error ? se.message : String(se)), signature: `sha256=${signature}` };
  }
  try {
    // 直连固定 IP，Host 头保留原始域名（虚拟主机 / HTTPS SNI 兼容）
    const pinnedUrl = `${resolved.protocol}//${resolved.ip}${resolved.port ? ':' + resolved.port : ''}${resolved.pathname}${resolved.search}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), DELIVERY_TIMEOUT_MS);
    const resp = await fetchImpl(pinnedUrl, { method: 'POST', headers: { ...headers, Host: resolved.host }, body, signal: ac.signal });
    clearTimeout(timer);
    statusCode = resp.status;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { statusCode, error, signature: `sha256=${signature}` };
}
