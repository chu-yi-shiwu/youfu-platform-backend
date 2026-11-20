# 设计要求 vs 代码实现 · 对齐审查（2026-11-07）

> 审查范围：首批试点模块（维修工单、运送/陪检、巡检、巡更、设备/资产、志愿者）
> + 账号权限、通知、迁移部署、可观测性、前端/小程序。
>
> 设计要求基线：
> - `优服家_全量通读审查报告_20261101.md`（P0/P1 与设计资产）
> - `优服家_全局审查与总体开发优化计划_20261107.md`（P0 清单与试点边界）
> - `docs/endpoint-permission-matrix.md`（权限/可见性单一事实源）
> - `docs/runbook.md`、`docs/pilot-initialization-checklist.md`（G1 执行口径）
>
> 实现基线：当前工作区 `src/`、`src/test/`、`youfu_frontend_dev/src`、`youfu_mp`，
> 以及 2026-11-07 云上只读核验与隔离试点实测。
>
> 状态：✅ 已对齐　🟡 部分对齐/有边界　❌ 未对齐　⚪ 明确后置/不在首批

> **2026-11-07 范围更正（用户确认）**：移动端试点只上**小程序**，H5 应用不进入计划。
> 因此本文件把前端拆清：
> - `youfu_mp/` = 小程序（试点移动端，**阻断项以它为准**）；
> - `youfu_frontend_dev/src/` = **PC 管理端**（不是 H5；是否需要用于试点后台配置待确认）；
> - `youfu_frontend_dev/h5/` = H5 移动端（用户明确不进入试点，其专项问题不纳入首批阻断）。
>
> 下文中标注“PC 管理端”的契约问题，仅在“试点使用 PC 后台”时才是阻断；若试点只走
> 小程序 + 后台 API，则降为后置。此前把 `src/pages` 统称为 H5 是不准确的。

---

## 一、总览

| 维度 | 状态 | 结论 |
| --- | --- | --- |
| 账号/权限/提权链 | ✅ | 三个建号入口、角色分配、密码重置边界已收口；有回归测试 |
| 工单可见性/抢单 | ✅ | worker/operator 派了才可见；抢单服务端定 assignee；有测试 |
| 工单流转归属 | 🟡 | worker 只能操作本人单、不可改派；但默认 def 仍有 12 条边无角色/权限门，operator/admin 仍宽 |
| 运送/陪检 | 🟡 | 流转 requiredFields/allowedPerms/字段名已对齐；拍照“无照片跳过”仍未做 |
| 巡检 | ✅ | 读侧本人/权限、详情本人+待认领、流转角色/权限/必填均已落地 |
| 巡更 | ✅ | 读侧本人、checkin/miss 归属、点位归属、终态 409 均有测试 |
| 设备/资产 | ✅ | 搜索按字段类型生成；写侧权限；资产导出权限分离 |
| 志愿者 | 🟡 | slots 默认 1、截止校验、行锁、名额并发已对齐；取消/我的报名/user_id 绑定按决定后置 |
| 通知 | 🟡 | 站内信身份收口、运送孤儿分流已对齐；外部通道投递时机/重试后置 |
| 迁移/发布 | 🟡 | 本地 116 迁移可重建、fail-closed、隔离试点 116/116；云上仍是 117 条旧账 + 旧 dist |
| 可观测性/健康 | ✅ | `/health/ready`、访问日志、request_id、优雅停机已落地；云上旧版未部署 |
| 小程序环境 | 🟡 | 运送拍照已补相册；`BASE_URL` 已收敛到 `config.js`，pilot 构建只需改一处；微信后台合法域名仍需登记 |
| PC 管理端登录/租户 | ✅（本轮修） | 默认租户改为空 + 必填；前端 240/240；仅在使用 PC 后台时相关 |
| 文档与实现 | 🟡 | 新 runbook/矩阵已对齐；旧 `pilot/PILOT_RUNBOOK.md` 已加过期提示 |

**总体判断：核心 P0 权限/可见性/运送流转门禁已对齐；但“拍照无跳过”、小程序 pilot 配置、PC 管理端契约（若使用）和云上部署仍未对齐。不能宣称“设计与代码已完全对齐”。**

