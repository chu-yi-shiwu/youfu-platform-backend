# pilot 深度回归 · 第二轮（查漏补缺）测试报告

- 日期：2026-11-14
- 目标：不复跑既有 happy path，专测上一轮未覆盖的**异常输入、越权、隔离、并发、上传、CSV、状态机、幂等、数据保真**，以「发现新问题」为唯一验收标准。
- 环境：pilot `https://youfu.banerz.cn/pilot/`（租户 `zixing-hospital`，真实数据只读）
- 写操作：全部落在隔离租户 `uat-deep-*` / `uat-deep2-*`，结束按 `tenant_id` 清理
- 并发上限：10

## 1. 结论

| 项目 | 结果 |
|---|---|
| 新增黑盒探针 | **185 条**（142 + 43），全部执行 |
| 修复前 5xx | **6 条**（用户输入直接打崩接口） |
| 修复后 5xx | **0** |
| 新发现并修复缺陷 | **7 个产品缺陷 + 1 个测试资产缺陷**（含 3 个 P1 并发数据完整性） |
| 后端单测 | 208 文件 / **2514 用例 PASS** |
| 前端单测 | 35 文件 / **265 用例 PASS** |
| 全模块闭环 | **16/16 PASS** |
| 非功能（权限/隔离/幂等/并发） | **11/11 PASS** |
| PC Playwright | **10/10 PASS** |
| UAT 数据残留 | **0**（`tenant_registry` 中 `uat-%` = 0） |

## 2. 覆盖缺口分析（为什么上一轮没发现）

上一轮的测试以「主链路能跑通」为主，缺少以下五类断言，本轮逐项补齐：

1. **输入不应制造 5xx**：只测了缺字段/类型错，未测 NUL、非法日期、重复 query 参数等「能过 schema、死在 SQL」的输入。
2. **并发只测了巡更一个点**：巡检完成、志愿签到、运送流转同属「读-判-写」模式，未验证行锁。
3. **错误路径**：非法 UUID、跨租户 IDOR、同租户跨师傅越权、软删除、重复编码。
4. **协议边界**：畸形 JSON、错误 Content-Type、只写端点 GET、超长 query、X-Request-Id。
5. **数据保真**：emoji/引号/换行、1000 字标题、XSS 原文、幂等键重复提交、CSV 公式注入。

## 3. 新增缺陷（本轮）

### D5（P1，已修复）巡检「完成」并发双成功

- 现象：同一巡检任务两个「完成」并发请求，**两次都 200**，`done_at`/`records` 被覆盖。
- 根因：`routes/inspection.ts transitionTask()` 读取任务未加行锁，UPDATE 无条件；两个事务都读到 `in_progress`。
- 修复：`SELECT ... FOR UPDATE` + `UPDATE ... AND status = $from`，命中 0 行 → 409。
- 负控制：`src/test/transitionConcurrencyGuards.test.ts` 钉死行锁与状态条件；真实并发探针 `重复完成巡检仅 1 成功` 通过。
- 影响：巡检记录可信度（谁在何时完成、实测值）。

### D6（P1，已修复）志愿签到并发双成功

- 现象：同一志愿记录两个签到并发，**两次都 200**，`check_in_at` 被重置。
- 根因：`routes/volunteer.ts /records/:id/checkin` 读记录未加锁；状态判断在锁外。
- 修复：签到/签退/核销三处读取 `FOR UPDATE`，UPDATE 带 `AND status = 'registered'/'checked_in'/'checked_out'`。
- 负控制：同上测试文件；探针 `重复志愿签到仅 1 成功` 通过（200 + 409）。

### D7（P1，已修复）运送流转并发双成功

- 现象：运送单并发流转（如两次「接收到车」）可双成功，里程/轨迹/签收时间可被覆盖。
- 根因：`routes/transport.ts transitionOrder()` 同 D5。
- 修复：行锁 + 条件更新（命中 0 行 → 409）。
- 负控制：结构不变式测试；探针覆盖并发认领（建单已自动派单时跳过并如实记录）。

