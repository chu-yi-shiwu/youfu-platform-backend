// 微信补投递必须显式 system 作用域（2026-11-15 主站同步实测）
//
// 现象：主站日志 public/repair-report 成功后：
//   [notify:wechat] deferred delivery failed ... AppError: withTenantClient 缺少 auth context
// 根因：flushWechatDeliveries 在 res.on('finish') 后执行，已无请求 ALS 上下文，
//   默认 executor 直接 withTenantClient(tenantId, fn) → MISSING_AUTH_CONTEXT。
// 修复：默认 executor 传 { system: true }。
//
// 负控制：不注入 executor，直接调用 flush，断言底层 withTenantClient 收到的第三个参数。
import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => ({ opts: [] as unknown[] }));
vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tid: string, fn: (c: unknown) => unknown, opts?: unknown) => {
    h.opts.push(opts);
    return fn({ query: async () => ({ rows: [] }) });
  },
  default: { query: async () => ({ rows: [] }) },
}));
vi.mock('../services/httpJson.js', () => ({ httpsPostJson: async () => ({ errcode: 0 }) }));
vi.mock('../services/wechatMp.js', () => ({ getMpAccessToken: async () => 'T', mpConfigured: () => true }));

const { insertNotification, flushWechatDeliveries } = await import('../services/notify.js');

describe('微信 deferred 补投递作用域', () => {
  it('默认 executor 必须传 { system: true }', async () => {
    h.opts.length = 0;
    const client = { query: async () => ({ rows: [] }) } as never;
    await insertNotification(client, {
      tenantId: 't-deferred',
      recipient: 'w-1',
      recipientKind: 'worker',
      type: 'dispatch',
      workOrderId: 'wo-1',
      title: 'x',
      body: 'y',
    });
    flushWechatDeliveries();
    expect(h.opts).toHaveLength(1);
    expect(h.opts[0]).toEqual({ system: true });
  });
});