### P0 清单逐项对照（来自 11-01 全量审查）

| 编号 | 设计问题 | 当前实现 | 状态 |
| --- | --- | --- | --- |
| A-1 | 站内信全租户可读 | 身份集合 + 缺省过滤 | ✅ |
| A-2 | 账号三跳提权 | 三入口 `canAssignRole` + 角色矩阵拦截 | ✅ |
| A-3 | 工单流转不校验归属 | worker assignee 守卫；operator 按既定决策不受限 | 🟡 |
| A-4 | 抢单可指定 assignee | 服务端 `assignee` 覆盖客户端 | ✅ |
| A-5 | 基础数据/巡检/通知批量出口 | basicData 敏感类型 `basicdata.edit`；巡检/通知读侧收口 | ✅ |
| A-6 | 登录默认演示租户 | 前端默认改为空 + 必填（本轮修） | ✅ |
| B-1 | 新业务流审批 409 | submit 锚定提交时 live 版本 | ✅ |
| B-2 | 巡检 def 门禁不生效 | 巡检 `transitionTask` 已消费角色/权限/必填 | ✅（巡检） |
| B-2' | 运送 def 门禁不生效 | requiredFields + `allowedPerms` 已消费，`assignee→carrier`/`track.note` 归一化 | ✅ |
| B-3 | 运送通知被孤儿过滤 | entity_type 分流 | ✅ |
| B-4 | 免登录报修配额恒 0 | 租户连接计数 | ✅ |
| B-5 | 结算只在已评价触发 | 未改（结算不在首批） | ⚪ |
| B-6 | 053b/053c/a1/105 迁移错位 | 本地 106/107 + pending 105/108 + fail-closed；云上待部署 | ✅（本地）/🟡（云） |
| C-1 | 运送强制拍照无兜底 | 已补相册；无“跳过” | 🟡 |
| C-2 | 应急关联预案不可用 | 未改（应急不在首批） | ⚪ |
| C-3 | 报表分类显示 uuid | 未核/未改（报表不在首批） | ⚪ |
| C-4 | 设备搜索/应急 500 | 已修 | ✅ |
| D-1/D-3 | webhook 事务内/无重试 | 未改（开放 API 不在首批） | ⚪ |
| D-2 | 通知队列无定时投递 | 未改（外部通道后置） | ⚪ |
| D-4 | `/health` 不查 DB | `/health/ready` 已加 | ✅ |
| D-5 | 无优雅关闭 | SIGTERM/SIGINT + drain | ✅ |

> 状态说明：⚪ 不代表“永远不做”，而是按用户已确认的首批范围和后置决定，不计入本轮对齐缺口。

> 本轮顺手修正（低风险、已回归）：
> - `youfu_frontend_dev/src/pages/Login.tsx`：默认/兜底租户 `t-verification` 改为空 + 必填，
>   避免误登演示租户；前端 `tsc -b`/`vite build` 通过，28 文件 / 240 用例全绿。
> - `youfu_frontend_dev/src/components/MobileEntryModal.tsx`：H5 登录地址由写死主站改为
>   当前站点同源（可用 `VITE_H5_LOGIN_URL` 覆盖），避免 pilot 用户被带回旧环境。
> - `youfu_mp/pages/worker/transport/transport.js`：运送凭证拍照从仅相机改为
>   `camera+album`，相机被拒时可用相册已有照片；小程序 36/36 测试通过。
> - `youfu_mp/pages/login/login.js` + 巡检/运送页：登录 redirect 保留来源页与 id，
>   修复“登录后回不到原任务/详情空白”。
> - `youfu_mp/pages/worker/task-detail/task-detail.js`：备注按 `requiredFields` 映射到
>   `*_reason`，修复退回/挂起必填字段 422。
> - `src/routes/transport.ts`：运送 `transitionOrder` 消费 `requiredFields`，并把
>   `assignee→carrier`、`track.note→note` 归一化；门禁改为 `allowedRoles ∪ allowedPerms`；
>   `transportGuard` 16/16。
> - H5 `InspectionPage.tsx`：完成动作改走 `/inspection/tasks/:id/complete`，不再让
>   `records` 被通用 transition 丢弃。
> - `src/routes/asset.ts`：`sno` 改为 nullable，修复 `has_sno=false` 时资产编辑必 400。
> 这些不改变后端契约；F1 已收口，F2 的小程序 pilot 构建仍只差改 `config.js` + 微信域名。