### D8（P2，已修复）非法日期字符串 → 500

- 复现：
  - `POST /transport/orders {plan_depart_at:"not-a-date"}` → 500
  - `POST /inspection/tasks {scheduled_at:"2026-13-45"}` → 500
  - `POST /volunteer/activities {start_at:"garbage"}` → 500
- 根因：PG SQLSTATE class 22（data exception，含 22007/22008）未映射，落到 500。
- 修复：`middleware/error.ts` 将 class 22 统一映射 400 `BAD_PARAM`（与既有 22P02 同口径），并给出可读文案。
- 负控制：`src/test/pgDataExceptionMapping.test.ts`（6 个 SQLSTATE + 40P01 不得被吞）。

### D9（P2，已修复）NUL 字节 → 500

- 复现：`POST /accounts {username:"a\u0000b"}`、`POST /basic-data/dept {name:"a\u0000b"}` → 500。
- 根因：Postgres 拒绝 NUL（22021），错误未映射；且各模块对 NUL 处理不一致（工单会清洗，账号/基础数据不会）。
- 修复：`middleware/requestShape.ts` 在 `/api` 边界统一拒绝请求中的 NUL（body/query/path），返回 400 `BAD_PARAM`。
- 负控制：`src/test/requestShapeBoundary.test.ts`（body 深层嵌套 NUL、query `%00` 均 400）。

### D10（P2，已修复）重复/嵌套查询参数 → 500 或 TypeError

- 复现：`GET /open/work_orders?status=done&status=pending` → 500；`?q=a&q=b` 在 `basic-data`/`equipment` 上会对数组调 `.trim()`。
- 根因：`req.query.x as string` 是类型断言不是运行期校验；Express 对重复键返回数组。
- 修复：`requestShapeMiddleware` 在边界拒绝非单值查询参数（400 `BAD_QUERY`），覆盖 **public/platform/open-api 在内的全部 `/api` 路由**。
- 负控制：同一测试文件（重复、嵌套 `a[b]=c`、单值放行）。

### D11（P3，已修复）上传接口接受非法 Base64

- 复现：`POST /upload {base64:"!!!!notbase64!!!!"}` → 200，落盘空/残缺文件。
- 根因：`Buffer.from(x,'base64')` 宽松解码，静默丢弃非法字符。
- 修复：新增 `src/util/base64.ts` 严格解码（字母表/填充/回编码比对），账号上传与公开上传共用。
- 负控制：`src/test/base64.test.ts` 5 例 + `upload.http.test.ts` 非法输入断言 400。

### D12（测试资产，已修复）非功能脚本「假清理」

- 现象：`pilot-nonfunctional-e2e.mjs` 用应用账号执行 `SET session_replication_role` → 权限不足，事务回滚，但脚本仍打印 `cleaned`，**遗留 2 个 UAT 租户及业务行**。
- 修复：改用 `sudo -u postgres psql` + `ON_ERROR_STOP=1`，失败显式报错。
- 处置：已手工清理全部 `uat-%` 残留（核对 0 行）。

### D13（P3，已修复）API 缺少 `X-Content-Type-Options`

- 修复：`/api/*` 响应统一 `nosniff`（此前仅 `/uploads` 有）。
- 证据：探针断言 `x-content-type-options: nosniff`。

## 4. 探针矩阵（185 条，节选）

