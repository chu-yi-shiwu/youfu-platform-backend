# 端点权限与可见性矩阵（试点冻结版）

> 适用版本：`youfu_backend_dev_v2` 2026-11-07（P0 收口后）
> 适用范围：资兴市人民医院单租户试点首批（维修 / 运送陪检 / 巡检 / 设备资产 / 志愿者）
> 目的：把「哪个角色能进哪个端点、看谁的数据、凭哪条权限点」钉成可复核的事实，
> 供试点初始化、租户授权、UAT 与回归测试对照。**改守卫必须同步改本文件与对应测试。**
> 配套：`docs/runbook.md`（部署/迁移/回滚）、`docs/pilot-initialization-checklist.md`（初始化与验收）。

---

## 0. 权限判定链（先看这里，避免误读下文）

所有 `requirePermission(auth, client, perm, entityType?)` 的判定顺序（`src/middleware/role.ts`）：

1. `auth.authMode === 'dev'` → **恒放行**（本地联调专用；生产必须显式 `AUTH_MODE=prod`）。
2. `auth.role === 'admin'` → **恒放行**（admin 拥有 `PERMS` 全集）。
3. 查 `role_permission WHERE tenant_id=? AND role=?`：
   - **有行** → 只用这些行作为该角色生效集合（**覆盖，不是追加**）；
     - 全局行 `perm` 命中 → 放行；
     - 传了 `entityType` 时，`perm@entityType` 命中 → 放行；
   - **无行** → 回退 `DEFAULT_PERM_MATRIX[role]`。
4. 其余 → `403 FORBIDDEN`。

> ⚠️ **试点配置红线**：`role_permission` 是「整角色覆盖」。一旦给某角色写了任何一行，
> 该角色的默认矩阵**全部失效**。授权时必须提交完整权限集合（前端权限页即按全集勾选后提交），
> 不能只补一条 `role.manage` 之类。否则会出现「本来能用的巡检/工单入口突然 403」。

### 0.1 角色层级（`ROLE_RANK`）

| 角色 | 层级 | 说明 |
| --- | ---: | --- |
| `worker` | 1 | 一线执行 |
| `dispatcher` / `service_desk` | 2 | 已退场角色（仅为存量账号可登录保留） |
| `reviewer` / `operator` | 3 | reviewer 与 operator 同层 |
| `admin` | 4 | 唯一最高层 |
| 租户自定义角色（`role_def`） | 1 | 与 worker 同层（`CUSTOM_ROLE_RANK`） |

角色分配门禁 `canAssignRole(caller, target)`：

- `caller === 'admin'` → 任意目标（含 admin）；
- 其他 caller → `target !== 'admin' && roleRank(target) <= roleRank(caller ?? 'worker')`；
- caller 缺失按 worker 层计（历史语义），不会变成 0 层放行。

### 0.2 账号操作门禁（比角色分配更严，防内鬼）

| 函数 | 用途 | 语义 |
| --- | --- | --- |
| `canOperateAccount(caller, targetRole)` | 改资料 / 停用 / 删除账号 | admin 任意；非 admin 仅能操作**层级不高于自己**的账号（`<=`） |
| `canResetPasswordOf(caller, targetRole)` | 重置他人密码 | admin 任意；非 admin 必须**严格高于**目标（`<`），同层同事也不行 |

> 为什么重置密码更严：拿到登录能力比改显示名严重一个量级；operator 与 reviewer 同层，
> 若允许同层重置，就能披着 reviewer 马甲绕过「自审自批」的 username 比对。

---

## 1. 账号 / 邀请域角色矩阵

三个入口都能「决定新账号的角色」，但历史实现口径不完全一致，**必须区分**：

