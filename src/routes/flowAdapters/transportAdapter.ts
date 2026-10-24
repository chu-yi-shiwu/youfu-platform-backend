// src/routes/flowAdapters/transportAdapter.ts —— T5 / S3：把 `/flow/transport_task`
// 代理到运送原生表 `transport_order`。
//
// ─────────────────────────────────────────────────────────────────────────────
// 【职责边界：本文件只做「字段映射 + 委派」，不写任何 SQL】
//   真读写全部走 `routes/transport.ts` 导出的原生函数（S2 抽出）：
//     listOrders / getOrder / createOrder / transitionOrder / loadOwnedOrder
//   ⇒ 运送的 SQL 只有一份，不存在"代理层另写一套"的双份漂移。
//   （要判"有没有偷偷写 SQL"：本文件不应出现 `client.query(`。）
//
// 【字段映射表（/flow 通用字段 → transport_order 原生字段）】
//   title         → item_name
//   scheduled_at  → plan_depart_at
//   assignee      → carrier        ⚠️ R5：语义近似，见下
//   data          → ✗ 无落点（非空即 422，R3）
//   location      → ✗ 无落点（非空即 422，R3）
//
// 【⚠️ R5 assignee → carrier 是"语义近似"，不是"字段改名"】
//   `/flow` 的 `assignee` 是通用"办理人"；`transport_order.carrier` 在运送语境里是
//   "承运人/执行人"。二者**大致对齐但不等同**：carrier 还承担 #583 归属守卫的判定依据
//   （worker 只能流转自己的单，`loadOwnedOrder` 比对的就是 carrier）。
//   ⇒ 别把这个映射当无损替换：把 assignee 写进 carrier，等于**同时**把归属权给了这个人。
//
// 【🔴 R3 data / location 非空即 422，绝不静默丢弃】
//   `transport_order` 没有 `data` jsonb 列、也没有 `location` 列 ⇒ 物理上塞不进去。
//   静默丢弃 = 新造一个静默失效（E3），比现在这个 bug 还难查 ⇒ 非空一律 422，
//   且 message 必须写明"该实体无 data/location 落点"。空对象 `{}` / 空串 / 不传 ⇒ 放行
//   （保兼容，不给既有调用方添堵）。
//
// 【R4：代理**必须**带上原生侧两道守卫（否则就是开后门）】
//   · #583 归属守卫：`loadOwnedOrder`（worker 转他人单 ⇒ 403）
//   · 角色门禁：`transitionOrder` 内部的 allowedRoles 校验（⇒ 403）
//   ⇒ `/flow/transport_task/:id/transition` 对 worker 可能从 200 收紧为 403，这是预期的。
import { AppError } from '../../middleware/error.js';
import { getWorkflowDefOrDefault } from '../../engine/workflowDef.js';
import { availableTransitions } from '../../engine/stateMachine.js';
import { TRANSPORT_DEF } from '../../engine/themes.js';
// ⚠️ 对 `engine/flowProxy.js` **只能 import type**：该文件按值引入了本文件的
//    `transportAdapter`，若这里再按值反向 import 它 ⇒ 运行时循环依赖 ⇒
//    生产启动阶段 `ReferenceError: Cannot access 'transportAdapter' before initialization`
//    （已实测；vitest 下不炸，所以单测全绿不代表没问题）。
//    本文件有护栏断言守着这条不变式。
import type { FlowAdapter, FlowCreateBody, FlowProxyCtx, FlowRow, FlowTransitionBody } from '../../engine/flowProxy.js';
import { assertRequiredFields } from '../../engine/flowRequiredFields.js';
import {
  createOrder,
  getOrder,
  listOrders,
  loadOwnedOrder,
  orderSchema,
  transitionOrder,
} from '../transport.js';

