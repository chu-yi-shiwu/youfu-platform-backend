# 全量回归缺陷清单（2026-11-14）

## D1（P1，已修复）巡更同点并发签到重复成功

- 模块：巡更
- 发现方式：10 并发对同一巡更点签到
- 现象：9 次返回 200，checkins 被重复追加；应为 1 次成功、其余 409
- 根因：`src/routes/patrol.ts` 签到/漏签读取 `patrol_task` 未加行锁；并发请求读取同一份旧 `checkins`，重复校验失效
- 修复：两处读取改为 `SELECT ... WHERE tenant_id=$1 AND id=$2 FOR UPDATE`
- 负控制：`patrolGuard.http.test.ts` 断言签到 SQL 含 `FOR UPDATE`
- 复测：修复前 200=9；修复后 10 并发 200=1；后端全量 2486 PASS
- 状态：已修复、已部署、已复测

## D2（测试资产，已修正）全模块脚本仍用旧巡更契约

- 模块：测试脚本
- 现象：worker 只传 `point_id` 签到返回 403，脚本断言 200 失败
- 原因：当前契约要求 worker 扫码（`code`），直接签到仅管理端
- 修复：脚本改为“直接签到 403 SCAN_REQUIRED + 扫码 200 且 via=scan”
- 复测：16/16 模块 PASS
- 状态：已修正

## D3（测试编排，已规避）并行脚本登录触发限频

- 模块：测试环境
- 现象：两个性能脚本同时登录返回 429 RATE_001
- 原因：登录限频生效
- 处理：串行执行并等待窗口；两脚本均 PASS
- 状态：非产品缺陷，已规避

## D4（P1，已修复）PC 巡检单详情「完成」后整页白屏

- 模块：巡检（PC 详情）
- 发现方式：真实 pilot 操作——巡检单详情 → 可执行动作「完成」
- 现象：接口 200 且任务已落 `done`，但页面立即被 ErrorBoundary 接管，提示 `Cannot read properties of undefined (reading 'filter')`
- 根因：`POST /inspection/tasks/:id/complete` 返回任务行，不含 `available/items/records`；前端用该响应 `setDetail`，下次渲染 `detail.available.filter` 对 `undefined` 取成员。运送 `/transport/orders/:id/transition`、流程 `/flow/:entityType/:id/transition` 返回外形相同、字段同样不完整，属同一契约层根因
- 修复：三处详情页动作成功后统一 `await openDetail(id)` 重新拉取完整详情；渲染侧 `(detail.available ?? [])` 兜底并显式渲染「当前状态无可执行动作」；ErrorBoundary 输出路由与组件栈便于定位
- 负控制：`InspectionPage.test.tsx` 断言完成后必须第二次 GET `/inspection/tasks/t-1`（mock 流转响应故意缺 `available`）；6/6 PASS，`tsc -b` 0 错
- 复测：该单 `status=done`、`updated_at 2026-11-14 20:11:26`（后端正常）；PC Playwright 10/10 PASS
- 部署：`assets/index-_BnOYia4.js`
- 状态：已修复、已部署，待用户强刷复测确认

## 第二轮（深度探针）新增缺陷 D5–D13

> 完整报告：`docs/pilot-deep-regression-round2-20261114.md`
> 探针：`scripts/uat-deep-probe.mjs`（142 条）/ `scripts/uat-deep-probe2.mjs`（43 条）
> 基线：修复前 6 条 5xx；修复后 185 条探针 0 个 5xx。

### D5（P1，已修复）巡检「完成」并发双成功

- 现象：同一巡检任务两个「完成」并发，两次都 200，`done_at`/`records` 被覆盖
- 根因：`routes/inspection.ts transitionTask()` 读任务无行锁，UPDATE 无 from 状态条件
- 修复：`SELECT ... FOR UPDATE` + `UPDATE ... AND status = $from`（0 行 → 409）
- 负控制：`transitionConcurrencyGuards.test.ts`；探针「重复完成巡检仅 1 成功」= 200 + 422
- 状态：已修复、已部署、已复测

### D6（P1，已修复）志愿签到并发双成功

