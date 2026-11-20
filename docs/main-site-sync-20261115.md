# 主站平台同步测试与修复报告（2026-11-15）

> 原则：不引用 pilot 的历史测试结论作为主站结论；主站以“独立差异审计 → 同步 → 主站实测”重新建立基线。
> 环境：主站 `https://youfu.banerz.cn/`（服务 4001 / 库 `youfu`），pilot `/pilot/`（服务 4101 / 库 `youfu_pilot`）。

## 1. 结论

主站此前停留在 11-11 的后端、11-09 的前端、数据库迁移 115；11-13 以后在 pilot 完成的全部修复与迁移均未同步。本次已完成同步，并在主站独立实测中发现并修复 3 个新问题：

| 项目 | 结果 |
| --- | --- |
| 主站深度探针 | 142/142 PASS，0 个 5xx |
| 主站通知/账号/幂等探针 | 43/43 PASS，0 个 5xx |
| 主站平台+时间探针 | 70/70 PASS，0 个 5xx |
| 主站全模块闭环 | 16/16 PASS |
| 主站 PC 路由冒烟 | 27/27 无白屏、无控制台错误 |
| 后端全量 | 213 文件 / 2526 用例 PASS |
| 前端全量 | 35 文件 / 265 用例 PASS |
| 主站数据 | 65 工单 / 32 账号 / 16 师傅；UAT 与平台测试痕迹 0 |
| 服务 | youfu-backend / youfu-pilot 均 active，/health/ready ready |

## 2. 同步前差异审计（主站 vs 当前代码）

| 维度 | 主站同步前 | 当前基线（pilot/仓库） |
| --- | --- | --- |
| 后端 dist | 2026-11-11 构建，缺 `requestShape` / `base64` 等 | 2026-11-15 构建，含 11-13 至 11-15 全部修复 |
| 数据库迁移 | 至 115；缺 116–120（106/107/109 亦未登记） | 117/118/119/120 已应用；116 已应用 |
| 前端 | index-DhE795vN.js（11-09） | 重新构建 index-DcqZ17Yo.js（主站 base=/） |
| 巡检调度器 | 每分钟 MISSING_AUTH_CONTEXT | 显式 system 作用域 |
| 微信补投递 | 响应后 MISSING_AUTH_CONTEXT | 显式 system 作用域 |
| 开放应用 | `app_secret` 列已不存在，旧迁移 119 不兼容 | 119 改为判列存在 |
| 主站前端 assets | 混入 pilot 构建产物，但 index 仍指旧包 | 统一主站构建，index 与 assets 一致 |

## 3. 自 11-13 起调整的问题（同步清单）

### 3.1 11-13 功能与稳定性

- D-01 抢单失败者 404 → 409；
- D-02 微信通知漏传 `recipientKind` → 补 worker 解析；
- D-03 energy/tasks 缺 system 作用域 → 统一显式 system；
- D-04 小程序/后端订阅模板 ID 双源 → 对齐（部署门禁仍待补）；
- D-05 授权后自检消耗唯一订阅额度 → 取消自检；
- D-R3-01 通知单条已读 uuid/text[] 不匹配 → 入参校验 + `::uuid[]`；
- 手动 UAT 8 条：巡检计划名称、处理详情中文化、审计轨迹中文化、志愿者自助签到/签退、PC 志愿者详情/签到、资产/设备日期、表单字段标题。

### 3.2 11-14 业务与体验

- 全模块扫描 8 类：库存材料 UUID、反馈渠道英文、运送/巡检/通用流程动作英文、巡更状态英文、负责人下拉、表单标题；
- 日期根因：动态列重建丢 `render` → 保留整列定义；
- CSV：中文表头兼容旧英文 key、状态/日期/布尔/类型人话化、2000 行上限、逐行错误；
- 志愿者：签到码、黑名单、取消截止、积分、宽限、并发名额；
- 方向 A：结算作废、耗材退库、资产维修回写、设备保养界面、预警转工单、反馈关闭、基础数据停用（迁移 117）；
- 方向 B：巡更扫码签到、巡检定位策略、巡检逾期（迁移 118）；
- 方向 C：通知深链/单条已读、催办、低库存预警、统计口径；
- 小程序 v5.9.27（IA 收敛、底部操作条、待办 Tab、可用性基线）。

