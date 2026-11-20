# 试点安全审计报告（2026-11-11）

## 1. 范围

真实 pilot API + 真实库，覆盖：

- 跨租户、X-Tenant-Id 伪造；
- IDOR（读/改他人工单）；
- PII / 角色越权；
- JWT 篡改；
- SQL 注入；
- 上传路径穿越 / 类型 / 文件名；
- 公开 token 暴露面。

## 2. 新发现问题与修复

### P1：worker 可枚举全租户人员档案（手机号/账号关联）

**现象**

```text
GET /workers?active=1       → 200，返回全部 worker
GET /workers/HQ016          → 200，返回 phone=17773639019、account_id
```

`GET /workers` 原先没有权限守卫；任何登录账号（含 worker）都能读取全租户人员手机号和账号关联，属于 PII 泄漏。

**修复**

`GET /workers` / `GET /workers/:id` 增加：

```text
ticket.manage 或 dispatch.override
```

worker → 403；admin/operator/reviewer → 200；dispatcher → 200（派单需要）。

验证：

```text
worker GET /workers        → 403 permission denied: ticket.manage|dispatch.override
worker GET /workers/HQ016  → 403
```

---

### P1：worker 被误授 `flow.create`，可创建通用业务流任务

**现象**

worker 角色在 2026-11-10 被显式授予 `flow.create`（当时为了“报修”，实际 `intake.create` 才是报修权限）。结果是：

```text
POST /flow/cycle_check  → 201，创建 business_flow_tasks
POST /flow/transport_task → 403（原生运送表 RLS 拒绝，但仍属越权配置）
```

**修复**

从 `role_permission` 移除 worker 的 `flow.create`，保留：

```text
asset.scan / consumable.consume / inspect.execute / intake.create
```

验证：

```text
POST /flow/cycle_check      → 403 permission denied: flow.create
POST /flow/transport_task   → 403 permission denied: flow.create
```

报修建单仍走 `intake.create`，不受影响。

---

### P2：内部工单 token 可查“我的报修”，暴露内部工单详情

**现象**

为修复师傅照片/录音预览 401，所有工单创建时都会生成 `public_view_token`。但公开接口：

```text
GET /public/my-reports?tokens=<内部工单 token>
```

原实现只按 token 查 `work_orders`，会把后台/内部工单的标题、描述、位置、状态返回给公网。

**修复**

公开“我的报修”token 路径增加来源限制：

```sql
AND (source = 'public_report' OR ext->>'source_channel' = 'public_report')
```

验证：

```text
内部工单 token 查 /public/my-reports → 200，items=[]
公开报修单 token → 仍可正常查询
```

媒体读取不受影响（`/uploads` 仍支持 token）。

---

### P2：内部工单单号可查公开状态接口

**现象**

```text
GET /public/repair-status?org=zixing-hospital&order_no=<内部工单号>
→ 200，返回 title/location/status
```

公开状态查询原先只按单号查，不区分来源；后台/内部工单只要单号被知道，就能被公网查到。

**修复**

增加公开报修来源限制：

```sql
AND (source = 'public_report' OR ext->>'source_channel' = 'public_report')
```

验证：

```text
内部工单号 → 404
公开报修单号 → 200
```

---

### 数据完整性审计（只读）

检查项：

```text
默认部门数量 = 1
worker 部门/账号引用悬空 = 0
工单部门/承接人引用悬空 = 0
重复工单号 = 0
重复 public_view_token = 0
工单状态不在 workflow_def.states = 0
联系人空电话/重复 = 0
位置/目录重复 = 0
活跃工单缺 SLA = 0
```

发现并清理：

```text
ticket_event 孤儿 4 条（旧测试单删除后残留）
notification 孤儿 2 条
清理后：0 / 0
```

说明：孤儿来自早期测试脚本直接删工单、未删依赖表；现有 E2E 脚本已统一按依赖表清理。

---

## 3. 残留风险 / 建议

1. **内部工单 token 仍可读媒体**：若 PC 详情里的 token 被分享，持有者仍可读取该单照片/录音。token 是 48 位随机值，不可枚举；后续可拆 `media_view_token` 与 `public_view_token`，进一步隔离。
2. **`GET /flow/entities` 对 worker 仍 200**：只暴露实体类型名称，不含数据；风险低。若要求最小可见面，可加 `flow.create` 门禁。
3. **公开报修状态查询 `/public/repair-status` 按单号可查**：这是既有设计，单号随机；如需更严，可要求电话后 4 位或 token。
4. **人员档案读权限**：admin/operator/reviewer/dispatcher 可读手机号；这是派单/管理需要。后续可对列表做字段脱敏（手机号中间四位掩码），详情再按权限展开。

## 4. 回归与验证

```text
Security E2E：PASS
Role E2E：PASS
Media E2E：PASS
后端：203 文件 / 2449 用例
前端：30 文件 / 238 用例
PC Playwright：7 用例
releaseGate：5/5
```

新增安全断言：

```text
worker /workers → 403
worker /workers/:id → 403
worker /flow/cycle_check → 403
内部工单 token /public/my-reports → 不返回该单
```

## 5. 测试数据

所有临时工单/账号/文件已清理；真实工单未改动。  
24 小时 soak 的临时单「性能测试-0」仍在运行，带 `ext.perf_run` 标记，结束后自动清理。
