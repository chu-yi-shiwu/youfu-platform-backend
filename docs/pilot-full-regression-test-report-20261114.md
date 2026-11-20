# 全模块全量测试与集成测试报告（2026-11-14）

> 基线：本轮从零执行，不引用历史测试结论；以下数字均为本轮实测。
> 环境：隔离 UAT 租户 + 真实 pilot 只读；真机按决策本轮不测。

## 1. 结论

| 项目 | 结果 |
| --- | --- |
| 静态门禁（tsc/build/health） | PASS |
| 后端全量单测 | 204 文件 / 2486 用例 PASS |
| 前端全量单测 | 35 文件 / 264 用例 PASS |
| 全模块 API 闭环 | 16/16 模块 PASS |
| 全业务集成链 | PASS（建单→派单→接单→完成→复核→评价→结算） |
| 补充模块（监控/能耗/平台/试用） | 11/11 PASS |
| 非功能（权限/隔离/幂等/并发） | 11/11 PASS |
| CSV 往返 | PASS |
| 安全 E2E | PASS |
| 1000 条列表/工作台性能 | PASS（列表 p95 543.7ms，工作台 p95 32.8ms） |
| 并发/上传性能 | PASS（上传 1MB p95 2045ms，接口 20/20 成功） |
| PC Playwright | 10/10 PASS（覆盖 27 个可见路由） |
| 小程序预览编译 | PASS（177 个代码文件） |
| 真机 | 未测（按决策） |
| 测试数据清理 | 0 残留 |

**本轮发现并修复 2 个真实缺陷**：巡更同点并发签到可重复成功（P1 数据完整性）；PC 巡检单「完成」后详情页白屏（P1 可用性）。均已修复、补负控制测试并部署。

## 2. 覆盖范围

### 2.1 后端模块

工单/报修、巡检、巡更、志愿者、资产、耗材、设备、结算、应急、监控、运送、能耗、通知、反馈、基础数据、组织/账号/权限、配置、工作流、统计、优化、平台、试用、邀请、AI、上传、OpenAPI。

### 2.2 PC 页面

本轮 Playwright 覆盖 27 个路由：

```text
dashboard / intake / tickets / settlement / inspection / inspection-plans / patrol
volunteer / volunteer/stats / asset / material / equipment / emergency-plan
analytics / analytics-stats / optimize / trial / feedback / foundation / basic-data
system / business-process / dispatch-rules / terms / system-config / monitor / transport
```

### 2.3 小程序

41 个页面全部参与预览编译；API 流程覆盖登录/公开报修/工人任务/巡检/巡更/志愿者/陪检/运送/通知等。
真机 iPad/HarmonyOS 按决策本轮不测。

## 3. 执行结果明细

### 3.1 L0 静态

```text
后端 tsc --noEmit        PASS
后端 npm run build       PASS
前端 tsc -b              PASS
pilot /health/ready      PASS（db up，服务 active）
```

### 3.2 L1 单元/回归

```text
后端 204 文件 / 2486 用例 PASS
前端 35 文件 / 264 用例 PASS
```

### 3.3 全模块 API 闭环（16/16）

```text
工单 + 耗材 + 结算闭环          PASS
巡检执行                        PASS
巡更执行（扫码契约）            PASS
资产故障 → 工单                 PASS
设备档案 + 维保                 PASS
应急预案                        PASS
志愿者活动闭环                  PASS
优化 + 工作流                   PASS
派单规则 + 术语 + 系统配置      PASS
账号/角色/体验用户              PASS
需求反馈                        PASS
统计/工作台/过程挖掘            PASS
公开报修 / 我的报修             PASS
小程序陪检登记                  PASS
小程序运送单                    PASS
小程序师傅任务接单              PASS
```

### 3.4 全业务集成链

```text
公开/登录建单 → 自动派单 → 到场/开始 → 上传照片/录音 → 挂起/恢复
→ 提交复核 → 驳回 → 再提交 → 通过 → 完成 → 关闭 → 评价 5 分
→ 公开查询/通知/事件核对 → 清理
PASS
```

### 3.5 补充模块（11/11）

```text
监控：设备告警创建 / 告警处置 / 告警转工单 / 设备列表     PASS
能耗：状态图自述                                          PASS
平台：总览 / 租户列表 / 无 token 401                      PASS
试用：提交申请 / 平台列表可见 / 驳回                      PASS
```

### 3.6 非功能（11/11）

```text
未登录访问 → 401
篡改 token → 401
worker 建志愿活动 → 403
worker 读账号 → 403
worker 读结算 → 403
跨租户资产列表 → 0
跨租户志愿活动 → 404
建单幂等：同一 Idempotency-Key 两次 → 同一单、库中 1 条
10 并发抢最后 1 名额 → 恰好 1 成功
10 并发同点巡更签到 → 恰好 1 成功（修复后）
```

### 3.7 导入导出 / 安全 / 性能

```text
CSV 往返（中文/日期/名称映射）        PASS
安全 E2E（跨租户/IDOR/XSS/上传/注入） PASS
1000 条工单列表 p95 543.7ms           PASS
工作台 p95 32.8ms                     PASS
20 次接口并发 error_rate 0            PASS
1MB 上传 p95 2045ms                   PASS
```

### 3.8 PC Playwright

```text
10/10 PASS
新增覆盖：foundation / basic-data / system / business-process / dispatch-rules
         / terms / system-config / feedback / dashboard / intake / tickets
         / monitor / transport 等 27 个路由
```

### 3.9 小程序

```text
v5.9.27 预览编译成功（177 个代码文件）
API 流程：登录/报修/任务/巡检/巡更/志愿者/陪检/运送/通知  PASS
布局变更：工作台仪表盘、待办 Tab、工单详情底部操作条、巡检底部主操作
真机：未测（按决策）
```

