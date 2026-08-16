// Webhook 投递模块纯函数单测（不依赖 DB / 网络）。
// 覆盖签名正确性、事件选择、信封体结构、请求头结构——均为安全/契约关键路径。
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  signWebhook,
  buildWebhookBody,
  buildWebhookHeaders,
  selectSubscriptions,
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