---

## 二、已对齐（有代码/测试证据）

### 2.1 账号与权限

| 设计要求 | 实现 | 证据 |
| --- | --- | --- |
| `POST /accounts` 省略 role 不得绕过层级校验 | `targetRole = b.role ?? 'operator'` 无条件 `canAssignRole` | `accounts.ts:429-433`；`accountRoleEscalation.http.test.ts` 14/14 |
| `/auth/users`、`/invites` 同口径 | `/auth/users` 目标角色默认 operator；`/invites` 同；dev 旁路仅 `/auth/users` | `auth.ts:203-207`、`invite.ts:107-109`；矩阵文档 §1 |
| 不能给自己角色加权限 / 非 admin 不能授予 `role.manage` | `accounts.ts:159-176` 自角色与 role.manage 双重拦截 | `accountsPerm` 等测试 |
| 重置密码严格高于目标层级 | `canResetPasswordOf` 用 `<` 而非 `<=` | `role.ts:532-535` |
| `role_permission` 整角色覆盖 | 文档与代码一致（有行即覆盖，不是追加） | `role.ts:582-592`；矩阵 §0 |

### 2.2 工单可见性与抢单

| 设计要求 | 实现 | 证据 |
| --- | --- | --- |
| 师傅 = worker/operator；派了才可见；未分派只走抢单大厅 | `MASTER_ROLES=['worker','operator']`；列表/详情按 assignee | `workOrder.ts:82`；`workOrderMasterVisibility.http.test.ts` |
| 抢单 assignee 必须服务端决定 | `fields: { ...p.fields, assignee: realWorkerId }` | `claimWorkOrder.ts:83-90`；`claimAssigneeServerWins` |
| 抢单并发 | `findOneForUpdate` 行锁 | `claimWorkOrder.ts:49` |

### 2.3 巡检

| 设计要求 | 实现 | 证据 |
| --- | --- | --- |
| worker 列表强制本人档案集合；无档案空列表 | `resolveWorkerIds` + `assignee = ANY` | `inspection.ts:330-342` |
| 详情：本人单或未指派 pending | 详情归属校验 | `inspection.ts`；`inspection.http.test.ts` 33/33 |
| 流转消费 `allowedRoles/allowedPerms/requiredFields` | `transitionTask` 同口径 | `inspection.ts`；`transitionEntityGuards` |

### 2.4 巡更

| 设计要求 | 实现 | 证据 |
| --- | --- | --- |
| worker 列表/详情仅本人；非 worker `patrol.manage` | 读侧守卫 | `patrol.ts:101-147`；`patrolGuard` 14/14 |
| checkin/miss 归属 + 点位归属 + 终态 409 | `assertPatrolTaskActor` + point 校验 | `patrol.ts:173-188`；`patrolGuard` |
| 无抢单大厅 | 未指派对 worker 403 | 同上 |

### 2.5 通知与设备

| 设计要求 | 实现 | 证据 |
| --- | --- | --- |
| 通知列表按身份集合；不得回落全租户 | `auth.userId ∪ resolveWorkerIds`；缺省过滤 | `workOrder.ts:838-900`；`notificationsListScope` |
| 运送通知按 `payload.entity_type` 分流，两分支对齐租户 | `notificationOrphanGuardSql()` | `notificationVisibility.ts`；`notificationOrphanFilter.pglite` 6 |
| 设备搜索 uuid/date/numeric 不 500 | `equipmentSearchExpr()` 按字段类型 `::text` | `equipment.ts`；`equipmentPerm` |
| 应急 level 筛选不 500 | `a.` 别名 + JOIN 租户对齐 | `emergency.ts`；`emergencyPerm` |
| 免登录报修日配额生效 | 计数走 `withTenantClient` | `publicReport.ts`；`publicReport.http` 17/17 |

