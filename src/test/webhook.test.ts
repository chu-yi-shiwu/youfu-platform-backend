// Webhook 投递模块纯函数单测（不依赖 DB / 网络）。
// 覆盖签名正确性、事件选择、信封体结构、请求头结构——均为安全/契约关键路径。
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import {
  signWebhook,
  buildWebhookBody,
  buildWebhookHeaders,
  selectSubscriptions,
  classifyHostIp,
  assertSafeOutboundUrl,
  resolveSafeOutboundUrl,
  defaultWebhookFetch,
  type SubscriptionRow,
} from '../webhook/dispatch.js';

describe('signWebhook（HMAC-SHA256 签名）', () => {
  it('与 node crypto 直接计算一致', () => {
    const secret = 'topsecret';
    const body = '{"event":{"type":"create"}}';
    const expected = crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(signWebhook(secret, body)).toBe(expected);
  });
  it('相同输入稳定、不同密钥结果不同', () => {
    const body = 'payload';
    const a = signWebhook('k1', body);
    const b = signWebhook('k1', body);
    const c = signWebhook('k2', body);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('buildWebhookBody（统一信封）', () => {
  it('结构正确，默认值补齐', () => {
    const raw = buildWebhookBody({ type: 'create', workOrderId: 'wo-1' });
    const env = JSON.parse(raw);
    expect(env.event.type).toBe('create');
    expect(env.event.work_order_id).toBe('wo-1');
    expect(env.event.from_status).toBeNull();
    expect(env.event.to_status).toBeNull();
    expect(env.event.actor).toBe('system');
    expect(env.event.payload).toEqual({});
    expect(() => new Date(env.event.occurred_at).toISOString()).not.toThrow();
  });
  it('携带 from/to/payload', () => {
    const env = JSON.parse(
      buildWebhookBody({ type: 'transition', workOrderId: 'wo-2', fromStatus: 'assigned', toStatus: 'processing', actor: 'u1', payload: { foo: 1 } }),
    );
    expect(env.event.from_status).toBe('assigned');
    expect(env.event.to_status).toBe('processing');
    expect(env.event.payload).toEqual({ foo: 1 });
  });
});

describe('buildWebhookHeaders', () => {
  it('含事件类型/投递ID/签名前缀', () => {
    const sig = 'abc123';
    const h = buildWebhookHeaders('create', 'del-9', sig);
    expect(h['X-Youfu-Event']).toBe('create');
    expect(h['X-Youfu-Delivery-Id']).toBe('del-9');
    expect(h['X-Youfu-Signature']).toBe(`sha256=${sig}`);
    expect(h['Content-Type']).toBe('application/json');
  });
});

describe('selectSubscriptions（事件类型筛选）', () => {
  const subs: SubscriptionRow[] = [
    { id: 's1', url: 'http://a', secret: 'x', events: ['create', 'assign'] },
    { id: 's2', url: 'http://b', secret: 'x', events: ['*'] },
    { id: 's3', url: 'http://c', secret: 'x', events: ['sla_escalated'] },
  ];
  it('具体类型只命中订阅该类型的', () => {
    const hit = selectSubscriptions(subs, 'create').map((s) => s.id);
    expect(hit).toEqual(['s1', 's2']); // s2 的 '*' 命中全部
  });
  it('未订阅类型不命中', () => {
    const hit = selectSubscriptions(subs, 'transition').map((s) => s.id);
    expect(hit).toEqual(['s2']); // 仅 '*'
  });
  it('空订阅返回空', () => {
    expect(selectSubscriptions([], 'create')).toEqual([]);
  });
});

describe('classifyHostIp（SSRF 私网判定，F-E2）', () => {
  it('公网 IPv4 判定为 public', () => {
    expect(classifyHostIp('8.8.8.8')).toBe('public');
    expect(classifyHostIp('1.1.1.1')).toBe('public');
  });
  it('环回/私网/链路本地(含云元数据)/CGNAT IPv4 判为 blocked', () => {
    expect(classifyHostIp('127.0.0.1')).toBe('blocked');
    expect(classifyHostIp('10.0.0.5')).toBe('blocked');
    expect(classifyHostIp('172.16.0.1')).toBe('blocked');
    expect(classifyHostIp('172.31.255.255')).toBe('blocked');
    expect(classifyHostIp('192.168.1.1')).toBe('blocked');
    expect(classifyHostIp('169.254.169.254')).toBe('blocked'); // 云元数据
    expect(classifyHostIp('100.64.0.1')).toBe('blocked'); // CGNAT
    expect(classifyHostIp('0.0.0.0')).toBe('blocked');
  });
  it('环回/链路本地/唯一本地 IPv6 判为 blocked；公网 IPv6 public', () => {
    expect(classifyHostIp('::1')).toBe('blocked');
    expect(classifyHostIp('fe80::1')).toBe('blocked');
    expect(classifyHostIp('fc00::1')).toBe('blocked');
    expect(classifyHostIp('fd12:3456::1')).toBe('blocked');
    expect(classifyHostIp('2606:4700:4700::1111')).toBe('public');
  });
  it('IPv4 映射 IPv6 透传底层 v4 判定', () => {
    expect(classifyHostIp('::ffff:127.0.0.1')).toBe('blocked');
    expect(classifyHostIp('::ffff:8.8.8.8')).toBe('public');
  });
});

describe('assertSafeOutboundUrl（SSRF 出站闸，F-E2）', () => {
  it('拒绝非 http/https 协议', async () => {
    await expect(assertSafeOutboundUrl('file:///etc/passwd')).rejects.toThrow();
    await expect(assertSafeOutboundUrl('gopher://127.0.0.1:6379')).rejects.toThrow();
  });
  it('拒绝环回/私网 IP 字面量', async () => {
    await expect(assertSafeOutboundUrl('http://127.0.0.1:8080/hook')).rejects.toThrow('BLOCKED_PRIVATE_OR_LOOPBACK_ADDRESS');
    await expect(assertSafeOutboundUrl('https://192.168.0.1/x')).rejects.toThrow('BLOCKED_PRIVATE_OR_LOOPBACK_ADDRESS');
    await expect(assertSafeOutboundUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow('BLOCKED_PRIVATE_OR_LOOPBACK_ADDRESS');
  });
  it('允许公网地址（IP 字面量，无网络依赖）', async () => {
    await expect(assertSafeOutboundUrl('https://8.8.8.8/webhook')).resolves.toBeUndefined();
    await expect(assertSafeOutboundUrl('http://1.1.1.1:9000/h')).resolves.toBeUndefined();
  });
});

describe('resolveSafeOutboundUrl（R12-001：解析+固定 IP，防 DNS rebinding）', () => {
  it('IP 字面量返回 pin 结果且不含 DNS 依赖', async () => {
    const r = await resolveSafeOutboundUrl('https://8.8.8.8:8443/hook?a=1');
    expect(r.protocol).toBe('https:');
    expect(r.host).toBe('8.8.8.8');
    expect(r.ip).toBe('8.8.8.8');
    expect(r.port).toBe(8443);
    expect(r.pathname).toBe('/hook');
    expect(r.search).toBe('?a=1');
  });
  it('拒绝非 http/https 与私网地址（与闸一致）', async () => {
    await expect(resolveSafeOutboundUrl('ftp://example.com/x')).rejects.toThrow('ONLY_HTTP_HTTPS_ALLOWED');
    await expect(resolveSafeOutboundUrl('http://10.0.0.5/x')).rejects.toThrow('BLOCKED_PRIVATE_OR_LOOPBACK_ADDRESS');
  });
  it('HTTP 默认端口省略时 port 为 undefined', async () => {
    const r = await resolveSafeOutboundUrl('http://1.1.1.1/path');
    expect(r.port).toBeUndefined();
  });
});

describe('defaultWebhookFetch（F-E1：Node16 无全局 fetch，须走 https 模块）', () => {
  it('实际发出 POST 并返回 status + text（不依赖 globalThis.fetch）', async () => {
    const server = http.createServer((req, res) => {
      let buf = '';
      req.on('data', (c: Buffer) => (buf += c.toString('utf8')));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: buf }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    try {
      const resp = await defaultWebhookFetch(`http://127.0.0.1:${port}/x`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"hello":"world"}',
      });
      expect(resp.status).toBe(200);
      const txt = await resp.text();
      expect(JSON.parse(txt).received).toBe('{"hello":"world"}');
    } finally {
      server.close();
    }
  });
});
