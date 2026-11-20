# 志愿者活动模块功能审计与整改（2026-11-14）

## 一、最终结果

```text
P1：活动编辑 / 活动删除 / 取消报名            PASS
P2：活动详情 / 报名名单导出 / 签到时间窗      PASS
P3：过期活动 effective_status                 PASS
```

## 二、P1 补齐

| 功能 | 结果 |
| --- | --- |
| 活动编辑 `PUT /activities/:id` | PASS：标题/批次/地点/起止/名额/报名截止/说明 |
| 活动删除 `DELETE /activities/:id` | PASS：无报名 200；有报名 409 |
| 管理员取消报名 `DELETE /records/:id` | PASS：释放名额 |
| 志愿者本人取消报名 | PASS：仅 registered；非本人 403 |
| PC 编辑/删除/取消报名入口 | PASS |
| 小程序取消报名 | PASS |

## 三、P2 补齐

| 功能 | 结果 |
| --- | --- |
| `GET /activities/:id` | PASS：含 signup_count + effective_status |
| 报名名单导出 `GET /activities/:id/export` | PASS：姓名/状态/签到/签退/时长/积分/补签 |
| 签到时间窗 | PASS：活动开始前 2 小时开放；开始前 3 小时签到 409 |
| PC 详情弹窗导出按钮 | PASS |
| 小程序活动详情页 | PASS：`pages/worker/volunteer-detail` |
| 小程序详情页报名/签到/签退/取消报名 | PASS |

## 四、P3 补齐

```text
活动列表/详情新增 effective_status：
- open + end_at 已过 → ended
- 其余保持原 status
```

实测：

```text
过期活动 effective_status=ended
```

## 五、闭环实测

```text
创建活动                          PASS
活动详情 GET                      PASS
编辑活动 PUT                      PASS
报名 / 重复 409 / 满员 409        PASS
我的报名记录                      PASS
管理员取消报名                    PASS
开始前 3 小时签到 → 409           PASS
开始前 1 小时签到 → 200           PASS
签到 / 签退 / 核销                PASS
结束 / 重开                       PASS
删除有报名活动 → 409              PASS
删除无报名活动 → 200              PASS
报名名单导出                      PASS
过期活动 effective_status=ended   PASS
```

## 六、验证

```text
后端全量       204 文件 / 2461 用例 PASS
前端单元       30 文件 / 242 用例 PASS
PC Playwright  10/10 PASS
PC 部署        assets/index-BVO3oNyh.js
后端           youfu-pilot active，/health/ready 200
数据           4 工单 / 14 通知 / 3 账号 / 16 师傅；临时租户 0
小程序         v5.9.22
```

## 七、可选增强（本轮全部完成）

| 增强 | 结果 |
| --- | --- |
| 活动变更通知已报名人员 | PASS：站内信；通知孤儿过滤新增 volunteer_activity 分支 |
| 签到二维码/活动码 | PASS：活动生成 checkin_code；PC 详情显示二维码；小程序扫码签到 |
| 积分规则可配置 | PASS：`volunteer_points_per_hour`；2 分/小时实测 2 小时得 4 分 |
| 志愿者黑名单/资格 | PASS：报名命中黑名单 403 BLACKLISTED；PC 可增删 |
| 取消报名截止时间 | PASS：过期取消 409 CANCEL_CLOSED |

实测补充：

```text
黑名单报名 -> 403 BLACKLISTED
扫码签到 -> 200（code=VE9633F7A）
积分规则 2 分/小时 + 2 小时 -> points=4
取消报名截止已过 -> 409 CANCEL_CLOSED
活动变更通知 -> 站内信可见（DB+列表一致）
```

## 八、验证（最终）

```text
后端全量       204 文件 / 2462 用例 PASS
前端单元       30 文件 / 242 用例 PASS
PC Playwright  10/10 PASS
PC 部署        assets/index-es0Wc9vY.js
后端           youfu-pilot active，/health/ready 200
数据           4 工单 / 14 通知 / 3 账号 / 16 师傅；临时租户 0
小程序         v5.9.23
```

数据库迁移：

```text
116_volunteer_enhancements.sql
- volunteer_activity.checkin_code
- volunteer_activity.cancel_deadline
- volunteer_blacklist 表 + RLS
```

## 九、可选增强说明

- 活动变更通知只发站内信，不发微信，避免消耗一次性订阅；
- 签到码按租户唯一，历史活动首次打开详情时自动补码；
- 积分规则按「服务分钟 / 60 × 每小时积分」向下取整；
- 黑名单按姓名匹配（与报名记录 user_name 同口径）；
- 取消报名截止为空时不限制（存量活动兼容）。