- 现象：同一记录两个签到并发，两次都 200，`check_in_at` 被重置
- 根因：`routes/volunteer.ts` 签到/签退/核销读记录无行锁
- 修复：三处 `FOR UPDATE` + 条件更新（`registered`/`checked_in`/`checked_out`）
- 负控制：同测试文件；探针「重复志愿签到仅 1 成功」= 200 + 409
- 状态：已修复、已部署、已复测

### D7（P1，已修复）运送流转并发双成功

- 现象：运送单并发流转可双成功（司乘/签收时间可被覆盖）
- 根因：`routes/transport.ts transitionOrder()` 同 D5
- 修复：行锁 + 条件更新（0 行 → 409）
- 负控制：结构不变式测试；并发认领探针（自动派单场景如实跳过）
- 状态：已修复、已部署、已复测

### D8（P2，已修复）非法日期字符串 → 500

- 复现：`transport.plan_depart_at="not-a-date"` / `inspection.scheduled_at="2026-13-45"` / `volunteer.start_at="garbage"`
- 根因：PG SQLSTATE class 22（22007/22008）未映射，落到 500
- 修复：`middleware/error.ts` class 22 统一 400 `BAD_PARAM`
- 负控制：`pgDataExceptionMapping.test.ts`（6 个 SQLSTATE + 40P01 不吞）
- 状态：已修复、已部署、已复测

### D9（P2，已修复）NUL 字节 → 500

- 复现：`POST /accounts {username:"a\u0000b"}`、`POST /basic-data/dept {name:"a\u0000b"}`
- 根因：Postgres 22021 未映射；NUL 处理各模块不一致
- 修复：`middleware/requestShape.ts` 边界拒绝 NUL（body/query/path）→ 400
- 负控制：`requestShapeBoundary.test.ts`
- 状态：已修复、已部署、已复测

### D10（P2，已修复）重复/嵌套查询参数 → 500 或 TypeError

- 复现：`GET /open/work_orders?status=done&status=pending` → 500；`?q=a&q=b` 对数组调 `.trim()`
- 根因：`req.query.x as string` 只是类型断言；重复键在运行期是数组
- 修复：边界拒绝非单值查询参数（400 `BAD_QUERY`），覆盖全部 `/api`（含 public/platform/open-api）
- 负控制：`requestShapeBoundary.test.ts`（重复、嵌套、单值放行）
- 状态：已修复、已部署、已复测

### D11（P3，已修复）上传接受非法 Base64

- 复现：`POST /upload {base64:"!!!!notbase64!!!!"}` → 200，落盘坏文件
- 根因：`Buffer.from(...,'base64')` 宽松解码
- 修复：`src/util/base64.ts` 严格解码，账号上传/公开上传共用
- 负控制：`base64.test.ts` + `upload.http.test.ts`
- 状态：已修复、已部署、已复测

### D12（测试资产，已修复）非功能脚本假清理

- 现象：应用账号执行 `SET session_replication_role` 权限不足 → 事务回滚，但脚本仍打印 cleaned，遗留 2 个 UAT 租户
- 修复：改 `sudo -u postgres psql` + `ON_ERROR_STOP=1`；已手工清理全部 `uat-%`（0 行）
- 状态：已修复、已复测

### D13（P3，已修复）API 缺 `X-Content-Type-Options`

- 修复：`/api/*` 响应统一 `nosniff`
- 证据：探针断言通过
- 状态：已修复、已部署

## 第三轮（平台端 + 时间边界）新增缺陷 D14–D17

> 报告：`docs/pilot-platform-time-regression-20261114.md`
> 探针：`scripts/uat-platform-time-probe.mjs`（70 条，0 5xx）

### D14（P1，已修复）平台无法创建开放应用

- 现象：`POST /platform/apps` → 400「缺少必填字段（app_secret）」，开放平台不可用
- 根因：052 建表 `app_secret NOT NULL`，但代码只写 `secret_hash`；pending 108 删列迁移未执行
- 修复：`119_open_api_app_secret_nullable.sql` 解除 NOT NULL（不删列、不双写明文）
- 负控制：`platformWrites.test.ts`
- 状态：已修复、已部署、已复测（创建→调用→撤销全链路）

### D15（P1，已修复）平台租户列表 LLM 授权永远 false