| 端点 | 前置守卫 | 目标角色取值 | 调用者角色取值 | 是否受 dev 影响 |
| --- | --- | --- | --- | --- |
| `POST /api/v1/accounts` | `requirePermission('role.manage')` | `b.role ?? 'operator'` | `auth.role`（原样） | 守卫 dev 放行；**角色比较不看 dev** |
| `POST /api/v1/auth/users` | `requirePermission('role.manage')`（`requireAccountAdmin`） | `input.role ?? 'operator'` | `dev ? 'admin' : auth.role` | **dev 下调用者按 admin 计** |
| `POST /api/v1/invites` | `requirePermission('role.manage')`（`requireAdminAuth`） | `b.role ?? 'operator'` | `auth.role`（原样） | 守卫 dev 放行；**无 admin 旁路** |

### 1.1 关键行为

- **省略 role 不是旁路**：三个入口都按落库后的实际角色判定（默认 `operator`）。
  旧实现只在显式传 `role` 时校验，导致持 `role.manage` 的 worker/自定义角色可以建出 operator。
- **`role.manage` 默认只有 admin**（`defaults: []`，admin 经全集自动拥有）。
  operator 只有在租户显式授予 `role.manage` 后才能进这三个入口；即使授予，也不能创建 admin。
- **`role.manage` 不能由非 admin 授予**：`PUT /accounts/roles/:role/permissions`
  对非 admin 提交包含 `role.manage` 的集合直接 403，防止「一次授权变可复制提权」。
- **入库前角色存在性**：`POST /accounts` / `POST /invites` 还要求
  `isRoleUsable(tenant, role)`（内置可用角色或本租户 `role_def` 启用中），
  否则 400 `BAD_PARAM`；邀请码还会拒绝退场角色，避免兑换时静默 fallback 成 operator。
- **账号资料/密码的重置边界**：见 §0.2；`PUT /accounts/:id`、`POST /accounts/:id/reset-password`、
  `DELETE /accounts/:id` 均先过 `role.manage`，再过 `canOperateAccount` / `canResetPasswordOf`。

### 1.2 `canAssignRole` 结果表（调用者 × 目标角色）

| 调用者 \ 目标 | worker | 自定义角色 | dispatcher / service_desk | reviewer / operator | admin |
| --- | :---: | :---: | :---: | :---: | :---: |
| admin | ✅ | ✅ | ✅ | ✅ | ✅ |
| operator / reviewer | ✅ | ✅ | ✅ | ✅ | ❌ |
| dispatcher / service_desk | ✅ | ✅ | ✅ | ❌ | ❌ |
| worker / 自定义角色 | ✅ | ✅ | ❌ | ❌ | ❌ |
| 缺失 caller | ✅ | ✅ | ❌ | ❌ | ❌ |

> 读法：表里是 `canAssignRole` 的纯函数结果。
> **实际能否调用端点还要叠加 `role.manage`**：默认矩阵下只有 admin 能进；
> 非 admin 必须先被租户授予 `role.manage`（且授权行为本身只能由 admin 完成）。

### 1.3 dev 模式的差异（只允许本地/测试）

| 场景 | prod 行为 | dev 行为 |
| --- | --- | --- |
| `POST /accounts` with `X-Role: operator` 创建 admin | 403（canAssignRole） | **仍 403**（callerRole 取 `auth.role`，不因 dev 变 admin） |
| `POST /accounts` with `X-Role: admin` 创建 admin | 201 | 201（dev 默认 `X-Role` 就是 admin） |
| `POST /auth/users` with `X-Role: operator` 创建 admin | 403 | **201**（`callerRole = dev ? 'admin' : auth.role`） |
| `POST /invites` with `X-Role: operator` 开 admin 邀请码 | 403 | **仍 403**（无 dev 旁路） |

> 结论：dev 只应出现在本地/测试环境；`AUTH_MODE` 对未知值一律按 prod 处理（fail-closed）。
> 试点/生产环境必须显式配置 `AUTH_MODE=prod`，并确认启动日志没有 `AUTH_MODE=dev` 警告。

---

## 2. 首批业务域的读侧 / 执行侧口径

### 2.1 巡检（inspection）

权限点默认矩阵：