/**
 * transition 的 `data` 里**我们能落地或能理解**的键。
 * 其余键在 `transport_order` 上无处可存 ⇒ 422（R3 同一条纪律：不静默丢）。
 *
 * ⚠️ **进这个集合 = 承诺"一定转发"**，不是"认识一下就行"：
 *   「认识但没转发」比「不认识」更坏——它过得了 422，却拿不到 200 之外的任何东西，
 *   ⇒ 调用方收到 200，数据没了，跟静默丢弃一模一样（曾经 `carrier` 只在 dispatch
 *   分支里转发，其余事件带 carrier 就是 200 + 丢数据）。所以每加一个键，
 *   **必须同时在 `splitTransitionData` 里加转发**，且转发**不许挑事件**。
 *
 * 🔴 故意**不放** `depart_at` / `arrive_at` / `sign_at`：这三个是**系统自己写的
 *   时间戳**（dispatch 写 depart_at=now()、complete 写 arrive_at/sign_at）。
 *   放进集合等于允许调用方伪造时间戳 ⇒ 保持 422。
 */
const UNDERSTOOD_TRANSITION_DATA_KEYS = new Set(['assignee', 'carrier', 'note', 'loc', 'lat', 'lng', 'photo']);

/** def 口径名（workflow_def 行就存在 `transport_task` 名下，改不得——改了读不到 def）。 */
const DEF_KEY = 'transport_task';

/** 取状态图（DB 有配置优先 DB，否则内置 TRANSPORT_DEF）。 */
async function defFor(ctx: FlowProxyCtx) {
  return getWorkflowDefOrDefault(ctx.client, ctx.tenantId, DEF_KEY, TRANSPORT_DEF);
}

/**
 * R3 守卫：建单时的 `data` / `location`。
 * 抛出时 message 必须指明"该实体无 data/location 落点"——让人一眼知道是该换字段，
 * 而不是去查"为什么我的数据没存进去"。
 */
function assertNoDataOrLocation(body: FlowCreateBody): void {
  if (body.data && Object.keys(body.data).length > 0) {
    throw new AppError(
      'BAD_REQUEST',
      `transport_task 无 data 落点：transport_order 表没有 data 列，无法保存 ${Object.keys(body.data).join(',')}；` +
        `请改用原生字段 title / scheduled_at / assignee`,
      422,
    );
  }
  if (body.location != null && String(body.location).trim() !== '') {
    throw new AppError(
      'BAD_REQUEST',
      'transport_task 无 location 落点：transport_order 表没有 location 列，无法保存该字段；' +
        '起止地点请用原生端点 /transport/orders 的 from_loc / to_loc',
      422,
    );
  }
}

/** R3 同源守卫：transition 的 `data` 里出现无法落地的键 ⇒ 422，不静默丢。 */
function assertTransitionDataUnderstood(data: Record<string, unknown>): void {
  const unknown = Object.keys(data).filter((k) => !UNDERSTOOD_TRANSITION_DATA_KEYS.has(k));
  if (unknown.length === 0) return;
  throw new AppError(
    'BAD_REQUEST',
    `transport_task 无 data 落点：${unknown.join(',')} 在 transport_order 上无处可存` +
      `（可识别字段：${Array.from(UNDERSTOOD_TRANSITION_DATA_KEYS).join(',')}）`,
    422,
  );
}

/**
 * `/flow` 的 `data` → 原生 `transitionOrder` 的 extra/track。
 * extra 的键受 `ALLOWED_EXTRA_COLS` 白名单约束（F-A2 纵深防御），不在白名单里的键
 * 会被原生函数直接忽略 ⇒ 所以上面必须用 422 把"忽略"提前变成"报错"。
 *
 * 🔴 **carrier / assignee 的转发故意不挂在任何事件分支下**（R3 同源纪律）：
 *   早期版本把 `extra.carrier = ...` 写在 `event === 'dispatch'` 分支里 ⇒
 *   非 dispatch 事件带 `carrier` 时：过得了 422（它在 UNDERSTOOD 里），
 *   却进 `transitionOrder(extra={})` ⇒ **200 且数据丢了**。
 *   422 挡住了"不认识的键"，却放过了"认识但没转发的键"——后者正是 R3 要防的静默失效。
 *   依据：原生侧 `filterTransportExtraCols` 的 `ALLOWED_EXTRA_COLS` 是**按事件无差别放行**
 *   的（carrier 在任意事件都能写），代理侧必须与之一致。
 *
 * ⚠️ **刻意不把 `depart_at` / `arrive_at` / `sign_at` 收进 UNDERSTOOD**：
 *   它们是**系统自己写的时间戳**（dispatch 写 depart_at='now()'、complete 写
 *   arrive_at/sign_at='now()'），不是用户输入。保持 422，避免调用方伪造时间戳。
 */