### 2.6 可观测性/迁移

| 设计要求 | 实现 | 证据 |
| --- | --- | --- |
| `/health/ready` 探 DB | `SELECT 1`，503 失败 | `server.ts:141-147` |
| 结构化访问日志 + request_id | `accessLogMiddleware`；500 日志关联 | `accessLog.ts`；`accessLog.test.ts` 8/8 |
| 优雅停机 | SIGTERM/SIGINT + 连接池 drain | `server.ts` |
| 迁移命名 fail-closed + 加法/破坏性分离 | `migrationFiles.ts` 严格正则；105/108 在 pending | `migrationFiles.ts`；`releaseGate` |
| 全新库可重建 | 隔离试点 `youfu_pilot` 116/116 | `backend-full-1107h.log`；云上 §9 |

---

## 三、未对齐 / 部分对齐（按优先级）

### ✅ F1. 运送流转：requiredFields + allowedPerms 已对齐

设计要求（`TRANSPORT_DEF`）：

- `dispatch` 边要求 `assignee`；
- `exception` 边要求 `note`；
- `dispatch` 边声明 `allowedPerms:['dispatch.override']`。

**本轮已修**：

- `transitionOrder()` 消费 `tdef.requiredFields`，并把 `assignee→carrier`、`track.note→note` 归一化后校验；
- 手工派单同时接受 `fields.carrier` 与 `fields.assignee`，统一落 `carrier`；
- 门禁改为严格的 `allowedRoles ∪ allowedPerms`：角色/权限点任一命中放行；两者都为空才是默认开放边；
- 手工 transition 路由在事务内读取 `listPerms` 并传入；
- `transportGuard` 16/16：缺 note→422、带 note→200、dispatch 传 assignee→carrier、
  仅 `dispatch.override` 放行、无该权限点→403。

**边界**：系统动作（auto dispatch）仍显式 `systemAuto:true` 跳过人类角色/权限门，但拓扑/必填/副作用不跳。

### 🔴 F1a. PC 管理端抢单大厅传 `workerId` 必被 403

> **范围说明**：F1a~F1i 均来自 `youfu_frontend_dev/src`（PC 管理端）。若试点只使用小程序 +
> 后台 API、不使用 PC 后台，这些不是首批阻断项；若用 PC 做派单/配置，则按下列优先级修。

- H5：`TicketList.tsx:242` / `Dashboard.tsx:271` 调
  `POST /open/work_order/:id/claim` 并带 `{ workerId }`；
- 后端：`workOrder.ts:1276-1279` 只接受“token 身份 == body.workerId”，否则 403；
  H5 登录 token 的 `sub` 是 `account_user.id`，而选择框给的是 `worker.id`（业务编码）
  ⇒ 管理端“代抢/指派式认领”100% 失败。
- 小程序不带 body 的自助认领路径正常。

建议（产品先拍板）：H5 抢单只允许“本人认领”（不传 workerId），管理端改用
`/open/work_order/:id/transition` 的 dispatch/assignee 流程；或后端对
`admin/dispatch.override` 放行并按 `worker.id` 反查。禁止继续让前端传另一个 worker 的 id。

### 🔴 F1b. H5 巡检“完成”携带的 `records` 曾被静默丢弃（本轮已修）

- 原 H5：`InspectionPage.tsx:412-426` 把 `records` 放进通用 `/transition`；
- 后端：`inspection.ts:631-633` 的 transition 白名单只有 `note/geo_lat/geo_lng/done_at/photos`，
  `records` 会被丢掉；专用 `/complete` 才 `upsertRecords`（`inspection.ts:493-527`）。
- 本轮已改为：`event==='complete'` 时调用 `/inspection/tasks/:id/complete`，其余仍走 transition；
  前端 `tsc`/build/240 用例通过。

### 🔴 F1c. 资产编辑 `sno:null` 必 400（本轮已修）

