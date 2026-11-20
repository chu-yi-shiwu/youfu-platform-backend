# 微信订阅消息接入检查（2026-11-09）

代码已具备真实发送能力（`src/services/notify.ts` → WechatChannel），无需再改发送逻辑；
试点前只需确认配置、模板字段和用户授权。

## 1. 后端配置

`/opt/youfu/pilot/backend/.env`：

```env
MP_APPID=wx...
MP_APPSECRET=...
WX_MP_TEMPLATE_ID=...
```

缺失任一项 → 发送结果 `delivered=false`，notification.payload._note 会明确写
`STUB: WX_MP not configured...`，不会谎报已送达。

## 2. 模板字段

默认按 `thing1` ~ `thing4` 四个关键词发送（各 ≤20 字），内容由 `buildDefaultData`
从通知标题/正文/工单号生成。若医院模板字段不同，需要在通知 payload.wxData 中按模板
提供完整 data，例如：

```json
{
  "wxData": {
    "thing1": { "value": "住院部 3 楼水管漏水" },
    "thing2": { "value": "维修组" },
    "thing3": { "value": "待接单" },
    "thing4": { "value": "2026-11-09 10:30" }
  }
}
```

## 3. 用户授权

微信是一次性订阅：

- 小程序工作台「开启通知」按钮会调用 `wx.requestSubscribeMessage`；
- 用户允许后立即调用 `POST /api/v1/open/notify/selftest` 真发一次；
- 返回 `errcode:0` 表示链路通；
- `43101` 表示需要重新授权（一次授权只够发一条）。

## 4. 自检

- 小程序工作台：开启通知 → 自检结果直接弹窗显示 errcode。
- 后端：`POST /api/v1/open/notify/selftest`（登录态，worker 本人）。
- 通知列表：`GET /api/v1/open/notifications`，`channel='wechat'` 记录里
  `delivered` 与 `payload._note` 是真实结果。

## 5. 常见失败

| errcode | 含义 | 处理 |
| --- | --- | --- |
| 0 | 成功 | 无需处理 |
| 43101 | 用户未授权/授权已用完 | 小程序重新点「开启通知」 |
| 47003 | 模板字段不匹配/空值 | 核对模板关键词与 wxData |
| 40003 | openid 非法 | 检查微信绑定 |
| 40014 | access_token 无效 | 检查 MP_APPID/MP_APPSECRET |

## 6. 当前 pilot

`.env` 已有 `MP_APPID` / `MP_APPSECRET` / `WX_MP_TEMPLATE_ID`。
真正上线前需在微信公众平台确认模板字段与默认 `thing1~4` 一致，或用 `wxData` 适配。

### 2026-11-10 实测结论

- `MP_APPID` / `MP_APPSECRET` 有效，`getMpAccessToken` 成功；
- 原来 `.env` 里的 `WX_MP_TEMPLATE_ID` 在小程序下无效（gettemplate 返回 0 条）；
- 已通过微信 API 添加公共模板「工单处理通知」：
  - `WX_MP_TEMPLATE_ID=jfu0s--jnT1KrwBigZ5e8mdGRx-MceVL_G-XEUKfqGQ`
  - 关键词：工单标题 / 工单类型 / 通知事项 / 备注
  - 实际 data key：`thing28, thing16, thing33, thing6`
- 后端新增 `WX_MP_TEMPLATE_KEYS` 映射（默认仍是 `thing1~thing4`），
  main / pilot 均已配置为 `thing28,thing16,thing33,thing6`。
- 用假 openid 调用自检：返回 `errcode:40003 invalid openid`，
  说明 **template_id 和 data key 已被微信接受**；只差真实 openid 绑定。
- 真实账号 `17773639019` 当前 `wx_openid` 为空，需要在小程序「我的 → 绑定微信」完成绑定。

### 2026-11-12 实测结论：模板 ID 双源漂移

现场点击「开启通知」多次均提示“已取消授权”，微信根本没有弹授权框。根因：

```text
小程序 app.js WX_TEMPLATE_ID = XKVKaKeVMxHDFJJPbBVd3nI9uGP3viVn2s6Tdsd_uww（旧模板）
后端 .env WX_MP_TEMPLATE_ID   = jfu0s--jnT1KrwBigZ5e8mdGRx-MceVL_G-XEUKfqGQ（有效模板）
```

`wx.requestSubscribeMessage` 请求的是旧模板（已不在小程序下），微信直接拒绝；
后端发送的又是 `jfu0s...`，用户从未对该模板授权 → `43101`。

修复：

- `app.js` 的 `WX_TEMPLATE_ID` 已改为与后端完全一致的 `jfu0s--jnT1KrwBigZ5e8mdGRx-MceVL_G-XEUKfqGQ`；
- `utils/subscribe.js` 返回 `state`（accept/reject/ban/filter）与 `errCode/errMsg`；
- 新增 `describeResult()`，授权失败时区分模板配置错误（20001/20002）、用户拒绝、模板禁用等，
  并给出「去设置」入口，不再一律提示“已取消授权”；
- 小程序版本 `v5.9.18`。

**后续发版注意**：模板 ID 有两处配置（小程序 `app.js`、后端 `.env`），必须同步修改；
修改后先在小程序点「开启通知」，确认微信弹出授权框。

### 2026-11-12 真实到达验证（PASS）

修复后真实账号 `17773639019 / HQ016` 重新授权，跑真实派单闭环：

```text
建单 → 自动派 HQ012 → 改派 HQ016 → 到场 → 处理 → 提交复核
→ 驳回 → 再提交 → 复核通过 → 完成 → 关闭 → 评价 5

[real] notifications=[
  {"channel":"in_app","recipient_kind":"worker","delivered":true},
  {"channel":"wechat","recipient_kind":"worker","delivered":false,
   "note":"STUB: recipient has no bound wechat openid"}   ← HQ012 未绑定微信，预期
  {"channel":"in_app","recipient_kind":"worker","delivered":true},
  {"channel":"wechat","recipient_kind":"worker","delivered":true}  ← HQ016 真实到达
]
[real] PASS
```

同时修复了两个后端链路问题：

- `工单已改派给您` / `您已抢到工单` / `责任部门变更` 调用 `insertNotification`
  时漏传 `recipientKind: 'worker'`，openid 解析走账号分支返回 null → 永远 STUB；
- `resolveOpenid` / 手机号解析现在默认按 worker 处理，新增回归用例；
- 小程序授权后不再自动发自检消息，避免消耗唯一一次订阅额度。