function mapTransitionData(data: Record<string, unknown>): {
  extra: Record<string, unknown>;
  track: { loc?: string; note?: string; lat?: number; lng?: number; photo?: string };
} {
  const extra: Record<string, unknown> = {};
  const track: { loc?: string; note?: string; lat?: number; lng?: number; photo?: string } = {};
  if (data.loc != null) track.loc = String(data.loc);
  if (data.note != null) track.note = String(data.note);
  if (data.lat != null) track.lat = Number(data.lat);
  if (data.lng != null) track.lng = Number(data.lng);
  if (data.photo != null) track.photo = String(data.photo);
  // R5：`assignee`（通用办理人）→ `carrier`（承运人），**任何事件**都转发
  if (data.carrier != null) extra.carrier = String(data.carrier);
  else if (data.assignee != null) extra.carrier = String(data.assignee);
  return { extra, track };
}

/** 给行补 `available`（/flow 响应外壳要求每行都带，前端据此渲染动作按钮）。 */
function withAvailable(def: Awaited<ReturnType<typeof defFor>>, row: FlowRow): FlowRow {
  return { ...row, available: availableTransitions(def, String(row.status)) };
}

export const transportAdapter: FlowAdapter = {
  entityType: 'transport_task',
  // D1 永久双名：事件口径 = 原生表名 transport_order（≠ def 口径 transport_task）
  nativeEntityType: 'transport_order',

  async list(ctx: FlowProxyCtx, query: { status?: string }): Promise<FlowRow[]> {
    const def = await defFor(ctx);
    const rows = await listOrders(ctx.client, ctx.tenantId, { status: query.status });
    return rows.map((r: FlowRow) => withAvailable(def, r));
  },

  async create(ctx: FlowProxyCtx, body: FlowCreateBody): Promise<FlowRow> {
    assertNoDataOrLocation(body);
    // 走原生侧同一份 schema ⇒ 默认值（priority=normal / order_type=scheduled）不漂移
    const input = orderSchema.parse({
      item_name: body.title,
      // R5：assignee → carrier（语义近似，同时把归属权给了这个人，见文件头）
      carrier: body.assignee ?? undefined,
      plan_depart_at: body.scheduled_at ?? undefined,
    });
    const def = await defFor(ctx);
    const row = await createOrder(ctx.client, ctx.tenantId, input);
    return withAvailable(def, row);
  },

  async detail(ctx: FlowProxyCtx, id: string): Promise<FlowRow> {
    // getOrder 自带 available / tracks / work_order，且找不到时抛 404（与 /flow 旧口径一致）
    return getOrder(ctx.client, ctx.tenantId, id);
  },

  async transition(ctx: FlowProxyCtx, id: string, body: FlowTransitionBody): Promise<FlowRow> {
    const data = body.data ?? {};
    assertTransitionDataUnderstood(data);

    // ① R4 归属守卫（404/403）：与原生路由**同一款**，顺序也在最前——先确定"有没有资格动"
    await loadOwnedOrder(ctx.client, ctx.tenantId, id, ctx.auth, 'transport order');

    // ② def + requiredFields 校验：`/flow` 侧原本就有这道校验（businessFlow.ts:179-185），
    //    代理后由 adapter 接过来用**同一个函数**，避免"代理 = 悄悄取消必填校验"。
    const def = await defFor(ctx);
    const cur = await getOrder(ctx.client, ctx.tenantId, id);
    assertRequiredFields(def, String(cur.status), body.event, data);

    // carrier / assignee 的转发已在 mapTransitionData 里完成（不随事件分支变化）
    const { extra, track } = mapTransitionData(data);
    if (body.event === 'dispatch') {
      extra.depart_at = 'now()';
    }
    if (body.event === 'complete') {
      extra.arrive_at = 'now()';
      extra.sign_at = 'now()';
    }

    // ③ 流转内核（内部含 allowedRoles 角色门禁 ⇒ R4 第二道守卫）
    const row = await transitionOrder(
      ctx.client,
      ctx.tenantId,
      id,
      body.event,
      extra,
      track,
      ctx.actor,
      ctx.auth.role,
    );
    return withAvailable(def, row);
  },
};
