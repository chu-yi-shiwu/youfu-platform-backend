# 微信订阅消息（P0-5）配置核验 · 2026-11-20

## 1. 结论

之前记录的「模板 ID 无效 40037」已不成立。当前模板 ID 经小程序官方接口核验**真实存在**，字段也与环境配置一致。

剩余失败只剩两类外部用户条件：

1. 接收人未绑定微信 openid；
2. 接收人未授权订阅消息（43101）。

这两类无法由后端代码单独修复，必须由真实用户在微信小程序内登录并授权。

## 2. 核验结果

核验脚本：`scripts/wechat-template-verify.mjs`

调用接口：`GET /wxaapi/newtmpl/gettemplate`

| 环境 | access_token | 模板 | 字段 |
| --- | --- | --- | --- |
| pilot | PASS | PASS（工单处理通知） | PASS（thing28 / thing16 / thing33 / thing6） |
| 主站 | PASS | PASS（工单处理通知） | PASS（thing28 / thing16 / thing33 / thing6） |

当前配置：

- `MP_APPID`：`wxb***19`
- `WX_MP_TEMPLATE_ID`：`jfu***GQ`
- `WX_MP_TEMPLATE_KEYS`：`thing28,thing16,thing33,thing6`

模板内容字段与后端 `buildDefaultData` 拼装字段一致。

## 3. 未成功通知分类

`scripts/wechat-notify-diagnose.mjs` 当前统计：

| 原因 | 数量 | 性质 |
| --- | --- | --- |
| `recipient has no bound wechat openid`（worker） | 4 | 用户尚未在小程序登录/绑定 |
| `recipient has no bound wechat openid`（account） | 1 | 账号尚未绑定 openid |
| `errcode 43101: user refuse to accept the msg` | 2 | 用户未授权一次性订阅 |
| 模板无效 40037 | 0 | 已排除 |

## 4. 关闭条件

1. 真实员工在微信小程序登录，后端写入 `worker.openid` / `account_user.openid`；
2. 员工在关键动作前点击订阅授权（`wx.requestSubscribeMessage`，模板 ID 与后端一致）；
3. 重新触发通知并跑 `npm run diag:wechat`，确认 `delivered=true`。

## 5. 新增诊断命令

```bash
# 模板是否存在、字段是否匹配
ENV_FILE=.env npm run diag:wechat-template

# 失败通知分类
ENV_FILE=.env npm run diag:wechat
```

两个命令只读，不发送消息，不输出 secret / access_token。
