# 正式上线就绪清单（2026-11-21）

## 1. 当前已完成

| 项 | 状态 |
| --- | --- |
| 后端发布 | r11.1，当前 `/opt/youfu/releases/20261121T132002-0a22c9f75682` |
| 后端 CI | run `44908319483`，success |
| 主站前端 | 已部署，index asset `assets/index-CYAhwecN.js` |
| PC pilot 前端 | 已部署，index asset `assets/index-Dx2eg-Dm.js` |
| H5 | 已部署，index asset `assets/index-B5gsG1LV.js` |
| pilot 小程序 | 5.9.35 开发版；manifest digest `da6a309a0572...`；44 / 44 |
| 主站小程序 | 5.9.36 开发版；manifest digest `2b86ca7366b8...`；42 / 42 |
| live 边界烟测 | uat 租户 PASS，测后清理；真实租户只读复核 PASS |
| 工作台统计/重复 worker | 主站 + pilot PASS |

## 2. 上线阻塞项

### 2.1 正式生产租户未确定

- 主库 `youfu` 当前只有验证/演示租户：`t-verification`、`t-phasea`、probe 租户；没有正式医院生产租户。
- Pilot 库 `youfu_pilot` 有真实医院 `zixing-hospital`（资兴市人民医院）。
- 需要产品/运维决策：
  1. 把 `zixing-hospital` 数据迁移到主库并作为正式生产租户；或
  2. 明确 pilot 环境就是正式生产环境，完成命名、容量、备份、监控、权限的正式化。
- 未决策前，“正式应用”没有明确的生产数据落点。

### 2.2 主站小程序仍是旧生产包

- 线上生产包仍为 5.9.10，不包含本次 `/admin/work-orders` 契约。
- 主站 5.9.36 已上传开发版，但尚未设体验版、未提交审核、未发布。
- 若正式环境已有 5.9.10 用户，后端升级后旧包管理端会 403；必须先发新版或确认无旧版在线用户。
- pilot 与主站共用 appid `wxb99197ac59cfa519`，同一 app 的体验版/正式版互斥；需要确定最终保留哪个包作为体验版/正式版。

### 2.3 真实员工绑定与订阅不足

绑定审计（`account_user.wx_openid`）：

| 租户 | 账号数 | 已绑定微信 | 师傅档案 |
| --- | --- | --- | --- |
| `t-verification` | 24 | 2 | 12 |
| `zixing-hospital` | 3 | 1 | 16 |
| `t-phasea` | 6 | 0 | 4 |

Pilot 关键角色绑定：admin 0/1、operator 0/1、worker 1/1。管理员/运营未绑定，管理侧通知无法真实送达。

通知投递审计（`notification`）：

| 租户 | 渠道 | 成功 | 失败 | 最近失败 |
| --- | --- | --- | --- | --- |
| `t-verification` | wechat | 0 | 117 | 2026-10-29 |
| `zixing-hospital` | wechat | 1 | 10 | 2026-11-21 12:39 |

需要完成：关键角色绑定、订阅模板授权、一次真实发送回执验证。

### 2.4 发布流程闭环

- 前端 CI 在线状态无法匿名确认（私有仓库 API 404）；本地 36 文件 / 269 用例、typecheck、lint、build 均通过。
- 本次后端部署使用同 commit 本地构建；CI artifact 已生成并记录 digest，但未直接下载 artifact 部署。若制度要求“artifact 即部署物”，需补下载/重放。
- 主站小程序 release manifest 已补；pilot/main 上传记录、二维码、digest 需归档到 release 目录。
- 正式上线前做一次回滚演练：切 `releases/current`、恢复备份 dist、重启、健康检查。

## 3. 上线顺序建议

1. 决策正式生产租户与环境（主库迁移或 pilot 正式化）。
2. 完成关键角色微信绑定/订阅，验证真实通知回执。
3. 主站 5.9.36 设体验版，完成最终真机验收；确认 pilot/主站包保留策略。
4. 主站 5.9.36 提交微信审核并发布。
5. 前端 CI/artifact/回滚确认。
6. 生产烟测：admin 200、worker 200、模块关闭 403、通知真实回执。
7. 灰度/正式放量。

## 4. 可上线后跟进

- 通知模板文案优化、更多事件订阅。
- 历史 probe/demo 租户清理。
- 性能压测与容量评估。
- 统计报表细化。
