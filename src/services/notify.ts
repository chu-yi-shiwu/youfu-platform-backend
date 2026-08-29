// 通知服务抽象层（#355）
// 契约：调用方只依赖 insertNotification(client, input)，不感知渠道实现细节。
// 抽象：NotificationChannel 接口 + 多渠道 adapter（in_app / sms / push / wechat），由分发器按 input.channel 路由。
// 诚实边界：
//   - in_app 落库即可达（delivered=true）；
//   - sms/push 为 URL 网关（SMS_GATEWAY / PUSH_GATEWAY），网关配置且能解析到真实手机号时真实 HTTP 投递，
//     未配置 / 无法解析手机号时诚实 stub（delivered=false，未真实发送）；
//   - wechat 为微信订阅消息（小程序 openid，WX_MP_TEMPLATE_ID），配置且接收方已绑 openid 时真实调用，
//     未配置 / 未绑 openid / 用户未订阅模板时一律诚实 stub（delivered=false）。
// 网关接入点：SMS_GATEWAY / PUSH_GATEWAY（URL 网关）→ deliverToGateway；微信订阅消息 → WechatChannel（env 门控）。
// 所有外部资源缺失时一律 graceful 降级为 stub，delivered=false + note 诚实标注，绝不谎报"已送达"。
import type { PoolClient } from 'pg';
import { mpConfigured, getMpAccessToken } from './wechatMp.js';
import { httpsPostJson } from './httpJson.js';
import { maskPhone } from './llm.js'; // R30-F1：网关出境正文脱敏（llm.ts 仅依赖 pool/httpJson，无循环依赖）

export type NotifyChannel = 'in_app' | 'sms' | 'push' | 'wechat';
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

// ---- 接收方 openid 解析（按 recipientKind 路由，worker 身份同源兜底） ----
// 根因：account_user.id 为 uuid，worker.id/worker.account_id 为 text，旧 JOIN `a.id = w.account_id`
// 触发 uuid=text 类型错误 → 整个 worker 分支运行时报错被 catch → 永远走诚实 stub（9 人收不到推送真因，其中 8 人未绑 openid）。
// 修复：a.id 转 text 对齐（uuid→text 恒安全），并补 OR a.id::text = w.id 同源兜底（与 /open/me/summary 一致）。
async function resolveOpenid(
  client: PoolClient,
  input: NotifyInput,
): Promise<string | null> {
  if (input.recipientKind === 'worker') {
    const { rows } = await client.query<{ wx_openid: string | null }>(
      `SELECT a.wx_openid
         FROM worker w
         LEFT JOIN account_user a ON a.tenant_id = w.tenant_id AND (a.id::text = w.account_id OR a.id::text = w.id)
        WHERE w.tenant_id = $1 AND w.id = $2`,
      [input.tenantId, input.recipient],
    );
    return rows[0]?.wx_openid || null;
  }
  // account / desk 接收方：直接查 account_user（desk 亦映射到后台账号）
  const { rows } = await client.query<{ wx_openid: string | null }>(
    `SELECT wx_openid FROM account_user WHERE tenant_id = $1 AND id = $2`,
    [input.tenantId, input.recipient],
  );
  return rows[0]?.wx_openid || null;
}

