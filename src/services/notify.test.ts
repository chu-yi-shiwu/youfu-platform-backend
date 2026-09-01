// notify 通知层单元测试（vitest）
// 目标：验证诚实边界（任一外部资源缺失 → delivered=false 且 note 诚实标注）+ 渠道路由 + worker openid 解析 + 网关真发路径。
// 不触真实网络：vi.mock('node:https') 拦截 token / 订阅消息 / 网关响应。
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- 拦截本地 httpJson 与 wechatMp：避免真实网络，按 URL 返回伪造微信/网关响应 ----
const { getLastPost, setLastPost } = vi.hoisted(() => {
  let lastPost: any = null;
  return { getLastPost: () => lastPost, setLastPost: (v: any) => { lastPost = v; } };
});
vi.mock('./httpJson.js', () => ({
  httpsPostJson: async (url: string, body: any) => {
    setLastPost({ url, body });
    if (url.includes('/cgi-bin/message/subscribe/send')) return { errcode: 0, errmsg: 'ok' };
    return { errcode: 0 }; // 通用短信/推送网关：errcode 0 = 成功
  },
}));

vi.mock('./wechatMp.js', () => ({
  getMpAccessToken: async () => 'FAKE_TOKEN',
  mpConfigured: () => true,
}));

// 动态 import 必须在 mock 之后
const { dispatchNotification, insertNotification, flushWechatDeliveries } = await import('./notify.js');

// ---- 伪造 PoolClient ----
type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[] }>;
function makeClient(handler: QueryFn) {
  return {
    query: vi.fn(async (text: string, params?: any[]) => handler(text, params)),
  } as any;
}

// 根据 SQL 文本分流：worker 解析 / account 解析 / 落库 INSERT
function defaultHandler(opts: {
  workerOpenid?: string | null;
  accountOpenid?: string | null;
  workerPhone?: string | null;
}): QueryFn {
  return async (text: string) => {
    if (text.includes('FROM worker w')) {
      return { rows: [{ wx_openid: opts.workerOpenid ?? null }] };
    }
    if (text.includes('SELECT phone FROM worker')) {
      return { rows: [{ phone: opts.workerPhone ?? null }] };
    }
    if (text.includes('FROM account_user WHERE')) {
      return { rows: [{ wx_openid: opts.accountOpenid ?? null }] };
    }
    if (text.includes('INSERT INTO notification')) {
      return { rows: [] };
    }
    return { rows: [] };
  };
}

const baseInput = {
  tenantId: 't-verification',
  recipient: 'worker_1',
  recipientKind: 'worker' as const,
  type: 'dispatch',
  workOrderId: 'wo_1',
  title: '您有一条新工单',
  body: '请尽快处理',
};