- H5：`AssetPage.tsx:159` 在 `has_sno=false` 时传 `sno:null`；
- 后端原 schema `asset.ts:29` 是 `z.string().optional()`，`null` 直接 400。
- 本轮后端改为 `z.string().nullable().optional()`，允许清空序列号；`tsc --noEmit` 通过。

### 🟡 F1d. 工单列表分页 `cursor` 后端不支持

- H5 `TicketList.tsx:269-275` 发 `cursor` 并按 `data.cursor` 判断 `hasMore`；
- 后端 `workOrder.ts:614-615` 只有 `limit/offset`，返回无 `cursor` ⇒ 超过 50 条后永不加载更多。
- 建议前端改 `offset/total`，或后端补 cursor 契约；试点数据量小，但属于真实契约断裂。

### 🟡 F1e. 新建账号 `phone/active` 被 zod 静默丢弃

- H5 `FoundationPage.tsx:363-371` 发送 `phone/active`；
- 后端 `accounts.ts:60-66` 的 `accountCreateSchema` 没有这两个字段，zod 默认剥离；
  `active:false` 仍建成启用状态。
- 建议补 schema + INSERT，或前端停止发送；试点账号信息不完整会影响通知/停用。

### 🟡 F1f. 首页/工单列表状态字典与 `workflow_def` 脱节

- `Dashboard.tsx:41-59/87-88`、`TicketList.tsx:36-63` 硬编码 `created/transporting/...`，
  缺 `arrived`，把 `draft` 排除在待处理外；
- 后端真实状态 `stateMachine.ts:114-136` 无 `created`。
- 影响：首页“待处理/进行中”计数偏低、下钻筛选恒空。
- 建议：状态集合从 `GET /workflow-defs/work_order` 的 `states/available` 派生。

### 🟡 F1g. 动作按钮未按 `allowedPerms` 过滤

- 后端 available 只下发 `allowedRoles`（`workOrder.ts:750-757`），引擎实际还校
  `allowedPerms`（`inspection.ts:53-61`）；
- H5 `api/templates.ts:93-97` 只看角色；小程序 `task-detail.js:82-96` 渲染全部 available。
- 影响：工人可见无权动作，点击 403；租户只授权限点的边在 H5 不显示。
- 建议：available 增加 `allowedPerms`，两端统一“角色 ∪ 权限点”过滤。

### 🟡 F1h. 设备维保后端有端点，前端/小程序零入口

- 后端 `equipment.ts:157-245` 提供 `GET/POST/PUT/DELETE /equipment/:eqId/maintenances`；
- H5 `EquipmentPage.tsx` 无调用，资产页用的是 `/assets/:id/maintenance`；小程序无设备模块。
- 影响：设备档案只能维护静态信息，维保记录闭环缺失。首批“设备/资产”验收前应补入口，
  或明确该能力未启用。

### 🟡 F1i. 服务台删除：页面有入口，后端无路由

- H5 `AdminPage.tsx:120-131` 调 `DELETE /service-desks/:id`；
- 后端 `serviceDesk.ts` 只有 GET/POST/PUT。
- 服务台不在首批五个模块内，标为 P1/后置；要么补 DELETE（含在途工单保护），要么移除入口。

### ✅ F1k. PC 工作台卡片未应用全局服务台/部门筛选（本次已修）

- 现象：工作台显示待处理 8、超时 12，点“超时待办”进工单列表却是 0；
- 根因：`Dashboard.tsx` 的 `stats` 遍历 **未过滤的 `items`**，而列表使用了全局筛选
  `filtered`（截图里服务台=志愿者服务台）⇒ 卡片是全量、列表是筛选后；
- 修法：`stats` 改为遍历 `filtered`，依赖 `[filtered]`；前端 `tsc`/build/240 用例通过。
- 说明：`/stats` 的派单命中率/撤销率等仍是服务端全量历史口径，卡片 tooltip 已写明，不与服务台筛选联动。

### 🟡 F1j. 后端默认租户兜底仍是 `t-verification`

- `auth.ts:24` + `middleware/auth.ts:36` 在租户缺失时回落 `t-verification`；
- H5 两条登录路径都强制传 tenant，正常不可达；但 API 直调/旧客户端仍可能误登验证租户。
- 建议：prod 下租户缺失直接 400/401，不再回退演示租户。

