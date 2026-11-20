# Pilot 新一轮全方位测试报告（2026-11-13）

> 状态：执行中。Day 0 / Day 1 / Day 2 已完成，Day 3（真机 + 真实微信）安排在 11/14 下午。

## 1. 环境与基线

```text
PC：https://youfu.banerz.cn/pilot/
API：http://127.0.0.1:4101/api/v1
租户：zixing-hospital（真实）；uat-r2a/b、uat-all-<run>（隔离）
真实师傅：17773639019 / HQ016
```

测试前备份：

```text
DB：/opt/youfu/backup/pilot-pre-round2-20261113-211450.dump（3.0MB）
上传：/opt/youfu/backup/pilot-uploads-pre-round2-20261113-211450.tar.gz（417KB）
```

基线：4 工单 / 14 通知 / 3 账号 / 16 师傅 / UAT 租户 0。

## 2. 执行结果总览

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 后端 tsc / build | PASS | Day 0 静态门禁 |
| 前端单元 | 30 文件 / 238 用例 PASS | Day 0 |
| 前端 pilot 构建 | PASS | Day 0 |
| 后端全量回归 | 203 文件 / 2452 用例 PASS | 最终回归（含新增 3 条） |
| 隔离 UAT 全模块 | 16 模块 PASS，租户已清理 | `[uat] PASS modules=16 failed=0` |
| PC Playwright | 9 用例 PASS | 全模块菜单/页面/登录/XSS/详情 |
| 角色 × 动作矩阵 | PASS | `[role-e2e] PASS` |
| 安全 E2E | PASS | `[security-e2e] PASS` |
| 深度专项（权限/隔离/并发） | 8/8 PASS | `[deep] PASS checks=8 failed=0` |
| 性能 10 并发建单 | p95 278ms | 20 单 |
| 性能 50 并发建单 | p95 612ms，0 错误 | 50 单 |
| 1000 条列表 | 首页 p95 305ms / 深分页 302ms / 200 条页 568ms | 1000 行 |
| 1MB 上传 | p95 2.1s（ECS 经公网 Nginx 回环） | 5 次 |
| 负载中重启 | 120 请求，1 次失败，恢复后 200 | 重启窗口内 1 个请求失败 |
| 备份恢复 | 行数 10/10 表一致，RLS 84/84，临时库已删 | Day 0 备份 |
| 24h soak（上一轮） | 84951 采样，error_rate 0，p95 17.9ms | 已完成 |
| 真实微信 | 上一轮 `delivered=true`；本轮待 11/14 复验 | WO_20261112_1990936761 |
| iPad / HarmonyOS | 待 11/14 下午 | 预览码待发 |

## 3. 全模块 UAT

```text
[uat] PASS modules=16 failed=0
[uat] cleaned uat-all-...
```

覆盖：工单+耗材+结算、巡检、巡检计划、巡更、资产、设备、应急预案、志愿者、优化/工作流、派单规则/术语/系统配置、账号/角色/体验用户、反馈、统计/过程挖掘、公开报修/我的报修、小程序陪检、运送、师傅任务。

## 4. 权限与隔离

### 权限矩阵

```text
worker → /accounts/roles、POST /accounts、/feedback、派单规则、结算确认：全部 403
operator → 建 admin：403（越级）
admin → 账号列表、系统配置：200
未登录 / 篡改 token：401
```

### 租户隔离

```text
A 读/改 B 资产：404
A 读 B 工单：404
```

### RLS 直连验证

```text
youfu_app + app.tenant_id='zixing-hospital'：
  worker + account_user JOIN 能解析到 HQ016 openid
app.tenant_id 错误时查询返回 0 行（由既有 RLS 策略保证）
```

## 5. 并发与竞态

| 场景 | 结果 |
| --- | --- |
| 3 人同时抢 1 单 | 1 个 200，2 个 409，无重复归属 |
| 库存 5，10 次并发出库 1 | 恰好 5 成功，5 个 4xx，最终库存 0 |
| 同一工单 3 次并发提交复核 | 恰好 1 次成功，最终 pending_review |
| 同一工单 2 次并发建结算 | 201 + 409，结算明细恰好 1 行 |

### 本轮缺陷：抢单失败者返回 404

- 现象：3 人同时抢单，赢家 200，另外两人 404 `work order not found`。
- 根因：抢单端点复用抢单大厅 RLS（`app_claim_hall=1` 仅见未指派单）。
  赢家提交后，后到请求已经看不到该行，`findOneForUpdate` 返回 null，
  服务层抛 NOT_FOUND。小程序只识别 409，404 会显示英文 `work order not found`。