| 权限点 | 默认角色 | 用途 |
| --- | --- | --- |
| `inspect.view` | operator / dispatcher / reviewer / service_desk | 非 worker 的巡检查看 |
| `inspect.manage` | operator | 巡检计划/点位配置 |
| `inspect.execute` | operator / dispatcher / worker | 执行面（签到/提交等） |

读侧口径（`src/routes/inspection.ts`）：

| 端点 | worker | 非 worker |
| --- | --- | --- |
| `GET /inspection/tasks` | **不看权限点**；强制 `assignee ∈ resolveWorkerIds(本人)`；显式传 `assignee=他人` 被覆盖 | 需 `inspect.view`；可按 `assignee` 过滤 |
| `GET /inspection/tasks/:id` | 本人名下单；或 `assignee` 为空且 `status='pending'` 的可认领单 | 需 `inspect.view` |

> worker 不依赖权限点是有意设计：一线可用性优先，且服务端强制本人档案集合，
> 不会因为租户误删 `inspect.view` 导致工人看不到自己的单。
> 认领（`/claim`）单独走行锁 + `assignee` 非空 409，先到先得。

### 2.2 巡更（patrol）读侧与执行面

执行面（签到 / 漏签）：

| 操作 | worker | 非 worker |
| --- | --- | --- |
| `POST /patrol/tasks/:id/checkin` | 必须是任务 `assignee`（`resolveWorkerIds` 集合）；未指派任务一律 403 | 需 `patrol.manage`（默认 operator；可显式授予） |
| `POST /patrol/tasks/:id/miss` | 同上 | 同上 |

读侧（列表 / 详情，2026-11-07 收口）：

| 端点 | worker | 非 worker |
| --- | --- | --- |
| `GET /patrol/tasks` | **不看权限点**；强制 `assignee ∈ resolveWorkerIds(本人)`；显式 `assignee=他人` 只作提示、被服务端覆盖；无档案返回**空列表**且不发全租户查询 | 需 `patrol.manage`；可按 `assignee` / `status` 过滤 |
| `GET /patrol/tasks/:id` | 仅本人名下单可读；他人单 / 无档案 → 403 | 需 `patrol.manage`；可读任意本租户任务 |

补充约束：

- `point_id` 必须属于该任务的 `point_ids`，否则 422 `BAD_PARAM`；
- 已 `done` / `missed` 的任务先返回 409（状态冲突优先于点位校验）；
- 巡更没有「抢单大厅」，worker 不能自助认领未指派任务；
- `GET /patrol/points` 暂保持登录可读（小程序需要点位名称渲染）；写端点仍按 `patrol.manage`。

### 2.3 通知列表 / 已读（`/open/notifications*`）

- **身份集合** = `auth.userId ∪ resolveWorkerIds(auth.userId)`（双路：账号 id 与 worker 档案 id）。
- 缺省不带 `?recipient=` → 只查身份集合内的站内信（`channel='in_app'`）。
- `?recipient=` 只允许命中集合内身份，否则 **403**；身份集合为空 → **422 `IDENTITY_UNRESOLVED`**，
  绝不降级为全租户。
- 孤儿过滤（`src/repo/notificationVisibility.ts`）按 `payload->>'entity_type'` 分流：
  - `transport_order` → 只查 `transport_order`，且 `t.tenant_id = n.tenant_id`；
  - 缺省 / 其他 → 查 `work_orders`，且 `wo.tenant_id = n.tenant_id`。
- 业务含义：运送单通知借位存 `work_order_id`；旧实现只 `EXISTS work_orders` 会把整类运送通知
  当成孤儿丢弃，工人收不到派单/SLA 提醒。

### 2.4 设备搜索（`GET /equipment/:type?q=`）

- 读端点对已登录账号开放；写端点需 `equipment.manage`（默认 operator）。
- `q` 的搜索表达式按字段类型生成（`src/routes/equipment.ts` 的 `equipmentSearchExpr`）：
  - 文本列：直接 `col ILIKE $n`；
  - UUID / DATE / NUMERIC：先 `col::text ILIKE $n`，避免
    `operator does not exist: uuid ~~* unknown` 导致用户一搜索就 500。
