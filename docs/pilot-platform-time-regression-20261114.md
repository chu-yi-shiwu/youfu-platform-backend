# pilot 深度回归 · 平台端写闭环 + 时间边界（2026-11-14）

- 目标：补齐上一轮明确未覆盖的两块——**平台端写操作闭环**与**时间/时区边界**。
- 环境：pilot `https://youfu.banerz.cn/pilot/`；平台侧测试数据全部用本轮临时账号/应用/模板，按名/租户清理。
- 探针：`scripts/uat-platform-time-probe.mjs`（**70 条**）
- 写操作隔离：先经平台 API 注册 `uat-plat-<run>` 租户；试用通过再建 `uat-trial-<run>`；结束全部按 `tenant_id` 清理。

## 1. 结论

| 项 | 结果 |
|---|---|
| 平台+时间探针 | **70/70 PASS**，**0 个 5xx** |
| 新发现并修复 | **4 个产品缺陷（3 个 P1）+ 3 处测试资产问题** |
| 后端单测 | 211 文件 / **2523 用例 PASS** |
| 前端单测 | 35 文件 / **265 用例 PASS** |
| 全模块闭环 | 16/16 PASS |
| PC Playwright | 10/10 PASS |
| UAT 残留 | 0（租户/应用/平台账号/模板/试用/审计痕迹均为 0） |

## 2. 新发现缺陷

### D14（P1，已修复）平台无法创建开放应用

- 现象：`POST /platform/apps` → 400 `缺少必填字段（app_secret）`，开放平台接入整体不可用。
- 根因：`052_open_api.sql` 建表时 `app_secret text NOT NULL`；但 053b/#4 之后代码只写 `secret_hash`（明文只在创建响应返回一次，不落库）。`pending-migrations/108` 的删列迁移一直未执行，schema 与代码契约相反。
- 修复：新增 `119_open_api_app_secret_nullable.sql`，只解除 NOT NULL（保留人工删列窗口，不双写明文）。
- 验证：创建应用 201（返回 key+secret 一次）→ 凭证调用开放 API 200 → 撤销 200 → 撤销后 403。
- 负控制：`src/test/platformWrites.test.ts` 断言 119 只 `DROP NOT NULL`、不 `DROP COLUMN`。

### D15（P1，已修复）平台租户列表的 LLM 授权永远显示 false

- 现象：`PUT /platform/tenants/:id/llm {enabled:true}` 返回 200，但 `GET /platform/tenants` 仍 `llm_enabled=false`（写成功、读永远失败）。
- 根因：`tenant_settings` 启用 RLS（`tenant_id = app_tenant_id()`），平台查询走应用连接、无租户 GUC ⇒ LEFT JOIN 恒为空。
- 修复：`120_platform_tenant_llm.sql` 增加 SECURITY DEFINER 函数，仅暴露 `tenant_id + llm_enabled`；平台列表改 JOIN 该函数（单一数据源，不复制状态）。
- 验证：开启后读回 `true`，关闭后 `false`。
- 负控制：`platformWrites.test.ts` 钉死 SECURITY DEFINER / search_path / 授权范围，并禁止路由回退直连 RLS 表。

### D16（P1，已修复）平台新开租户无法建单

- 现象：经 `POST /platform/tenants` 开通的新租户，管理员登录成功，但第一条工单/报修直接 422 `DEPARTMENT_UNRESOLVED`。
- 根因：开通事务只复制分类/流程/管理员，从未创建 `dept`，也没有任何提示；`resolveDepartment` 找不到默认部门就拒绝所有建单。
- 修复：`provisionNewTenantContent` 在开通事务内保证「至少一个默认部门」：无部门建「默认部门」，有部门则把第一个设为默认（幂等）。
- 过程缺陷（上线前被探针抓住）：初版写 `ON CONFLICT (tenant_id, code)`，但 `dept` 无该唯一约束 → 42P10 → 开通 500；已改为已确认零部门后直接 INSERT。
- 验证：新租户开通后 `today` 边界工单、SLA、志愿活动等业务探针全部可执行。
- 负控制：`src/test/tenantProvisionDefaultDept.test.ts`（无部门/有部门无默认/已有默认 三态）。