| 类别 | 覆盖点 | 结果 |
|---|---|---|
| 认证 | 空 body / 错密码 / SQLi / 不存在租户 / 无 token / 篡改 token / worker 越权 | PASS（429 限频生效） |
| 输入健壮性 | 空 body、NUL、超长、对象、非法枚举、畸形日期、非法 UUID ×12、重复 query ×4、分页极值 | PASS（0 5xx） |
| 租户隔离 | 资产/耗材/巡检/志愿/工单/巡更 跨租户读改删 + 列表 | PASS（全 404） |
| 同租户越权 | w1 读/改 w2 工单、w2 读/完成 w1 巡检、worker 导出/账号 | PASS（403/404） |
| 并发 | 抢单、工单到场、巡检完成、巡更扫码、志愿签到、库存出库、巡检抢单 | PASS（恰 1 成功） |
| 状态机 | 直达终态、非法事件、不存在单、flow 非法 entityType、重复确认/作废结算 | PASS（4xx） |
| 上传 | 无 token、空/非法 base64、exe、路径穿越、6MB、公开 org 校验、跨租户读文件 | PASS |
| CSV | 导出表头、公式注入中和、空/仅表头/超 2000 行 | PASS |
| 权限 | worker/operator 对管理端、平台端隔离 | PASS |
| 通知 | 派单通知归属、他人标记已读不生效、本人生效 | PASS |
| 抢单大厅 | 跨租户无泄漏、已派单不在大厅、非法部门 ID | PASS |
| 账号安全 | 最后管理员自降级、operator 重置管理员、跨租户重置、改密旧密码校验、改密后旧 token 失效 | PASS |
| 数据保真 | emoji/引号/换行、1000 字标题（400）、XSS 原文 | PASS |
| HTTP 边界 | 畸形 JSON、text/plain、只写端点 GET、10k query、X-Request-Id | PASS |
| 幂等 | 同键两次 → 同一工单且库中 1 行；不同键 → 各自建单 | PASS |
| 公开接口 | 缺 consent、NUL、org 不存在、进度缺参/不存在、租户搜索、空 AI 消息 | PASS |

## 5. 观察项（非缺陷，未改）

- `business_type` 为自由字符串：租户可自定义业务类型，后端不设枚举；未知类型仍可建单（走默认流程）。属产品设计，建议在配置中心提供「业务类型字典」提示。
- 账号 `username` 无长度上限（300 字符可建）。不影响安全/正确性，属输入卫生，可后续统一加 `.max(64)`。
- 资产无删除端点（只有停用 `status=disabled`），符合「资产不物理删除」的审计设计。
- 数据库存在 2026-11-07 遗留的孤儿 worker 行（`t-verification` 4 条、`pilot-tenant-b` 1 条），无租户注册、无业务数据；非本轮产生，未擅自删除。

## 6. 数据与部署

```text
UAT 残留：0（uat-% 租户 0 行）
pilot：4 工单 / 14 通知 / 16 师傅 / 3 账号 / 5 巡检单（含用户本轮实测产生的单）
uploads：仅 zixing-hospital（440K）
后端：dist 已部署，/health/ready = {"ok":true,"status":"ready","db":"up"}
PC：Playwright 10/10（27 路由不白屏）
```

新增/修改文件：

- `src/middleware/requestShape.ts`（新）
- `src/util/base64.ts`（新）
- `src/middleware/error.ts`（class 22 → 400）
- `src/server.ts`（边界挂载 + nosniff）
- `src/routes/inspection.ts` / `transport.ts` / `volunteer.ts`（并发行锁 + 条件更新）
- `src/routes/upload.ts` / `publicReport.ts`（严格 base64）
- 测试：`requestShapeBoundary` / `pgDataExceptionMapping` / `base64` / `transitionConcurrencyGuards`
- 探针：`scripts/uat-deep-probe.mjs`（142 条）、`scripts/uat-deep-probe2.mjs`（43 条）
- 测试资产修复：`scripts/pilot-nonfunctional-e2e.mjs`（可靠清理）

## 7. 未覆盖/后续建议

- 真机（iPad / HarmonyOS）与小程序的端上交互（本轮按既定范围不测）。
- 平台端写操作（暂停租户、模板审核、试用审批）只做了鉴权边界，未做完整业务闭环。
- LLM 相关端点依赖外部模型配额，仅测空输入/鉴权，未做提示注入与成本压测。
- 建议下一轮：平台侧全闭环 + 时间边界（跨零点 `today`/月报）+ 通知触达（微信模板消息是否真发）。