- 已知非文本列：`equipment.type_id` / `vendor_id`（UUID）、`purchase_date`（DATE）、
  `price`（NUMERIC）。

### 2.5 应急预警列表（`GET /emergency/alerts`）

- 读端点对已登录账号开放；写端点分两个权限点：
  - `emergency.manage`（默认 operator）：应急预案库 CRUD；
  - `emergency.handle`（默认 operator）：预警创建 / 处置 / 关联预案 / 转工单。
- 列表筛选 `status` / `level` / `source_type` 必须带 `a.` 表别名：
  `alert` 与 `emergency_plan` 都有 `status/level`，JOIN 后不加别名会
  `column reference "level" is ambiguous` → 500。
- `LEFT JOIN emergency_plan` 必须同时对齐 `p.tenant_id = a.tenant_id`，防跨租户预案标题串入。

---

## 3. 试点初始化注意事项

1. **先建管理员，再建业务账号**：试点首号必须是 admin；后续 operator/worker 由 admin 创建或邀请。
2. **绑定 worker 档案**：`POST /workers/with-account` 会同时建 `worker` 与 `account_user`，
   并写 `worker.account_id`。试点工人必须完成绑定，否则「我的工单 / 巡检 / 通知」按
   `resolveWorkerIds` 解析不到本人，读侧会 403 或收件箱为空。
   - `worker.account_id` 是 text，`account_user.id` 是 uuid；查询侧已用 `au.id::text` 对齐，
     初始化脚本不要自行做隐式类型比较。
   - 上线前运行 `npm run preflight -- --tenant=<tenant_id>`：
     任一 `[FAIL]`（未绑定/错绑、迁移记账不完整、租户非 active、无 admin、RLS 未开）不得进入验收。
3. **不要手写 `role_permission` 单行**：见 §0 的覆盖语义；用权限页提交完整集合。
4. **`AUTH_MODE=prod`**：试点环境禁止 dev；否则所有权限门恒放行。
5. **通知投递时序**：`in_app` 落库即可达；`sms/push/wechat` 目前是 stub 投递凭证，
   不代表真实触达。试点验收不要把「有 delivery receipt」当成「用户已收到」。

---

## 4. 回归护栏索引

| 主题 | 测试文件 |
| --- | --- |
| 账号角色提权（含 dev 差异） | `src/test/accountRoleEscalation.http.test.ts` |
| 账号域权限（`role.manage` / 越权） | `src/test/accountsPerm.http.test.ts` |
| 巡检读侧 / 流转 / 认领 | `src/test/inspection.http.test.ts` |
| 巡更读侧 / 签到 / 漏签守卫 | `src/test/patrolGuard.http.test.ts`、`src/test/materialPatrolFeedback.http.test.ts` |
| 通知列表越权 + 孤儿分流 | `src/test/notificationsListScope.http.test.ts`、`src/test/notificationOrphanFilter.pglite.test.ts` |
| 通用业务流门禁 | `src/test/transitionEntityGuards.test.ts` |
| 设备 / 应急权限与筛选 | `src/test/equipmentPerm.http.test.ts`、`src/test/emergencyPerm.http.test.ts` |
| 志愿者活动报名并发 / 默认名额 | `src/test/volunteer*.test.ts`、`src/test/migration109.pglite.test.ts` |

---

## 5. 维护纪律

- 新增/修改权限点：同时更新 `PERM_DEFS`（单一事实源）、本文件、至少一条 403/放行断言。
- 新增端点：在本文件登记「守卫 + 数据范围 + dev 差异」；无守卫的公开端点必须显式写「公开」。
- 改动 `canAssignRole` / `canOperateAccount` / `canResetPasswordOf` / `hasPerm`：
  本文件 §0、§1 必须同步，且跑对应 HTTP 测试与全量 typecheck。
- 本文件不替代代码：出现冲突时以代码与测试为准，并立即回写本文件。