### D17（P3，已修复）模板应用到不存在租户返回误导性 409

- 现象：`POST /platform/templates/:id/apply {tenantId:"no-such-tenant"}` → 409 `DRAFT_STALE: expected version 0 but no def exists`。
- 根因：未先校验租户存在性，错误在 `saveWorkflowDef` 的版本检查处才暴露。
- 修复：进入租户事务前查 `tenant_registry`，不存在直接 404 `tenant not found`。
- 负控制：`src/test/templateApplyTenant404.http.test.ts`（404 且不进入租户事务）。

## 3. 测试资产修复

- `pilot-nonfunctional-e2e.mjs`：假清理（应用账号无权 `session_replication_role`，失败仍打印 cleaned）→ 改 `sudo -u postgres` + `ON_ERROR_STOP`。
- `pilot-platform-monitor-e2e.mjs` / 新平台探针：清理必须按本轮临时账号/手机号/应用/模板精确删除，不能 `LIKE '199%'` 误伤真实试用申请。
- `pilot-uat-all-modules-e2e.mjs`：平台审计 append-only，测试动作会留在 `platform_audit`；清理补 `DELETE ... WHERE target_tenant=<uat>`。
- 清理历史残留：`e2e_pf_pt1/pt3` 平台账号、`E2E-APP-pt3`、`E2E-TPL-*` 模板、2 条 UAT 审计 —— 已归零。

## 4. 平台写闭环覆盖明细

| 域 | 覆盖 | 结果 |
|---|---|---|
| 平台认证 | 空 body/错密码/无 token/篡改 token/改密/新旧密码 | PASS |
| 租户生命周期 | 登记、重复登记 409、非法 ID 422、停用/待开通登录 403、恢复可登录、非法状态 422、不存在 404 | PASS |
| 租户配置 | LLM 开关读回、点位新增/列表、报修人新增/手机号校验 | PASS |
| 试用申请 | 提交、列表、通过建租户（201）、重复审核 409、缺 tenant_id 422、驳回、重复驳回 409、不存在 404 | PASS |
| 开放应用 | 创建、凭证调用、低权限按租户汇总 403、错 secret 401、无凭证 401、撤销、撤销后 403、缺字段 422 | PASS |
| 模板市场 | 列表、平台新建（默认 published）、应用到租户（201）、24h 重复 409、不存在租户 404、详情、UGC 提交/通过/重复审核/驳回、匿名 401 | PASS |
| 审计 | 列表、动作可见、分页上限、注入参数 | PASS |

## 5. 时间边界覆盖明细

| 场景 | 断言 | 结果 |
|---|---|---|
| `today=1` 上边界 | 本地 00:00:30 创建的工单**计入** | PASS |
| `today=1` 下边界 | 昨日 23:59:30 创建的工单**不计入** | PASS |
| date-only 存储 | `scheduled_at:"2026-11-30"` 读回本地日期仍为 **2026/11/30**（ISO 为 11-29T16:00Z，属正确 UTC 表示） | PASS |
| 月报边界 | 10/31 23:30+08 只出现在 2026-10；11/1 00:30+08 只出现在 2026-11 | PASS |
| SLA 逾期 | `sla_due_at` 已到期计入 `overdue_total`；未到期不计入 | PASS |
| 志愿签到宽限 | 活动结束 2 天内可签到（200）；结束 4 天拒绝（409） | PASS |

## 6. 迁移与部署

```text
119_open_api_app_secret_nullable.sql   ALTER TABLE open_api_app ALTER COLUMN app_secret DROP NOT NULL
120_platform_tenant_llm.sql            CREATE FUNCTION platform_tenant_llm() SECURITY DEFINER
_migrations                            已登记 119 / 120
部署                                    dist 已更新，youfu-pilot.service active，/health/ready ready
```

## 7. 仍未覆盖 / 建议

- 平台端「暂停租户」对**在线会话**的即时失效（当前只拦截新登录；JWT 未按租户状态实时校验）——建议下一轮专项验证并决定是否加中间件。
- 模板应用后的业务效果回写（24h 指标刷新）只验证了接口成功，未等窗口跑完做前后对比。
- 真机与小程序端上交互仍按既定范围不测。