### 🟡 F2. 小程序 BASE_URL 环境配置（本轮已修）

- 原 `youfu_mp/app.js:14` 写死 `https://youfu.banerz.cn`，`utils/api.js:25` 同样兜底；
- 本轮新增 `youfu_mp/config.js`：`BASE_URL/API_PREFIX/ENERGY_API_BASE` 收敛到唯一文件，
  支持 `wx.getExtConfigSync()` 与 `wx.setStorageSync('youfu_mp_base_url', ...)` 覆盖；
  `app.js` 改为 `require('./config.js')`。
- pilot 构建只需把 `config.js` 的 `BASE_URL` 改为 `https://youfu.banerz.cn/pilot`（或在真机 storage 覆盖），
  并到微信后台登记合法域名；不要改页面代码。
- **2026-11-07 已执行**：从 `youfu_mp` 复制 `youfu_mp_pilot`，config 指向 `/pilot`；
  微信开发者工具 CLI preview + upload v5.9.13 成功（包 550.6KB）；主域名已在白名单，无新增域名。

**本轮已修（小程序）**：

- `pages/login/login.js` 现在读取 `options.redirect`，登录成功后优先回来源页；巡检/运送页把
  `id` 一起带入 redirect，修复 M05/M26「登录后回不到原任务/详情空白」；
- `pages/worker/task-detail/task-detail.js` 按 `requiredFields` 把备注映射到
  `return_reason`/`suspend_reason`/`close_reason`，避免退回/挂起被 422；
- `pages/worker/transport/transport.js` 补 `camera+album`。
- 小程序 `node --test utils/*.test.js` 36/36 通过。

**仍存（小程序 P1）**：多必填字段仍只有一个备注输入框；`app.globalData` 裸访问等卫生问题。
（“受理台 limit 200、详情靠列表 find”属于 PC 管理端，不计入小程序阻断。）

### 🟡 F3. 默认工单 def 仍有 12 条无角色/权限门

`RICH_WORK_ORDER_DEF` 32 条边中 12 条无 `allowedRoles`/`allowedPerms`：

- `draft→assigned`、`assigned→processing`、`processing→completed`、`assigned→pending_dispatch`、
  `processing→paused`、`paused→processing`、`processing→suspended`、`suspended→processing`、
  `review_passed→completed`、`completed→closed`、`closed→evaluated`、`draft→claim_hall`。

现状：

- worker 已被 `ticket.ts:266-276` 的 assignee 守卫收口；
- operator/admin 仍可对任意单执行这些边；
- def 级没有“角色/权限门”，与“客户可配置审批门”的设计意图仍有差距。

建议：产品确认 operator 是否应受 assignee 限制；若不应，至少在文档中明确“operator 是管理纠正身份，
不受派单归属限制”，并把 12 条边标注为“默认开放边”，避免被误读为漏配。

### 🟡 F3b. 师傅无 worker 档案时降级放行（设计已记录，但试点初始化必须避免）

`workOrder.ts:633-643`：worker/operator 查不到 worker 档案时，`console.warn` 后**放行全量**，
理由是一线可用性优先。这是设计明确的边界，不是意外漏洞；但试点初始化必须保证：

- 所有 operator / worker 账号都通过 `POST /workers/with-account` 或 `PUT /workers/:id` 绑定档案；
- 上线前跑 `pilot-preflight`，`worker.binding` 不得是 `[WARN]`（未建档案）或 `[FAIL]`（错绑）。

否则 operator 登录会看到全租户工单，与“派了才可见”的设计直接冲突。

### 🟡 F4. 前端登录默认租户（本轮已修）

- 原 `Login.tsx:27,60` 默认/兜底 `t-verification`；
- 已改为空值 + 必填，并更新提示文案；
- 前端 `tsc -b`、`vite build`、240/240 测试通过。

剩余：`youfu_mp` 的 `org` 是动态的，无默认演示租户；后端 `DEFAULT_LOGIN_TENANT` 在试点 `.env` 为空，
但现网旧 `.env` 仍是 `t-verification`（环境问题，不是代码）。