// ---- SMS/Push 真实手机号解析（优先 payload.phone，其次 worker.phone 列：057 迁移已加） ----
// 真实投递要求能解析到接收方手机号；若无法解析（数据缺失或未录入），上层诚实 stub，绝不拿 worker.id 当手机号投递。
async function resolveSmsTarget(
  client: PoolClient,
  input: NotifyInput,
): Promise<string | null> {
  // 优先使用调用方已解析并放入 payload.phone 的值（若后端有手机号数据渠道）。
  // R30-F2：payload.phone 同样须过格式校验——调用方误传非手机号字符串时诚实 stub，不把脏值投给外部网关。
  const fromPayload = input.payload?.phone;
  if (typeof fromPayload === 'string' && /^1[3-9]\d{9}$/.test(fromPayload)) return fromPayload;
  // 数据层：worker 经 worker.phone（057 迁移已加列）；account/desk 暂无 phone 列，依赖 payload.phone。
  if (input.recipientKind === 'worker') {
    const { rows } = await client.query<{ phone: string | null }>(
      `SELECT phone FROM worker WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, input.recipient],
    );
    const p = rows[0]?.phone;
    if (p && /^1[3-9]\d{9}$/.test(p)) return p; // 格式校验，非法号诚实 stub 而非误投网关
  }
  // 仍无法解析或格式不合法 → 上层诚实 stub，绝不拿 worker.id 当手机号投递
  return null;
}

// ---- in_app 渠道：落库即可达 ----
class InAppChannel implements NotificationChannel {
  readonly name = 'in_app' as const;
  async send(client: PoolClient, input: NotifyInput): Promise<DeliveryResult> {
    await persist(client, input, 'in_app', true);
    return { channel: 'in_app', delivered: true };
  }
}

// ---- sms 渠道：真实网关 env-gated；未配置 / 无手机号时 stub 诚实降级 ----
class SmsChannel implements NotificationChannel {
  readonly name = 'sms' as const;
  async send(client: PoolClient, input: NotifyInput): Promise<DeliveryResult> {
    const gateway = process.env.SMS_GATEWAY; // 真实短信网关接入点（URL，需外部资源：网关地址 + 凭证）
    if (!gateway) {
      const note = 'STUB: SMS_GATEWAY not configured, not actually sent';
      await persist(client, input, 'sms', false, note);
      console.info('[notify:sms] stub (NOT actually sent, pending gateway)', {
        type: input.type, recipient: input.recipient, workOrderId: input.workOrderId,
      });
      return { channel: 'sms', delivered: false, note };
    }
    const phone = await resolveSmsTarget(client, input);
    if (!phone) {
      // 无法解析真实手机号（数据层缺失）→ 诚实 stub，绝不拿 worker.id 当手机号投递。
      const note = 'STUB: no resolvable phone for recipient (data layer missing phone), not actually sent';
      await persist(client, input, 'sms', false, note);
      console.info('[notify:sms] stub (no phone resolved)', {
        recipient: input.recipient, workOrderId: input.workOrderId,
      });
      return { channel: 'sms', delivered: false, note };
    }
    try {
      const ok = await deliverToGateway(gateway, input, phone);
      await persist(client, input, 'sms', ok, ok ? undefined : 'SMS_GATEWAY deliver failed');
      return { channel: 'sms', delivered: ok };
    } catch (e) {
      const note = `SMS_GATEWAY error: ${(e as Error).message}`;
      await persist(client, input, 'sms', false, note);
      console.error('[notify:sms] gateway delivery failed, degraded', { note, workOrderId: input.workOrderId });
      return { channel: 'sms', delivered: false, note };
    }
  }
}

// ---- push 渠道：真实网关 env-gated；未配置 / 无手机号时 stub 诚实降级 ----
class PushChannel implements NotificationChannel {
  readonly name = 'push' as const;
  async send(client: PoolClient, input: NotifyInput): Promise<DeliveryResult> {
    const gateway = process.env.PUSH_GATEWAY; // 真实推送网关接入点（URL，需外部资源：网关地址 + 凭证）
    if (!gateway) {
      const note = 'STUB: PUSH_GATEWAY not configured, not actually sent';
      await persist(client, input, 'push', false, note);
      console.info('[notify:push] stub (NOT actually sent, pending gateway)', {
        type: input.type, recipient: input.recipient, workOrderId: input.workOrderId,
      });
      return { channel: 'push', delivered: false, note };
    }
    const phone = await resolveSmsTarget(client, input);
    if (!phone) {
      const note = 'STUB: no resolvable phone for recipient (data layer missing phone), not actually sent';
      await persist(client, input, 'push', false, note);
      console.info('[notify:push] stub (no phone resolved)', {
        recipient: input.recipient, workOrderId: input.workOrderId,
      });
      return { channel: 'push', delivered: false, note };
    }
    try {
      const ok = await deliverToGateway(gateway, input, phone);
      await persist(client, input, 'push', ok, ok ? undefined : 'PUSH_GATEWAY deliver failed');
      return { channel: 'push', delivered: ok };
    } catch (e) {
      const note = `PUSH_GATEWAY error: ${(e as Error).message}`;
      await persist(client, input, 'push', false, note);
      console.error('[notify:push] gateway delivery failed, degraded', { note, workOrderId: input.workOrderId });
      return { channel: 'push', delivered: false, note };
    }
  }
}

// ---- wechat 渠道：微信订阅消息（小程序 openid） ----
// 真实调用条件：MP_APPID/MP_SECRET（或 WX_MP_APPID/WX_MP_SECRET）+ WX_MP_TEMPLATE_ID 已配置，且接收方已绑 openid。
// 未配置 / 未绑 openid / 用户未订阅模板 → 一律诚实 stub（delivered=false）。
class WechatChannel implements NotificationChannel {
  readonly name = 'wechat' as const;
  async send(client: PoolClient, input: NotifyInput): Promise<DeliveryResult> {
    const templateId = process.env.WX_MP_TEMPLATE_ID || '';
    if (!mpConfigured() || !templateId) {
      const note = 'STUB: WX_MP not configured (need MP_APPID/MP_SECRET + WX_MP_TEMPLATE_ID), not actually sent';
      await persist(client, input, 'wechat', false, note);
      console.info('[notify:wechat] stub (NOT actually sent, pending config)', {
        type: input.type, recipient: input.recipient, workOrderId: input.workOrderId,
      });
      return { channel: 'wechat', delivered: false, note };
    }
    // 解析接收方 openid（按 recipientKind 路由，worker 经 account_id 关联）
    const openid = await resolveOpenid(client, input);
    if (!openid) {
      const note = `STUB: recipient has no bound wechat openid (recipientKind=${input.recipientKind ?? 'worker'}), not actually sent`;
      await persist(client, input, 'wechat', false, note);
      console.info('[notify:wechat] stub (no openid bound)', {
        recipient: input.recipient, recipientKind: input.recipientKind, workOrderId: input.workOrderId,
      });
      return { channel: 'wechat', delivered: false, note };
    }
    try {
      const accessToken = await getMpAccessToken();
      if (!accessToken) throw new Error('getMpAccessToken returned null');
      const resp = await callSubscribeSend(accessToken, openid, templateId, input);
      const ok = resp.errcode === 0;
      await persist(
        client, input, 'wechat', ok,
        ok ? undefined : `wechat subscribe send failed (errcode ${resp.errcode}: ${resp.errmsg})`,
      );
      return { channel: 'wechat', delivered: ok };
    } catch (e) {
      const note = `WECHAT error: ${(e as Error).message}`;
      await persist(client, input, 'wechat', false, note);
      console.error('[notify:wechat] send failed, degraded', { note, workOrderId: input.workOrderId });
      return { channel: 'wechat', delivered: false, note };
    }
  }
}

/** 微信订阅消息真实调用：POST cgi-bin/message/subscribe/send。返回微信原始响应（errcode/errmsg）。 */
async function callSubscribeSend(
  accessToken: string,
  openid: string,
  templateId: string,
  input: NotifyInput,
): Promise<WechatSendResult> {
  // 默认按「工单待审核通知」模板拼齐 4 个必填关键词（thing1~thing4，各 20 字上限，必填非空，否则微信回 47003）。
  // 若调用方在 payload.wxData 提供完整模板 data，则优先使用（适配任意模板），但须结构校验，避免脏数据触发 47003。
  let data: Record<string, { value: string }>;
  const override = input.payload?.wxData;
  if (override && typeof override === 'object' && !Array.isArray(override)) {
    const ov = override as Record<string, unknown>;
    const valid = Object.values(ov).every(
      (v) => !!v && typeof v === 'object' && typeof (v as { value?: unknown }).value === 'string' && (v as { value: string }).value.length > 0,
    );
    data = valid ? (ov as Record<string, { value: string }>) : buildDefaultData(input);
  } else {
    data = buildDefaultData(input);
  }
  const bodyObj: Record<string, unknown> = { touser: openid, template_id: templateId, data };
  const page = input.payload?.page as string | undefined;
  if (page) bodyObj.page = page; // 可选：点击跳转的小程序页面
  let res: { errcode?: number; errmsg?: string } | null = null;
  try {
    res = await httpsPostJson(
      `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(accessToken)}`,
      bodyObj,
    );
  } catch (e) {
    return { errcode: -1, errmsg: `request failed: ${(e as Error).message}` };
  }
  const errcode = typeof res?.errcode === 'number' ? res.errcode : -1;
  const errmsg = res?.errmsg || 'no response';
  // 43101 = 用户未授权一次性订阅：预期常态（每次授权仅可发 1 条，耗尽后须重新授权），降级 info 避免日志噪音；
  // 其余非 0 码（47003 模板字段错 / 40003 openid 非法 / 40014 appid 错等）才是真异常，保留 warn。
  if (errcode === 0) {
    return { errcode: 0, errmsg: 'ok' };
  }
  if (errcode === 43101) {
    console.info('[notify:wechat] subscribe pending (43101): recipient must re-authorize one-time subscription', {
      openid, workOrderId: input.workOrderId,
    });
  } else {
    console.warn('[notify:wechat] subscribe send resp:', errcode, errmsg, {
      openid, workOrderId: input.workOrderId,
    });
  }
  return { errcode, errmsg };
}

/** 微信订阅消息发送原始响应。 */
export interface WechatSendResult {
  errcode: number;
  errmsg: string;
}

/** 微信订阅消息自检结果：供小程序「微信通知自检」单点按钮使用。 */
export interface WechatSelfTestResult {
  configured: boolean; // 后端微信配置是否就绪
  openid: string | null; // 接收方当前绑定的 openid（null=未绑定）
  errcode: number | null; // 微信原始返回码（null=未实际发送，如未配置/未绑 openid）
  errmsg: string | null;
}

/**
 * 微信订阅消息自检：不落库，直接对当前接收方发起一次真实订阅消息发送并返回微信原始 errcode。
 * 用途：工人工作台「微信通知自检」单点按钮——用户点一次授权后立即真发，屏上直接看 errcode:0（成功）或 43101（需重新授权），
 * 无需再 relay 给后端手动重跑，实现通知链路自助验证闭环。
 */
export async function wechatSelfTest(client: PoolClient, input: NotifyInput): Promise<WechatSelfTestResult> {
  const templateId = process.env.WX_MP_TEMPLATE_ID || '';
  if (!mpConfigured() || !templateId) {
    return { configured: false, openid: null, errcode: null, errmsg: 'WX_MP 未配置（需 MP_APPID/MP_SECRET + WX_MP_TEMPLATE_ID）' };
  }
  const openid = await resolveOpenid(client, input);
  if (!openid) {
    return { configured: true, openid: null, errcode: null, errmsg: '接收方未绑定微信 openid（请先在工作台「去绑定」）' };
  }
  const accessToken = await getMpAccessToken();
  if (!accessToken) {
    return { configured: true, openid, errcode: null, errmsg: '获取微信 access_token 失败' };
  }
  const resp = await callSubscribeSend(accessToken, openid, templateId, input);
  return { configured: true, openid, errcode: resp.errcode, errmsg: resp.errmsg };
}

/** 默认模板 data 拼装（thing1~thing4，各 20 字上限）。 */
function buildDefaultData(input: NotifyInput): Record<string, { value: string }> {
  const p = (input.payload ?? {}) as Record<string, unknown>;
  const title = String(input.title || input.body || '工单通知').slice(0, 20);
  const type = String(input.type || input.body || input.title || '请查看详情').slice(0, 20);
  const assignee = String(p.assignee || p.workerName || '系统').slice(0, 20);
  const status = String(p.status || '待处理').slice(0, 20);
  return {
    thing1: { value: title },
    thing2: { value: type },
    thing3: { value: assignee },
    thing4: { value: status },
  };
}

/**
 * 真实短信/推送网关投递骨架：SMS_GATEWAY / PUSH_GATEWAY 配置时进入，POST 网关 URL 并据响应返回是否送达。
 * @param to 已解析的真实手机号（resolveSmsTarget 产出）；未解析时上层已诚实 stub，不会进入本函数。
 * 不同网关响应格式不同，正式接入按网关文档在此分支细化；当前通用判定：HTTP 200 且 (无 errcode / errcode===0 / success===true)。
 * 任何失败一律返回 false，由上层 catch 落入 delivered=false，绝不谎报。
 */
async function deliverToGateway(gateway: string, input: NotifyInput, to: string): Promise<boolean> {
  // R30-F1：正文出境第三方网关前必须脱敏——body 可能由工单 description 派生（含报修人手机号等 PII），
  // maskPhone 与 LLM/嵌入管道同一防线（llm.ts）；并做白名单字段 + 长度截断，最小化出境数据面。
  const safeTitle = maskPhone(String(input.title || '工单通知')).slice(0, 100);
  const safeBody = maskPhone(String(input.body ?? '')).slice(0, 500);
  const res = await httpsPostJson(gateway, {
    to,
    title: safeTitle,
    body: safeBody,
    channel: input.channel,
    workOrderId: input.workOrderId,
  });
  // 宽松比较：网关可能返回字符串型 "0"/"true"，严格 === 会误判失败 → 谎称 delivered=false。
  const eq0 = (v: unknown) => v === undefined || v === 0 || v === '0';
  const eqTrue = (v: unknown) => v === undefined || v === true || v === 'true';
  const ok = res && eq0(res.errcode) && eq0(res.code) && eqTrue(res.success);
  return Boolean(ok);
}

const CHANNELS: Record<NotifyChannel, NotificationChannel> = {
  in_app: new InAppChannel(),
  sms: new SmsChannel(),
  push: new PushChannel(),
  wechat: new WechatChannel(),
};

/** 通知服务分发器：默认双通道 fan-out（站内信 in_app 必达 + 微信订阅消息 wechat 真实触达）；
 * 显式指定 input.channel 时仅走该通道（向后兼容既有单通道调用）。
 * 返回语义：fan-out 时以主通道（in_app，必达）结果作为整体成败，避免被 wechat 常态 43101 覆盖而误报"通知失败"；
 * 其余通道结果已各自落库 + 日志，不在此丢失。 */
export async function dispatchNotification(client: PoolClient, input: NotifyInput): Promise<DeliveryResult> {
  const channels: NotifyChannel[] = input.channel ? [input.channel] : ['in_app', 'wechat'];
  const results: DeliveryResult[] = [];
  for (const ch of channels) {
    const adapter = CHANNELS[ch];
    if (!adapter) { console.warn('[notify] unknown channel skipped:', ch); continue; }
    results.push(await adapter.send(client, input));
  }
  if (results.length === 0) {
    return { channel: 'in_app', delivered: false, note: 'no channel dispatched' };
  }
  // 主通道优先（in_app 必达）；无 in_app 时取首个（单通道场景）。
  const primary = results.find((r) => r.channel === 'in_app') ?? results[0];
  const pending = results.filter((r) => r !== primary && !r.delivered).map((r) => r.channel);
  if (primary.delivered && pending.length) {
    return { ...primary, note: `${primary.note ?? 'primary delivered'}; side-channel pending: ${pending.join(',')}` };
  }
  return primary;
}

/**
 * 兼容导出：保持既有调用方（routes/workOrder.ts）签名不变。
 * 落库一条通知；sms/push 经网关真实投递（若配置且能解析手机号），wechat 经订阅消息真实投递（若配置且已绑 openid），
 * 未配置分支 delivered 恒 false，诚实未发送。
 */
export async function insertNotification(client: PoolClient, input: NotifyInput): Promise<void> {
  await dispatchNotification(client, input);
}
