// src/engine/flowProxy.ts —— T5 代理层：`/flow/:entityType` 代理到各业务的**原生表**。
//
// ─────────────────────────────────────────────────────────────────────────────
// 【背景：为什么要有这一层】
//   后端存在「**异表双轨 + 双入口**」：
//     · 运送原生路由   `routes/transport.ts`     读写 **`transport_order`**
//     · 通用业务流通道 `routes/businessFlow.ts`  读写 **`business_flow_tasks`**
//       （entity_type = `transport_task`）
//     · 前端两个入口并存且都可达：`TransportPage.tsx` 调 `/transport/orders*`；
//       `BusinessFlowPage.tsx` 调 `/flow/${entityType}`。
//   ⇒ 同一笔运送业务，两条通道各写一张表、各发一种事件口径（T5）。
//
// 【已拍板：走**代理层**，不做数据迁并】
//   `/flow/:entityType` 命中 registry ⇒ 走 adapter 调原生实现；
//   未命中 ⇒ 保持原 `business_flow_tasks` 逻辑（响应外壳 `{ok, code, items/item, label}` 不变）。
//   ⇒ **不动存量数据 ⇒ 可回滚**（回退 = `git revert` 掉把实体写进 registry 的那笔）。
//
// ─────────────────────────────────────────────────────────────────────────────
// 【S0：裁决落地（本段是裁决记录，改代码前先读这里）】
//
//   **D1 事件口径统一到 `transport_order`**
//     · 统一方向 = **改 `/flow` 侧**，让它发**原生名** `transport_order`；
//       **不改** `transport.ts`（原生侧是事实标准，动它等于动存量语义）。
//     · 依据：`transport.ts:74` 硬编码 `entityType: 'transport_order'`，
//       而 `businessFlow.ts:128` 用路由参数（= `transport_task`）⇒ 同一业务两种口径，
//       下游按 `entity_type` 聚合/订阅时一笔业务被算成两个实体。
//
//   **🔴 由此产生一个永久事实：`def` 口径与事件口径是两个名字，且会长期共存**
//     · 状态图（workflow_def）按 **`transport_task`** 读（`transport.ts:43`、
//       `getWorkflowDefOrDefault(client, tenantId, 'transport_task', TRANSPORT_DEF)`）：
//       workflow_def 行就存在 `entity_type = 'transport_task'` 名下，改不得（改了读不到 def）。
//     · 事件流（domain_event）记 **`transport_order`**：与物理表同名，是原生侧事实标准。
//     ⇒ **「def 口径 `transport_task` ≠ 事件口径 `transport_order`」从此是永久双名**，
//       不是待修缺陷。别再试图把它们统一成一个名字——那只会让其中一侧读不到东西。
//       （`src/test/t5EventEntityType.http.test.ts` 里那条"同一条路由内部 def 口径与事件口径
//       必须一致"的红，钉的就是这个双名 ⇒ 它不会随 T5 转绿，需单独裁决如何处置。）
//
//   **D2 `emergency_plan` 收口：不代理，返回 410 Gone + 指路 `/emergency/plans`**
//     · 理由：`034_emergency_transport.sql:7-21` 建的 `emergency_plan` 表**没有 status 列**
//       （只有 `enabled` 布尔），而 `themes.ts:38-51 EMERGENCY_DEF` 是 6 态状态机
//       ⇒ **代理无落点**；且应急预案本质是知识库目录，不是带状态的业务流，
//       给它配 EMERGENCY_DEF 是**历史误配**。
//     · 🔴 **明确否决"加 status 列"方案**：触碰生产库 DDL，与"不动存量"冲突。
//     · 🟢 走 410 自动满足 C2：应急两端本来就都叫 `emergency_plan`（骨架此前把
//       "事件口径断裂"并列在运送/应急两条下其实**对应急不成立**）⇒ 不必再为它写对照断言。
//
//   **D3 本批次只代理 `transport_task`**（P1）
//     registry 里**只**放这一个；其余实体继续走 `business_flow_tasks`。
//
//   **R3 `data` / `location` 在 `transport_order` 无落点 ⇒ 非空即 422，禁止静默丢弃**
//     · `transport_order` 没有 `data` jsonb 列、也没有 `location` 列 ⇒ 塞不进去。
//     · 🔴 **静默丢弃 = 新造一个静默失效**，比现在这个 bug 还难查（总则 E3）。
//     · 正确做法：调用方传了**非空**的 `data` / `location` ⇒ **422**，
//       且 `message` 里写明「该实体无 data/location 落点」。
//     · 空对象 `{}` / 空串 / 不传 ⇒ **放行**（保兼容，不给既有调用方添堵）。
//
//   **R5 `assignee` → `carrier` 接受映射，但必须钉注释说明是语义近似**
//     · `/flow` 侧的 `assignee`（通用"办理人"）映射到 `transport_order.carrier`（承运/运送人）。
//     · ⚠️ **这是语义近似，不是等价**：`carrier` 在运送语境里是"承运人/执行人"，
//       与通用 `assignee` 的"指派对象"大致对齐，但**不等同**（例：carrier 还承担
//       `#583` 归属守卫的判定依据——worker 只能流转自己的单）。
//       ⇒ 别把这个映射当成"字段改名"一样无损替换。
//
//   **R4（知情项）代理会顺带带上原生侧两道守卫 ⇒ 收紧是预期的**
//     · 归属守卫（`transport.ts:252` `requireAssigneeOrConfig`）：worker 转他人单 ⇒ 403
//     · 角色门禁（`transport.ts:52-55`，修复 N5）：`allowedRoles` 不含当前角色 ⇒ 403
//     ⇒ `/flow/transport_task/:id/transition` **可能从 200 变 403**，这是**安全方向**的收紧，
//       接受，但必须在 S6a 里做成对照用例并回归。
//
// ─────────────────────────────────────────────────────────────────────────────
// 【两个"不动"（工程师容易顺手改了）】
//   · `server.ts:215` 挂载关系**不变**
//   · `apiGuard.ts:27` `/v1/flow` 白名单**不变**
//
// 【回退（E1：回滚方案在改动前写好）】
//   · 回退 = `git revert <S5 那一笔>`（把 `transport_task` 写进 registry 的那笔）
//     ⇒ registry 恢复空 ⇒ `/flow` **立即回到**写 `business_flow_tasks`，**无数据迁移，秒级**。
//   · 🔴 **回退前置**：先确认代理窗口内有无经 `/flow/transport_task` 新建的行——
//     它们落在 `transport_order`，回退后从 `/flow` 侧消失（**数据还在，只是看不见**）。
//     有则**先落 id 清单再 revert**。
//     怎么确认：`SELECT id FROM transport_order WHERE tenant_id=$1 AND created_at >= <代理上线时刻>`
//     （配合 `created_by` / 来源标记进一步缩小范围；本批次不改表结构 ⇒ 只能按时间窗+来源推断）。
//
// ─────────────────────────────────────────────────────────────────────────────
// S0：本文件首版**只有这段注释 + 空 registry**（裁决先落地，代码由 S1 补）。
//     registry 为空 ⇒ `proxyFor()` 恒返回 undefined ⇒ `/flow` 行为与改动前完全一致
//     ⇒ **S1 单独落地也不会改变任何线上行为**（★唯一切换点是 S5★）。

/**
 * 代理 registry：entityType → adapter。
 *
 * 🔴 **这是 T5 的唯一切换点**：把一个 entityType 写进这里 = 该实体走原生表；
 *    从这里删掉 = 该实体回到 `business_flow_tasks`。**改这一行就是全量切换**。
 *
 * ⚠️ 当前为**空**是故意的（S1）：先有骨架、后有切换（S5），
 *    保证"加骨架"与"切换行为"是两笔可独立回滚的改动。
 * ⚠️ 填写 entry 的那一笔**必须单独 commit**（回退时才能 `git revert` 单笔）。
 */
export const FLOW_PROXY: Record<string, unknown> = {};