- 现象：LLM 授权 200，但列表始终 `llm_enabled=false`
- 根因：`tenant_settings` RLS + 平台连接无租户 GUC ⇒ LEFT JOIN 恒空
- 修复：`120_platform_tenant_llm.sql` SECURITY DEFINER 聚合函数；路由改 JOIN 函数
- 负控制：`platformWrites.test.ts`
- 状态：已修复、已部署、已复测（true/false 均可读回）

### D16（P1，已修复）平台新开租户无法建单

- 现象：新租户管理员可登录，但首单 422 `DEPARTMENT_UNRESOLVED`
- 根因：开通事务未创建默认部门
- 修复：`provisionNewTenantContent` 保证至少一个默认部门（无则建「默认部门」，有则设默认）
- 负控制：`tenantProvisionDefaultDept.test.ts`（三种状态）
- 过程教训：初版 `ON CONFLICT (tenant_id, code)` 因无唯一约束触发 42P10（开通 500），上线前被探针抓住并改为直接 INSERT
- 状态：已修复、已部署、已复测

### D17（P3，已修复）模板应用到不存在租户返回误导性 409

- 现象：`apply {tenantId:"no-such-tenant"}` → 409 DRAFT_STALE
- 修复：事务前校验租户存在性 → 404
- 负控制：`templateApplyTenant404.http.test.ts`
- 状态：已修复、已部署、已复测

## 主站同步新增缺陷 D18–D20（2026-11-15）

> 报告：`docs/main-site-sync-20261115.md`
> 背景：主站独立实测（非 pilot 结论）发现；修复后主站 255 条探针 0 个 5xx。

### D18（P1，已修复）巡检计划调度器每分钟 500

- 现象：主站日志每分钟 `withTenantClient 缺少 auth context`，到期巡检计划永不生成
- 根因：`runDuePlansForTenant` 未传 `{ system: true }`；调度器无请求级 ALS 上下文
- 修复：显式 system，与 SLA 调度器同口径
- 负控制：`inspectionSchedulerScope.test.ts`
- 状态：已修复、已部署、主站复测

### D19（P1，已修复）微信补投递在响应后 500

- 现象：公开报修成功后 `[notify:wechat] deferred delivery failed ... MISSING_AUTH_CONTEXT`
- 根因：`flushWechatDeliveries` 在 `res.on('finish')` 后执行，默认 executor 未传 system
- 修复：默认 executor 传 `{ system: true }`
- 负控制：`wechatDeferredScope.test.ts`
- 状态：已修复、已部署、主站复测

### D20（P3，已修复）119 迁移在 app_secret 已删除环境不可执行

- 现象：主站已执行 108（列不存在），`ALTER COLUMN` 报 undefined_column，迁移中断
- 修复：DO 块先判列存在，不存在则跳过（幂等）
- 负控制：`platformWrites.test.ts` 增加列不存在分支断言
- 状态：已修复、已应用主站

### D21（P1，已修复）主站建单/流转被 embedding 扇出拖慢

- 现象：主站 20 并发建单 p95 **3.2s**、同期流转 p95 **2.0s**、混合 soak p95 **1.45s**；pilot 同场景 239ms / 114ms / 45ms
- 根因（两层）：
  1. 建单路径只判断全局 `EMBEDDING_API_KEY`，**未遵守租户 `ai_features_enabled`**，主站所有租户都被嵌入；
  2. embedding 虽 fire-and-forget，但**无并发上限**，高并发建单时大量外部请求挂起，拖慢事件循环与出站连接，连带影响流转
- 修复（根因层）：
  1. `getAiFeaturesEnabled(tenantId, client)` 前置门：租户 AI 未开启 ⇒ 不产生嵌入任务（默认关闭，fail-safe）
  2. 新增 `services/embeddingQueue.ts`：全局有界队列（**2 并发 / 200 上限**），超限丢弃并告警，禁止无限堆积
  3. 嵌入仍在后台 best-effort 执行，不阻塞建单响应
- 复测（主站轻量压测）：20 并发建单 p95 **3.2s → 355ms**；流转 p95 **2.0s → 127ms**；soak p95 **1.45s → 22ms**，0 个 5xx
- 负控制：`embeddingQueueScope.test.ts`（并发上限、队列满丢弃、租户门在入队之前）
- 状态：已修复、已部署 pilot + 主站、已复测