### 3.3 11-14 晚全量回归与深度探针

- D1 巡更并发签到（行锁）；
- D4 PC 巡检详情完成后白屏（重新拉取详情 + available 兜底 + ErrorBoundary 路由诊断）；
- D5 巡检完成并发、D6 志愿签到并发、D7 运送流转并发（行锁 + 状态条件）；
- D8 非法日期 500、D9 NUL 500、D10 重复 query 500（边界统一 400）；
- D11 非法 Base64、D13 nosniff；
- D12 测试脚本假清理。

### 3.4 11-14 晚～11-15 平台与时间

- D14 开放应用创建失败（迁移 119）；
- D15 LLM 授权读取永远 false（迁移 120 SECURITY DEFINER）；
- D16 平台新开租户无默认部门（开通补默认部门）；
- D17 模板应用到不存在租户的误导性 409（改 404）。

## 4. 主站独立实测发现的新问题（D18–D20）

### D18（P1，已修复）巡检计划调度器每分钟 500

- 现象：主站日志每分钟 `AppError: withTenantClient 缺少 auth context`，到期巡检计划永不生成。
- 根因：`runDuePlansForTenant` 直接 `withTenantClient(tenantId, fn)`；调度器没有请求级 ALS 上下文。
- 修复：显式 `{ system: true }`，与 SLA 调度器同口径。
- 负控制：`src/test/inspectionSchedulerScope.test.ts`。

### D19（P1，已修复）微信补投递在响应后 500

- 现象：主站 `public/repair-report` 成功后 `[notify:wechat] deferred delivery failed ... MISSING_AUTH_CONTEXT`。
- 根因：`flushWechatDeliveries` 在 `res.on('finish')` 后执行，默认 executor 未传 system。
- 修复：默认 executor 传 `{ system: true }`。
- 负控制：`src/test/wechatDeferredScope.test.ts`。

### D20（P3，已修复）119 迁移在 app_secret 已删除环境不可执行

- 现象：主站已人工执行过 108（`app_secret` 列不存在），`ALTER COLUMN app_secret DROP NOT NULL` 报 undefined_column，迁移中断。
- 根因：迁移未判断列是否存在。
- 修复：`DO $$ ... IF EXISTS (information_schema.columns) ... ELSE RAISE NOTICE ... $$`。
- 负控制：`platformWrites.test.ts` 增加“列已删除环境跳过”断言。

## 5. 同步与部署记录

```text
备份：/opt/youfu/backup/main-pre-sync-20261115.dump（7.5MB）
      /opt/youfu/backup/frontend-dist-pre-sync-20261115.tgz
      /opt/youfu/backend/dist.bak-20261115-pre-sync
迁移：106 / 107 / 109 / 116 / 117 / 118 / 119 / 120（已登记 _migrations）
后端：dist 同步至主站，youfu-backend.service 重启 active
前端：npm run build（base=/）→ index-DcqZ17Yo.js，部署至 /opt/youfu/frontend-dist
脚本：主站 scripts/ 同步 uat-deep-probe / uat-deep-probe2 / uat-platform-time-probe / all-modules
```

## 6. 主站测试证据

```text
[deep]      total=142 pass=142 5xx=0
[probe2]    total=43  pass=43  5xx=0
[platform]  total=70  pass=70  5xx=0
[modules]   PASS modules=16 failed=0
[ui]        27 routes, 0 白屏, 0 console error
[scheduler] 重启后 0 条 MISSING_AUTH_CONTEXT
[wechat]    deferred delivery failed = 0
[pilot]     142/142（同步后回归）
```

## 7. 数据卫生

```text
主站：5 个既有租户；65 工单 / 32 账号 / 16 师傅
      uat-% 租户 0；平台测试应用/账号/模板/审计 0
      /opt/youfu/uploads 仅 t-verification
pilot：4 工单 / 14 通知 / 3 账号 / 16 师傅；uat-% 0
```

## 8. 剩余风险

- 108（删除 app_secret 明文列）仍按人工流程；主站列已不存在，无需再执行。
- D-04 模板 ID 双源仍缺自动部署门禁。
- 微信 outbox（D-06）仍为内存队列（书面豁免）。
- 平台停用租户对已在线 JWT 不即时失效。
- 真机与小程序端上交互未测。
