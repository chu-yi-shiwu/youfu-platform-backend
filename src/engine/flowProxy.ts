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
//
// S1：补代理骨架（**仍然零行为改动**——registry 依旧是空的，`/flow` 没有任何调用方变化）。
//     本步只定义契约：Ctx / adapter 四方法 / 查表函数。adapter 实现由 S3 补，
//     `/flow` 路由侧的查表分派由 S4 补，写 registry 由 S5 补。
//
// 【为什么四方法 = list / create / detail / transition】
//   与 `routes/businessFlow.ts` 的四个端点一一对应（`/:entityType` GET / POST、
//   `/:entityType/:id` GET、`/:entityType/:id/transition` POST）。
//   ⚠️ **不含** `tracks` 与 `work_order` 回显：那是 `transport.ts` 原生端点专属能力，
//   `/flow` 侧本来就没有，按 X6 结论**不新增**（不借代理层偷偷扩 `/flow` 的能力面）。

import type { PoolClient } from 'pg';
import type { AuthLocals } from '../middleware/auth.js';
// ⚠️ 通用通道的必填字段校验**不在本文件**，见 `engine/flowRequiredFields.ts` 文件头：
//   本文件（S5 起）要按值引入 adapter，若校验也放这儿，adapter 就得反向按值 import 本文件
//   ⇒ 运行时循环依赖 ⇒ 生产启动阶段 ReferenceError（已实测）。别把它搬回来。
import { transportAdapter } from '../routes/flowAdapters/transportAdapter.js';

/** 代理层与路由之间传递的行对象（原生表行 + adapter 补的 `available` 等派生字段）。 */
export type FlowRow = Record<string, unknown>;

/**
 * 一次代理调用的上下文（四方法共用）。
 *
 * ⚠️ `client` 必须是 `withTenantClient` 事务内的 client（已 SET LOCAL 租户与受限角色），
 *    adapter 内**不得**再开新连接——否则丢掉 RLS 与事务原子性。
 */
export interface FlowProxyCtx {
  /** 事务内 client（租户隔离 + RLS 已生效）。 */
  client: PoolClient;
  tenantId: string;
  /**
   * **def 口径**实体名（如 `transport_task`）。
   * 🔴 它不是事件口径名——事件口径见 `FlowAdapter.nativeEntityType`（D1 永久双名）。
   */
  entityType: string;
  /** 请求身份（守卫要读 `role` / `userId` / `authMode`）。 */
  auth: AuthLocals;
  /** 事件与审计用的操作者标识（与 `businessFlow.authInfo()` 同口径：userId ?? username ?? 'user'）。 */
  actor: string;
}

/** 列表查询参数（与 `GET /flow/:entityType` 现有 query 同口径，只认 `status`）。 */
export interface FlowListQuery {
  status?: string;
}

/** 建单入参（与 `POST /flow/:entityType` 现有 zod schema 同口径）。 */
export interface FlowCreateBody {
  title: string;
  data?: Record<string, unknown>;
  assignee?: string;
  location?: string;
  scheduled_at?: string;
}

/** 流转入参（与 `POST /flow/:entityType/:id/transition` 现有 zod schema 同口径）。 */
export interface FlowTransitionBody {
  event: string;
  data?: Record<string, unknown>;
}

/**
 * 业务流代理适配器：**字段映射 + 委派原生实现**，adapter 内**不写 SQL**。
 *
 * 职责边界（S3 实现时必须守住）：
 *   · 把 `/flow` 的通用字段（title/data/assignee/location/scheduled_at）映射成原生表字段；
 *   · 真正的读写**复用原生模块的既有函数**（运送即 `transport.ts` 的 `listOrders`/`getOrder`/
 *     `createOrder`/`transitionOrder`），**不复制一份 SQL**——复制就意味着双份逻辑各自漂移。
 *   · 守卫（角色门禁 / 归属守卫）由原生实现自带，adapter **不得**绕过（R4：收紧是预期的）。
 */
export interface FlowAdapter {
  /** def 口径名（registry 的 key 必须与此相同）。 */
  entityType: string;
  /**
   * 事件口径名（D1：统一到原生名，如 `transport_order`）。
   * 🔴 **永久不等于 `entityType`**——别再试图合并这两个名字（见文件头 D1）。
   */
  nativeEntityType: string;

  /** 列表：返回值每行须自带 `available`（与 `business_flow_tasks` 侧同外壳）。 */
  list(ctx: FlowProxyCtx, query: FlowListQuery): Promise<FlowRow[]>;
  /** 建单：返回新建行（自带 `available`）。 */
  create(ctx: FlowProxyCtx, body: FlowCreateBody): Promise<FlowRow>;
  /** 详情：找不到须抛 `AppError('NOT_FOUND', ..., 404)`；返回行自带 `available`。 */
  detail(ctx: FlowProxyCtx, id: string): Promise<FlowRow>;
  /** 流转：事件非法须抛 422；返回流转后行（自带 `available`）。 */
  transition(ctx: FlowProxyCtx, id: string, body: FlowTransitionBody): Promise<FlowRow>;
}

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
/**
 * ★S5：唯一切换点已拨动★
 *   `transport_task` 写进 registry ⇒ `/flow/transport_task*` 改走原生表 `transport_order`；
 *   从这里删掉这一行 ⇒ `/flow` 立即回到 `business_flow_tasks`（无数据迁移，秒级）。
 *   🔴 回退前先读文件头的「回退（E1）」段：要先落代理窗口内新建行的 id 清单。
 */
export const FLOW_PROXY: Record<string, FlowAdapter> = {
  transport_task: transportAdapter,
};

/**
 * 查表：该实体是否被代理。
 *
 * 返回 `undefined` = **走原 `business_flow_tasks` 逻辑**（这是默认路径，也是最安全的一侧）。
 *
 * 🔴 用 `hasOwnProperty` 而非裸下标：registry 的 key 来自**代码**，但 `entityType` 来自
 *    **URL 路径**（`/flow/:entityType`），`toString` / `constructor` / `__proto__`
 *    这类原型链键若走裸下标会命中 `Object.prototype` 上的东西 ⇒ 查表"命中"了
 *    一个根本不存在的 adapter。fail-closed 到"未代理"这一侧。
 */
export function proxyFor(entityType: string): FlowAdapter | undefined {
  if (!entityType) return undefined;
  if (!Object.prototype.hasOwnProperty.call(FLOW_PROXY, entityType)) return undefined;
  return FLOW_PROXY[entityType];
}

/** 必填字段校验见 `../engine/flowRequiredFields.js`（同文件头写了为什么不在本文件）。 */
