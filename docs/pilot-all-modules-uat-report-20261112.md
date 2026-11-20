# 全功能模块 UAT 集成报告（2026-11-12）

## 1. 环境

```text
隔离租户：uat-all-<run>
数据库：youfu_pilot
API：http://127.0.0.1:4101/api/v1
租户内账号：admin / operator / uat_worker
测试结束：按 tenant_id 清理全部数据
```

真实微信/真机链路仍使用 pilot 的 `17773639019`。

## 2. 模块闭环结果

| 模块 | 闭环内容 | 结果 |
| --- | --- | --- |
| 工单 + 耗材 + 结算 | 建单 → 派单 → 到场 → 开始 → 领料 → 提交复核 → 复核通过 → 完成 → 结算草稿 → 确认 | PASS |
| 巡检执行 | 点位 → 检查项 → 任务 → 签到 → 完成 → 异常 → 转工单 | PASS |
| 巡检计划 | 创建计划 → 手动生成任务 | PASS |
| 巡更执行 | 点位 → 任务 → 签到完成 → 漏检 | PASS |
| 资产 | 建档 → 故障转工单 → 维保记录 | PASS |
| 设备 | 类型 → 厂商 → 设备档案 → 维保记录 | PASS |
| 应急预案 | 新建 → 更新 → 列表 → 删除 | PASS |
| 志愿者 | 活动 → 管理员报名 → 师傅报名 → 签到 → 签退 → 核销 → 统计 | PASS |
| 优化 + 工作流 | 读取流程 → 自动优化开关 → 生成建议 → 列表 → 应用工作流 | PASS（全局 KILL_SWITCH 下按 409 记录） |
| 派单规则/术语/系统配置 | 新建 → 列表 → 删除 → 配置读取 | PASS |
| 账号/角色/体验用户 | 权限目录 → 角色列表 → 新建体验用户 → 列表 → 删除 | PASS |
| 需求反馈 | 提交 → 列表 → 回复 → 统计 | PASS |
| 统计/工作台/过程挖掘 | 统计、工作台、过程挖掘、自动优化状态 | PASS |
| 公开报修/我的报修 | 照片上传 → 公开报修 → 我的报修 token 查询 | PASS |
| 小程序陪检登记 | 师傅创建 escort 工单 → 任务列表 | PASS |
| 小程序运送单 | 建单 → 列表 → 认领/自动派单 → 接单 → 完成 | PASS |
| 小程序师傅任务 | 任务列表、抢单大厅、通知、个人中心 | PASS |

最终：

```text
[uat] PASS modules=16 failed=0
[uat] cleaned uat-all-...
```

## 3. PC 模块页面

pilot 菜单已开放主站除「网管监控」「运送管理」外的全部模块。

验证：

```text
PC Playwright 9 用例 PASS
- 14 个模块菜单存在
- 网管监控/运送管理菜单不存在
- 直接访问 /monitor、/transport 重定向工作台
- 13 个模块页面逐个打开，无白屏/500
```

## 4. 小程序覆盖

已通过 API 验证：

```text
公开报修 / 我的报修 / 照片上传
师傅任务列表 / 抢单大厅 / 通知 / 个人中心
巡检任务签到、完成、异常
巡更任务签到、漏检
陪检登记
运送单认领/接单/完成
志愿者报名
```

真机 UI 仍需按 `docs/pilot-uat-checklist-20261111.md` 在 iPad / HarmonyOS 微信走查。

## 5. 回归基线

```text
后端：203 文件 / 2449 用例 PASS
前端：30 文件 / 238 用例 PASS
PC Playwright：9 用例 PASS
releaseGate：5/5
```

## 6. 清理

```text
UAT 租户：0
UAT 工单：0
UAT 账号：0
UAT 上传目录：已删除
孤儿事件/通知：0
```

## 7. 未完成 / 外部条件

1. **真实微信 43101**：需要 `17773639019` 在 pilot 小程序工作台点「开启通知」。
2. **真机 UI**：iPad / HarmonyOS 需现场按 UAT 清单走查。
3. **AI embedding**：本轮按范围排除；生产如开启，需独立队列/连接池，避免建单尾延迟和 500。

## 8. 运行

```bash
cd /opt/youfu/pilot/backend
PGDATABASE=youfu_pilot ENV_FILE=.env \
  /opt/node16/bin/node scripts/pilot-uat-all-modules-e2e.mjs
```

脚本自动创建/清理 `uat-all-<run>` 租户，不触碰真实 `zixing-hospital` 业务数据。

## 9. 现场回归补丁（2026-11-12 00:20）

真机截图暴露两个问题，已修复并上线：

1. **工作台「能耗任务加载失败」**
   - 根因：`GET /api/v1/energy/tasks` 路由挂在 `authMiddleware` 之前，没有 ALS 租户上下文，
     但列表查询 `withTenantClient(tenantId, ...)` 未传 `{ system: true }`，
     真实连接池抛 `MISSING_AUTH_CONTEXT` → 500（测试 mock 不校验 opts，故此前未暴露）。
   - 修复：`src/routes/energyCollection.ts` 统一走 `withEnergyTenant()`，显式 system 作用域；
     webhook / token-exchange / 列表 / 详情 / def 全部收口。
   - 回归：新增 `E07b` 断言 energy 路由所有 DB 访问必须 `system: true`；18 用例 PASS。
   - 线上验证：真实账号请求 `/energy/tasks` 由 500 变为 `200 {"items":[]}`。

2. **通知页缺少「开启通知」**
   - 工作台点击后提示“可在「通知」页手动开启”，但通知页只有「全部已读」。
   - 修复：通知页头部新增常驻「微信通知 / 开启通知」卡片，复用 `utils/subscribe` 一次性授权，
     授权成功后直接调用 `/notify/selftest` 并屏上显示微信 errcode（0 / 43101 / 其他）。
   - 版本：小程序 `v5.9.17`（`app.js` 单一版本源）。