## 4. 缺陷

### D1（P1，已修复）巡更同点并发签到重复成功

- 现象：10 并发对同一巡更点签到，9 次返回 200，检查记录被重复追加。
- 根因：`POST /patrol/tasks/:id/checkin` 读取任务时未加行锁（无 `FOR UPDATE`），并发请求都读到旧 `checkins`，重复校验失效。
- 修复：签到与漏签读取任务改为 `SELECT ... FOR UPDATE`；补测试断言 SQL 含行锁。
- 验证：修复前 200=9；修复后 10 并发 200=1；全量单测 2486 PASS。
- 影响：巡更记录可信度；不涉及金额，但属 P1 数据完整性问题。

### D2（测试资产，已修正）脚本契约漂移

- `pilot-uat-all-modules-e2e.mjs` 仍按旧契约用 `point_id` 让 worker 签到，当前契约要求扫码。
- 已改为：worker 直接签到断言 403 SCAN_REQUIRED；扫码 200 且 `via=scan`。
- 重跑 16/16 PASS。

### D3（测试编排，已规避）并行登录触发 429

- 两个性能脚本同时登录触发 `RATE_001`；改为串行并等待限频窗口后重跑，均 PASS。
- 属测试编排问题，不是产品缺陷；也验证了登录限频生效。

### D4（P1，已修复）PC 巡检单详情「完成」后整页白屏

- 现象：`/inspection` 详情抽屉点「完成」，接口成功（任务状态已落 `done`），但页面立刻被全局 ErrorBoundary 接管，只剩「页面渲染出错」，错误信息 `Cannot read properties of undefined (reading 'filter')`。
- 根因（契约层）：`POST /inspection/tasks/:id/complete` 返回的是**任务行**，不含 `available/items/records`；前端原先把该响应直接 `setDetail`，下一次渲染执行 `detail.available.filter(...)` 即对 `undefined` 调用 `.filter()`。同类问题在运送 `POST /transport/orders/:id/transition`、流程 `POST /flow/:entityType/:id/transition` 上同样存在（三者返回外壳一致但字段不完整）。
- 修复（统一口径，不是逐页打补丁）：
  1. 三处详情页在动作成功后**不再用流转响应回填**，统一 `await openDetail(id)` 重新拉取完整详情（唯一数据源 = 详情接口）。
  2. 渲染侧加防御兜底 `(detail.available ?? [])`，并把「无可执行动作」显式渲染为提示文案，避免空数组时静默空白。
  3. 全局 `ErrorBoundary` 增加当前路由展示与控制台组件栈输出，后续同类渲染异常可一次定位到页面。
- 负控制：`src/test/pages/InspectionPage.test.tsx` —— 完成动作后必须发生**第二次** `GET /inspection/tasks/t-1`；mock 的流转响应故意不含 `available`，若回填旧实现即失败。前端 6/6 PASS，`tsc -b` 0 错。
- 复测：pilot 该单已落 `done`（`updated_at 2026-11-14 20:11:26`），证明后端链路正常、故障仅在前端回填；PC Playwright 10/10 PASS（含 27 路由不白屏）。
- 部署：`assets/index-_BnOYia4.js`（已含路由诊断文案）。

## 5. 数据清理

```text
pilot：4 工单 / 14 通知 / 16 师傅 / 3 账号
临时租户：0
孤立业务数据：0
uploads：仅 zixing-hospital
health：ready
```

本轮发现的 5 个残留 UAT 租户（补充/非功能脚本清理时客户端已关闭）已用 `tenant_id LIKE 'uat-%'` 统一清理并复核为 0。

## 6. 残余风险与未覆盖

1. **真机未测**（按决策）：iPad/HarmonyOS 的扫码、定位、相机、弱网、底部安全区需后续真机走查。
2. **能耗 webhook HMAC 未做端到端**：本轮只验证 `/energy/def`；能源侧签名回调需联调环境。
3. **平台工作流配置**：平台端登录/租户/试用/总览已验证；平台侧租户 workflow-def 编辑/审批未逐端点实测。
4. **AI/LLM 外部依赖**：未做真实模型质量评估；只验证了业务接口闭环。
5. **模板市场/OpenAPI/邀请码**：未做完整深链；本轮以既有单测 + 页面冒烟为主。
6. **并发规模**：按决策只跑 10 并发，未跑 50 并发。
7. **P3 视觉项**：版本号页脚、部分页面空态组件替换未全量铺开。

## 7. 交付物

```text
docs/pilot-full-regression-test-plan-20261114.md
docs/pilot-full-regression-test-report-20261114.md
docs/pilot-full-regression-defect-list-20261114.md
scripts/pilot-uat-all-modules-e2e.mjs（已按当前契约修正）
scripts/pilot-full-business-e2e.mjs
scripts/pilot-platform-monitor-e2e.mjs
scripts/pilot-nonfunctional-e2e.mjs
scripts/pilot-csv-roundtrip-e2e.mjs
scripts/pilot-security-e2e.mjs
scripts/pilot-list-1000-e2e.mjs
scripts/pilot-perf-e2e.mjs
```

## 8. 准出判定

```text
A–L 模块：已执行，无未修复 P0/P1
X1–X15：核心链已通过；平台工作流/能耗 webhook/真机为残余
I1–I15：本轮校验未发现违反（巡更并发缺陷已修复后复测）
全量单测：0 fail
PC：10/10
小程序：预览编译通过；真机未测
清理：0 残留
结论：可进入下一阶段；真机与上述残余需单独补充
```