### 🟡 F5. 运送拍照仅补了相册，未做“跳过/兜底提交”

- `youfu_mp/pages/worker/transport/transport.js:211` 已从 `['camera']` 改为 `['camera','album']`；
- 相机权限被拒时仍要求用户有已有照片；无照片时仍卡住；
- 设计报告 C-1 要求“无相册、无跳过”两个缺口都处理。

建议：产品确认是否允许“异常备注 + 无照片”提交；若允许，需后端 exception 边配合 requiredFields。

### 🟡 F6. 志愿者取消/我的报名/user_id 绑定

- `volunteer.ts` 有 `slots` 默认 1、`signup_deadline`、行锁、名额并发；
- 没有 `user_id` 绑定、取消报名、我的报名端点；
- 这是用户明确同意后置的范围，不算意外漏项，但设计上仍是缺口。

### 🟡 F7. 通知外部通道/队列时机

- `in_app` 已落库即可达；
- `sms/push/wechat` 仍是 stub；
- 定时任务产生的推送仍依赖下一次 HTTP `res.on('finish')`；
- 设计 P1 项，首批试点不阻塞，但验收不能把“delivery receipt”当真实触达。

### 🟡 F8. 云上部署与本地代码未对齐

- 云上 4001 仍是 10-30 旧 `dist`，`/health/ready` 404；
- 云上库 `_migrations` 117、含已执行 105、缺 109，`slots` 默认 0；
- 云上 `a1_dispatch_rules.sql` 原在根目录，已于 2026-11-07 移入 `seeds/`；
- 云上 `INVITE_SALT` 已补配并重启旧服务；`APP_SECRET_SALT` 未设，8 个 `open_api_app` 需一起轮换；
- 现网 Node16/CentOS7，正式试点应走新 OS/Node22（方案 B）。

### ⚪ 明确后置/不在首批

- 结算触发（B-5）、应急关联预案（C-2）、报表机构 UUID（C-3）——不在首批模块；
- webhook 事务内投递/重试（D-1/D-3）、通知 outbox（D-2）——开放 API/外部通道后置；
- 任务调度/模型训练等非试点链路未纳入本次对齐。

---

## 四、结论

1. **权限/可见性/账号提权/巡检/巡更/通知/设备/可观测性：已对齐**，且有回归测试与隔离试点实证。
2. **运送流转已对齐**：requiredFields、`allowedPerms`、`assignee→carrier`、`track.note` 均已收口，`transportGuard` 16/16；剩余仅“拍照无跳过”（C-1）需产品确认。
3. **PC 管理端登录默认租户已修**；小程序 `BASE_URL` 已收敛到 `config.js`，pilot 构建只需改一处并登记微信合法域名。
4. **代码本地对齐 ≠ 云上对齐**：云上仍是旧版本、旧迁移账、旧运行时；正式试点必须按方案 B 重新部署。
5. 志愿者取消/我的报名、通知外部投递、webhook 等属于已确认后置项，不应算作“实现遗漏”，但要在验收口径中写明。
6. **PC 管理端契约仍有断裂（仅在使用 PC 后台时阻断）**：抢单传 `workerId` 会 403；
   工单 cursor、状态字典、动作权限过滤、账号 `phone/active` 等仍未对齐。巡检完成 `records`、
   资产 `sno:null` 本轮已修。小程序侧的登录回跳、必填映射、运送相册、BASE_URL 已在本轮收敛。

**建议下一步优先级：**

| 优先级 | 动作 |
| --- | --- |
| P0 | 小程序体验版已上传 v5.9.13（`/pilot` API）；真机扫码 + 基础数据后做 UAT |
| P0（仅用 PC 后台时） | 修 PC 抢单 `workerId` 契约；否则后置 |
| P1 | 明确 12 条默认开放边的产品口径（operator 是否受 assignee 限制） |
| P1 | 云上止血：旧站限制访问 + `APP_SECRET_SALT` 轮换方案 |
| P1 | 正式试点走方案 B（新 OS/Node22），按 G1 清单重做迁移/RLS/备份/UAT |