describe('notify 诚实边界 + 路由', () => {
  beforeEach(() => {
    // 默认清空相关 env，保证 stub 路径
    delete process.env.SMS_GATEWAY;
    delete process.env.PUSH_GATEWAY;
    delete process.env.WX_MP_TEMPLATE_ID;
    delete process.env.MP_APPID;
    delete process.env.MP_SECRET;
    delete process.env.WX_MP_APPID;
    delete process.env.WX_MP_SECRET;
  });

  it('in_app：落库即可达 delivered=true', async () => {
    const client = makeClient(defaultHandler({}));
    const r = await dispatchNotification(client, { ...baseInput, channel: 'in_app' });
    expect(r.channel).toBe('in_app');
    expect(r.delivered).toBe(true);
    // 落库 INSERT 被调用，且 delivered 列传 true
    const insertCall = (client.query as any).mock.calls.find((c: any[]) => c[0].includes('INSERT INTO notification'));
    expect(insertCall).toBeTruthy();
    expect(insertCall[1][8]).toBe(true);
  });

  it('sms 未配置网关：诚实 stub（delivered=false，note 含 STUB）', async () => {
    const client = makeClient(defaultHandler({}));
    const r = await dispatchNotification(client, { ...baseInput, channel: 'sms' });
    expect(r.delivered).toBe(false);
    expect(r.note).toContain('STUB');
    const insertCall = (client.query as any).mock.calls.find((c: any[]) => c[0].includes('INSERT INTO notification'));
    expect(insertCall[1][8]).toBe(false); // 落库 delivered 列 = false（诚实）
  });

  it('push 未配置网关：诚实 stub（delivered=false）', async () => {
    const client = makeClient(defaultHandler({}));
    const r = await dispatchNotification(client, { ...baseInput, channel: 'push' });
    expect(r.delivered).toBe(false);
    expect(r.note).toContain('STUB');
  });

  it('wechat 未配置模板：诚实 stub（delivered=false）', async () => {
    const client = makeClient(defaultHandler({ workerOpenid: 'OPENID_X' }));
    const r = await dispatchNotification(client, { ...baseInput, channel: 'wechat' });
    expect(r.delivered).toBe(false);
    expect(r.note).toContain('STUB');
  });

  it('wechat 配置齐全但接收方未绑 openid：诚实 stub（delivered=false）', async () => {
    process.env.MP_APPID = 'appid';
    process.env.MP_SECRET = 'secret';
    process.env.WX_MP_TEMPLATE_ID = 'tpl_1';
    const client = makeClient(defaultHandler({ workerOpenid: null }));
    const r = await dispatchNotification(client, { ...baseInput, channel: 'wechat', recipientKind: 'worker' });
    expect(r.delivered).toBe(false);
    expect(r.note).toContain('no bound wechat openid');
  });

  it('🔴B1 修复验证：wechat 配置齐全 + worker 接收方经 account_id 解析到 openid → 真发 delivered=true', async () => {
    process.env.MP_APPID = 'appid';
    process.env.MP_SECRET = 'secret';
    process.env.WX_MP_TEMPLATE_ID = 'tpl_1';
    const client = makeClient(defaultHandler({ workerOpenid: 'OPENID_FROM_WORKER_LINK' }));
    const r = await dispatchNotification(client, { ...baseInput, channel: 'wechat', recipientKind: 'worker' });
    expect(r.delivered).toBe(true);
    // 验证走了 worker→account_user JOIN 解析（而非直接 account_user WHERE id=worker.id）
    const resolveCall = (client.query as any).mock.calls.find((c: any[]) => c[0].includes('FROM worker w'));
    expect(resolveCall).toBeTruthy();
  });

  it('wechat 配置齐全 + account 接收方已绑 openid → 真发 delivered=true', async () => {
    process.env.MP_APPID = 'appid';
    process.env.MP_SECRET = 'secret';
    process.env.WX_MP_TEMPLATE_ID = 'tpl_1';
    const client = makeClient(defaultHandler({ accountOpenid: 'OPENID_ACCOUNT' }));
    const r = await dispatchNotification(client, {
      ...baseInput, channel: 'wechat', recipientKind: 'account', recipient: '00000000-0000-4000-8000-00000000000a',
    });
    expect(r.delivered).toBe(true);
    const resolveCall = (client.query as any).mock.calls.find((c: any[]) => c[0].includes('FROM account_user WHERE'));
    expect(resolveCall).toBeTruthy();
  });

  it('sms 配置网关但无手机号：诚实 stub（绝不拿 worker.id 当手机号投递）', async () => {
    process.env.SMS_GATEWAY = 'http://fake-gw/send';
    const client = makeClient(defaultHandler({}));
    const r = await dispatchNotification(client, { ...baseInput, channel: 'sms' });
    expect(r.delivered).toBe(false);
    expect(r.note).toContain('no resolvable phone');
  });

  it('sms 配置网关且 payload.phone 已解析 → 真发 delivered=true', async () => {
    process.env.SMS_GATEWAY = 'http://fake-gw/send';
    const client = makeClient(defaultHandler({}));
    const r = await dispatchNotification(client, {
      ...baseInput, channel: 'sms', payload: { phone: '13800000000' },
    });
    expect(r.delivered).toBe(true);
  });

  it('sms 配置网关且 worker.phone 已录入(057列) → 真发 delivered=true（验证走 DB 解析）', async () => {
    process.env.SMS_GATEWAY = 'http://fake-gw/send';
    const client = makeClient(defaultHandler({ workerPhone: '13900000000' }));
    const r = await dispatchNotification(client, { ...baseInput, channel: 'sms', recipientKind: 'worker' });
    expect(r.delivered).toBe(true);
    const phoneCall = (client.query as any).mock.calls.find((c: any[]) => c[0].includes('SELECT phone FROM worker'));
    expect(phoneCall).toBeTruthy();
  });

  it('sms 配置网关但 worker.phone 格式非法 → 诚实 stub（绝不误投网关）', async () => {
    process.env.SMS_GATEWAY = 'http://fake-gw/send';
    const client = makeClient(defaultHandler({ workerPhone: '123' }));
    const r = await dispatchNotification(client, { ...baseInput, channel: 'sms', recipientKind: 'worker' });
    expect(r.delivered).toBe(false);
    expect(r.note).toContain('no resolvable phone');
  });

  it('insertNotification 为 dispatchNotification 的兼容别名（返回 void，仍落库）', async () => {
    const client = makeClient(defaultHandler({}));
    await expect(insertNotification(client, { ...baseInput, channel: 'in_app' })).resolves.toBeUndefined();
    const insertCall = (client.query as any).mock.calls.find((c: any[]) => c[0].includes('INSERT INTO notification'));
    expect(insertCall).toBeTruthy();
  });

  it('默认 fan-out（无 channel）：以主通道 in_app 必达为准，返回 delivered=true 且产生 2 条落库', async () => {
    const client = makeClient(defaultHandler({})); // wechat 无模板 → stub；in_app → 真
    const r = await dispatchNotification(client, { ...baseInput }); // 不设 channel，触发默认双通道
    expect(r.channel).toBe('in_app');
    expect(r.delivered).toBe(true); // 不被 wechat 常态 43101 覆盖而误报失败
    const inserts = (client.query as any).mock.calls.filter((c: any[]) => c[0].includes('INSERT INTO notification'));
    expect(inserts.length).toBe(2); // in_app(真) + wechat(stub)
  });

  it('R31-Q1：insertNotification 默认 fan-out 延迟 wechat——事务内仅 in_app 落库，flush 后补投递', async () => {
    const client = makeClient(defaultHandler({})); // wechat 无模板 → stub；in_app → 真
    await insertNotification(client, { ...baseInput }); // 无 channel → deferred fan-out
    let inserts = (client.query as any).mock.calls.filter((c: any[]) => c[0].includes('INSERT INTO notification'));
    expect(inserts.length).toBe(1); // 事务内仅 in_app 必达；wechat 已入队不在事务内
    const flushed = flushWechatDeliveries(async (_tid: string, fn: (c: any) => Promise<unknown>) => fn(client));
    expect(flushed).toBe(1); // 队列中 1 条 wechat 待投递
    await new Promise((r) => setTimeout(r, 0)); // fire-and-forget 微任务排空
    inserts = (client.query as any).mock.calls.filter((c: any[]) => c[0].includes('INSERT INTO notification'));
    expect(inserts.length).toBe(2); // flush 后 wechat 凭证记录补落库（与原 fan-out 等价）
    // 队列清空：再次 flush 应为 0
    expect(flushWechatDeliveries(async (_tid: string, fn: (c: any) => Promise<unknown>) => fn(client))).toBe(0);
  });

  it('payload.wxData 结构非法（缺 value）→ 回退默认 thing1~thing4 拼装，不抛错', async () => {
    process.env.MP_APPID = 'appid';
    process.env.MP_SECRET = 'secret';
    process.env.WX_MP_TEMPLATE_ID = 'tpl_1';
    setLastPost(null);
    const client = makeClient(defaultHandler({ workerOpenid: 'OPENID_X' }));
    const r = await dispatchNotification(client, {
      ...baseInput, channel: 'wechat', recipientKind: 'worker',
      payload: { wxData: { thing1: { wrong: 'x' } } }, // 缺 value 字段 → 非法，应回退默认
    });
    expect(r.delivered).toBe(true); // mock 返回 errcode 0
    const post = getLastPost();
    expect(post?.url).toContain('/cgi-bin/message/subscribe/send');
    expect(post?.body.data.thing1?.value).toBeTruthy(); // 回退默认拼装，而非透传非法 wxData
  });

  it('🔴B 修复验证：payload.page 透传进微信订阅消息 body（点击服务通知深链到工单详情）', async () => {
    process.env.MP_APPID = 'appid';
    process.env.MP_SECRET = 'secret';
    process.env.WX_MP_TEMPLATE_ID = 'tpl_1';
    setLastPost(null);
    const client = makeClient(defaultHandler({ workerOpenid: 'OPENID_X' }));
    const r = await dispatchNotification(client, {
      ...baseInput, channel: 'wechat', recipientKind: 'worker',
      workOrderId: 'wo-abc-123',
      payload: { page: 'pages/worker/task-detail/task-detail?id=wo-abc-123' },
    });
    expect(r.delivered).toBe(true);
    const post = getLastPost();
    expect(post?.url).toContain('/cgi-bin/message/subscribe/send');
    // 关键断言：page 进入 body，否则点服务通知只会开首页（用户报「通知无法点击触发」根因）
    expect(post?.body.page).toBe('pages/worker/task-detail/task-detail?id=wo-abc-123');
  });

  it('payload.page 缺失时 body 不含 page（微信退回默认首页，行为可预期）', async () => {
    process.env.MP_APPID = 'appid';
    process.env.MP_SECRET = 'secret';
    process.env.WX_MP_TEMPLATE_ID = 'tpl_1';
    setLastPost(null);
    const client = makeClient(defaultHandler({ workerOpenid: 'OPENID_X' }));
    await dispatchNotification(client, {
      ...baseInput, channel: 'wechat', recipientKind: 'worker',
      payload: {},
    });
    const post = getLastPost();
    expect(post?.body.page).toBeUndefined();
  });
});