- 修复：`claimWorkOrder` 在行不可见时返回 `409 CONFLICT`（动作语义是“已离开抢单池”），
  不再返回 404。
- 负控制：`claimThroughGates.test.ts` 新增 ⑨，不可见单必须 409；深度 E2E 3 人抢单
  必须 1 胜 2 冲突。
- 结果：修复后 `[deep] PASS checks=8 failed=0`。

## 6. 性能

### 10 并发建单（20 单）

```text
total=20 ok=20 error_rate=0
p50=133.6ms p95=278ms p99=307.6ms max=307.6ms
statuses: 201×20
```

### 50 并发建单

```text
total=50 ok=50 error_rate=0
p50=468.3ms p95=612ms p99=620.1ms
statuses: 201×50
分配：20/7/8/6/9，无单行锁死
```

### 1000 条列表

```text
首页 limit=100：p50 68.1ms / p95 305.1ms
深分页 offset=900：p50 277.1ms / p95 302.3ms
200 条页：p50 349ms / p95 568ms
工作台：p50 29.3ms / p95 31.9ms
```

目标：10 并发建单 p95 < 3s；1000 列表 p95 < 1.5s。均 PASS。

### 1MB 上传

```text
p50=2004ms p95=2041ms（ECS → 公网 Nginx → 回环）
5 次全部 201
```

较上一轮本机 19.4ms 慢，原因是本轮从 ECS 走公网域名回环；不是应用层回归。
建议真机阶段用手机网络单独记录一次。

### 负载中重启

```text
120 请求 / 500ms 间隔
重启窗口内：1 次连接失败
其余 119 次 200
重启后 /health/ready 200
p95=11ms
```

### AI embedding 开关对比（独立时段）

关闭 embedding：

```text
20 单 / 10 并发：p95 278ms，0 错误
```

开启 embedding：

```text
20 单 / 10 并发：p50 1179.6ms，p95 8011ms，p99 8085.7ms，max 8085.7ms
statuses: 201×20，本轮未出现 500
```

结论：开启 embedding 后建单 p95 从 278ms 升至 8011ms，超过 3s 目标约 2.7 倍，
且上一轮曾出现连接池超时 500。本轮主流程继续默认关闭；若生产要开，
必须先把 embedding 移到独立队列/连接池，不能与建单共用资源。

## 7. 安全

`pilot-security-e2e.mjs` PASS，覆盖：

```text
跨租户读取、X-Tenant-Id 伪造、IDOR、PII/角色、公开面信息泄露、
Token 篡改、SQL 注入、上传路径穿越/类型/文件名、未认证访问
```

## 8. 备份恢复

```text
DB dump：pilot-pre-round2-20261113-211450.dump
恢复临时库 → 10 张表行数全部一致
RLS 策略：84 / 84
抽查：默认部门 3、工单 4、师傅 16
临时库已删除
```

## 9. 已知风险与待办

| 项 | 级别 | 说明 | 处理 |
| --- | --- | --- | --- |
| 微信 pending 队列在内存 | P2 | 进程崩溃/重启会丢失尚未补投递的 wechat 通知 | 建议改持久化 outbox；本轮记录，需书面豁免 |
| 模板 ID 双源 | P2 | `app.js` 与后端 `.env` 需人工同步 | 建议部署门禁脚本比对；本轮人工核对一致 |
| AI embedding | P2 | 开启时曾拖垮建单；本轮默认关闭 | 单独时段做开关对比 |
| 1MB 上传 2s | P3 | 公网回环导致，非应用回归 | 真机网络复测 |
| soak 中 1×401 / 2×502 | P3 | 401 为登录限流，502 为瞬时网关 | 记录，不阻塞 |

### P2 书面豁免（2026-11-13 已确认）

```text
通知 outbox（内存队列丢消息）   → 接受，pilot 后修
模板 ID 双源无自动门禁          → 接受，pilot 后补部署门禁
AI embedding 资源未隔离         → 接受，pilot 保持关闭，生产前修
```

## 10. Day 3 计划（11/14 15:00）

清单：`docs/pilot-device-uat-20261114.md`

1. 14:30 重新生成 pilot 预览码（v5.9.19+）；
2. 15:00 iPad / HarmonyOS 微信走查；
3. 真实微信：授权 → 真实派单 → 确认到达；
4. 设备问题现场记录、修复、复测；
5. 最终全量回归 + 报告归档。
