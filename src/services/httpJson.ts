// 通用 HTTP(S) JSON 助手（被通知层与微信能力层复用，消除重复实现）。
// 注意：Node16 无全局 fetch，统一用 http/https 模块；按 URL 协议自动选择传输层，
//      避免对 http:// 网关（如内网 SMS_GATEWAY）强行 TLS 握手失败。
import http from 'node:http';
import https from 'node:https';

/** 按 URL 协议选择传输模块（http:// 走 http，其余走 https）。 */
type Transport = { request: typeof http.request };
function transportFor(url: string): Transport {
  return (url.startsWith('https:') ? https : http) as unknown as Transport;
}

/** 上游响应体硬上限（1MB）。防恶意/异常上游无限流式撑爆内存。 */
export const MAX_RESPONSE_BYTES = 1_048_576;

/**
 * R5-BUG-001 修复：整体硬死线。
 * https.request 的 timeout 选项只覆盖 socket 建立**之后**的不活跃；
 * DNS 解析/建连阶段挂起（解析器卡死等）不会触发 socket timeout → Promise 无限挂起。
 * 此包装保证无论哪个阶段卡死，deadline 到点必然 reject（由调用方诚实降级）。
 */
function withDeadline<T>(p: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} hard deadline ${timeoutMs}ms exceeded`)), timeoutMs).unref?.()),
  ]);
}

/** HTTPS POST（JSON）并解析响应体。5xx 视为网关故障主动 reject（由调用方落入 delivered=false）。
 * @param extraHeaders 额外请求头（如 Authorization: Bearer <key>）；与内置 Content-Type/Content-Length 合并，不覆盖。 */
export function httpsPostJson(url: string, bodyObj: unknown, timeoutMs = 8000, extraHeaders: Record<string, string> = {}): Promise<any> {
  return withDeadline(httpsPostJsonRaw(url, bodyObj, timeoutMs, extraHeaders), timeoutMs + 2000, 'httpsPostJson');
}

function httpsPostJsonRaw(url: string, bodyObj: unknown, timeoutMs = 8000, extraHeaders: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = JSON.stringify(bodyObj);
    const req = transportFor(url).request(
      {
        hostname: u.hostname,
        port: u.port ? Number(u.port) : undefined,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extraHeaders },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error('response body exceeds MAX_RESPONSE_BYTES'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 500) {
            reject(new Error(`gateway http ${res.statusCode}: ${raw.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error('gateway json parse fail: ' + raw.slice(0, 200)));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('gateway timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** HTTPS GET（JSON）并解析响应体。 */
export function httpsGetJson(url: string, timeoutMs = 8000): Promise<any> {
  return withDeadline(httpsGetJsonRaw(url, timeoutMs), timeoutMs + 2000, 'httpsGetJson');
}

function httpsGetJsonRaw(url: string, timeoutMs = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = transportFor(url).request(
      {
        hostname: u.hostname,
        port: u.port ? Number(u.port) : undefined,
        path: u.pathname + u.search,
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(new Error('response body exceeds MAX_RESPONSE_BYTES'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error('gateway json parse fail'));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('gateway timeout')));
    req.on('error', reject);
    req.end();
  });
}
