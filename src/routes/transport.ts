// 运送模块（P2 第二刀）：运送订单 + 轨迹追踪。
// 状态流转统一走 workflow_def 引擎（TRANSPORT_DEF），不再硬编码状态机（红线）。
// 每次流转自动追加轨迹点（transport_track_point），前端按时间线回显"出发→在途→送达签收"。
//
// ─────────────────────────────────────────────────────────────────────────────
// 【S2：纯重构（★行为零变化★）】
//   四个 handler 的事务体原样搬成导出函数，供 T5 代理层（`engine/flowProxy.ts` 的
//   transportAdapter）**复用同一份实现**——代理层不许复制 SQL，复制就意味着双份逻辑各自漂移。
//   · `listOrders` / `getOrder` / `createOrder` / `transitionOrder`：事务体原样搬出
//   · `loadOwnedOrder`：`tracks` 与 `transition` 两处**完全相同的**「查单 + #583 归属守卫」
//     内联块合并成一处（原 :209-212 与 :249-252），消除两份拷贝
//   · handler 只剩「解析入参 → withTenantClient → 组响应外壳」
//
//   🔴 判定"纯重构"的证据：**S2 前后各跑一次 `src/test/t5RouteParity.transport.test.ts`，
//     输出必须条条一致**（A 组四条绿在前后都绿，B/C 组五条红在前后红同样的原因）。
//     本文件**不许**借机改任何判定条件、错误消息、SQL 或字段顺序。
import { Router } from 'express';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import type { AuthLocals } from '../middleware/auth.js';
import { requireAssigneeOrConfig, requirePermission } from '../middleware/role.js';
import { emitDomainEvent } from '../db/eventBus.js';
import { getWorkflowDefAtVersion, getWorkflowDefVersion } from '../engine/workflowDef.js';
import { activeStates, applyEvent, availableTransitions } from '../engine/stateMachine.js';
import { TRANSPORT_DEF } from '../engine/themes.js';
// 洞②（运送单接自动派单）：选人**复用** engine/dispatch.ts 的 pickWorker，不新写一套算法。
import { pickWorker } from '../engine/dispatch.js';
import { safeParseJsonb } from '../util/jsonb.js';
import { insertNotification } from '../services/notify.js';

/**
 * F-A2 纵深防御（三轮 QA 第一轮修复）：仅允许已知列名进入 UPDATE 的列名插值位，
 * 防止任何调用方误将用户输入当作列名插值进 SQL 导致注入。
 * parameterized：值走 $N 参数化；nowCols：写 now() 字面量（仅限白名单内的时间列）。
 */
export const ALLOWED_EXTRA_COLS = new Set(['depart_at', 'carrier', 'arrive_at', 'sign_at']);
export function filterTransportExtraCols(extra: Record<string, unknown>): {
  parameterized: string[];
  nowCols: string[];
} {
  const extraKeys = Object.keys(extra).filter((k) => ALLOWED_EXTRA_COLS.has(k));
  const parameterized = extraKeys.filter((k) => extra[k] !== 'now()');
  const nowCols = extraKeys.filter((k) => extra[k] === 'now()');
  return { parameterized, nowCols };
}

/**
 * 查单 + #583 归属守卫（原 `tracks`/`transition` 两处内联块，**逐字搬出**）。
 *
 * 守卫语义（见 `middleware/role.ts` 的 `requireAssigneeOrConfig`）：
 *   admin/operator 恒放行；worker 仅可操作 carrier == 自己的单；dev 模式放行。
 * ⚠️ 两处原本各写一份同样的三行，合并后**行为逐字节相同**（同一 SQL、同一 404 文案、同一守卫）。
 */
export async function loadOwnedOrder(
  client: PoolClient,
  tenantId: string,
  orderId: string,
  auth: AuthLocals,
  label = 'transport order',
): Promise<{ id: string; carrier: string | null }> {
  const cur = await client.query(`SELECT id, carrier FROM transport_order WHERE id=$1 AND tenant_id=$2`, [orderId, tenantId]);
  if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'order not found', 404);
  await requireAssigneeOrConfig(client, auth, cur.rows[0].carrier, label);
  return cur.rows[0];
}

/**
 * 运送单流转内核（原 :30-76，**逐字搬出**）。
 *
 * 顺序不可变：读当前行 → 取 def（def 口径 `transport_task`）→ 引擎校验 → 角色门禁
 * → UPDATE → 写轨迹点 → 发事件（事件口径 `transport_order`，D1 永久双名）。
 *
 * ⚠️ **不包含 #583 归属守卫**：守卫在 `loadOwnedOrder`，由调用方（路由 / 代理 adapter）
 *    在调本函数之前执行。代理 adapter 必须同样先调 `loadOwnedOrder`，
 *    否则 `/flow` 侧就成了一条绕过归属守卫的后门（R4）。
 */
export async function transitionOrder(
  client: PoolClient,
  tenantId: string,
  orderId: string,
  event: string,
  extra: Record<string, unknown> = {},
  track: { loc?: string; note?: string; lat?: number; lng?: number; photo?: string } = {},
  actor = 'config_role',
  role?: string,
  // 洞②：系统身份通道——与 `repo/ticket.ts` 的 `transition()` 的 `systemAuto` **同款、同命名、同语义**，
  //   不自创第二套说法（两套说法 = 两套口径，迟早漂移）。
  opts?: { systemAuto?: boolean },
): Promise<any> {
  const cur = await client.query(`SELECT * FROM transport_order WHERE id = $1 AND tenant_id = $2`, [orderId, tenantId]);
  if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'order not found', 404);
  const t = cur.rows[0];
  // T1-B 批2：在途单按建单时锁定的流程版本流转（def_version=0 表示未记录 ⇒ 走 live，与改前逐字节等价）。
  const def = await getWorkflowDefAtVersion(client, tenantId, 'transport_task', t.def_version, TRANSPORT_DEF);
  const target = applyEvent(def, t.status, event);
  if (!target) {
    throw new AppError('BAD_STATE', `illegal transition ${t.status} --${event}-->`, 422);
  }
  // P1（B2 接 allowedRoles）：TRANSPORT_DEF 声明的角色门禁此前只在工作单线强制
  // （repo/ticket.ts transition()），运送线 applyEvent 仅校验 from+event——被指派工人
  // 可对自己单子执行声明上仅 admin/operator 可用的 cancel。口径对齐工单线：
  // 为空/未定义=放行（向后兼容，避免门死自己）；显式配置且调用角色不在其中 → 403。
  //
  // 洞②：系统身份通道（与工单线 F4 深修同一论证）——allowedRoles 是**人类**门禁
  // （约束"谁能点按钮"），系统 actor 根本没有角色可谈。若系统也守这道门，则任何配了
  // allowedRoles 的 dispatch 边 = 自动派单永远 403（dispatch 边恰恰就配了
  // allowedRoles=['admin','operator']）。系统只跳过人类门禁，**拓扑（applyEvent）、
  // 必填、副作用一个不跳**——下面三行代码一行没动。
  const tdef = (def.transitions ?? []).find((x: any) => x.from === t.status && x.event === event);
  if (!opts?.systemAuto) {
    if (tdef?.allowedRoles && tdef.allowedRoles.length > 0 && !(role && tdef.allowedRoles.includes(role))) {
      throw new AppError('FORBIDDEN', `role ${role ?? 'unknown'} not allowed to ${event} transport order`, 403);
    }
  }
  const { parameterized: filteredKeys, nowCols } = filterTransportExtraCols(extra);
  const assigns = [
    'status = $3',
    ...filteredKeys.map((k, idx) => `${k} = $${4 + idx}`),
    ...nowCols.map((k) => `${k} = now()`),
  ];
  const values = [orderId, tenantId, target, ...filteredKeys.map((k) => extra[k])];
  const r = await client.query(
    `UPDATE transport_order SET ${assigns.join(', ')}, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    values,
  );
  const row = r.rows[0];
  // ── worker.load 净结算（与 `repo/ticket.ts:305-315` **同口径**，不自创第二套）──────────
  // 为什么必须有这一段：派单选人是 least_load（`engine/dispatch.ts:47` 按 load 升序取第一个），
  //   而 load 只在工单线 `repo/ticket.ts:312/315` 结算 ⇒ 运送线派完从不 +1 ⇒ 对运送单而言
  //   「手上活最少」永远算出来是同一个人（连续两张运送单都派给他），least_load 名存实亡。
  //   负载与工单**共用 worker.load 这一个计数字段**（不新增列/表）：跨工单+运送单的
  //   「手上总活数」才是派单该看的数，各记一列反而要再合成一次。
  // 口径（逐条对应工单线）：
  //   ① 活跃态由 `activeStates(def)` 派生（全态 − done − 终态 − 挂起），不硬编码状态名；
  //   ② 「在身人」列是运送单的 carrier（对应工单的 assignee_id）；
  //   ③ 净变化：before = 流转前活跃且有 carrier；after = 流转后活跃且有 carrier；
  //      before≠after 才动 SQL ⇒ 同一个人改别的不重复加减，改派一次完成「旧 −1、新 +1」；
  //   ④ 减载用 `GREATEST(load - 1, 0)` 兜底，脏数据也不会把 load 减成负数。
  // 🔴 刻意**不**移植工单线的 `resolveDispatchShadow`（K2 影子回填）：运送单没有 dispatch
  //    影子这个概念，扩过去就是往本批里塞第二个变量。
  const se = activeStates(def);
  const nextCarrier = (extra.carrier as string) ?? t.carrier ?? null;
  const beforeContrib = se.includes(t.status) && t.carrier ? t.carrier : null;
  const afterContrib = se.includes(target) && nextCarrier ? nextCarrier : null;
  if (beforeContrib && beforeContrib !== afterContrib) {
    await client.query('UPDATE worker SET load = GREATEST(load - 1, 0) WHERE id = $1 AND tenant_id = $2', [beforeContrib, tenantId]);
  }
  if (afterContrib && afterContrib !== beforeContrib) {
    await client.query('UPDATE worker SET load = load + 1 WHERE id = $1 AND tenant_id = $2', [afterContrib, tenantId]);
  }
  // 轨迹点：每次流转留痕（含取件/签收照片凭证）
  await client.query(
    `INSERT INTO transport_track_point (tenant_id, order_id, event, loc, note, lat, lng, photo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [tenantId, orderId, event, track.loc ?? null, track.note ?? null, track.lat ?? null, track.lng ?? null, track.photo ?? null],
  );
  await emitDomainEvent(client, { tenantId, entityType: 'transport_order', entityId: orderId, type: event, actor });
  return row;
}

const router = Router();

// ============ 运送订单 ============
/**
 * 建单入参 schema。导出是为了让代理层（`flowAdapters/transportAdapter.ts`）走**同一份
 * 默认值与校验**，而不是在 adapter 里再抄一份 `priority: 'normal'` / `order_type: 'scheduled'`
 * ——抄一份就等于给自己埋一个"两边默认值漂移"的雷。
 */
export const orderSchema = z.object({
  item_name: z.string().min(1),
  from_loc: z.string().optional(),
  to_loc: z.string().optional(),
  carrier: z.string().optional(),
  priority: z.enum(['urgent', 'normal', 'low']).default('normal'),
  plan_depart_at: z.string().optional(),
  item_category: z.string().optional(), // UOne A3 物品分类（标本/药品/文件/器械...）
  order_type: z.enum(['scheduled', 'free']).default('scheduled'), // scheduled 计划运送 | free 自由运送
  work_order_id: z.string().optional(), // P2：来源工单（work_orders.id 为 text 且含 PILOT-WO-002 等非 uuid 业务单号，故用 string 不校验 uuid 形态，与 041 迁移的 text 列对齐）
  sla_due_at: z.string().optional(), // P1（B2 补 SLA）：期望完成时间；不传 = 不纳入 SLA 扫描（诚实：不替租户估时）
});

/** 建单入参（orderSchema 解析后的形态）。 */
export type TransportOrderInput = z.infer<typeof orderSchema>;

/** 列表筛选（与 `GET /orders` 的 query 同口径；未传/空串的项不进 WHERE）。 */
export interface TransportOrderFilters {
  status?: string;
  priority?: string;
  item_category?: string;
  order_type?: string;
  carrier?: string;
}

/** 列表（原 :94-133 事务体**逐字搬出**；回显关联工单的降级逻辑原样保留）。 */
export async function listOrders(
  client: PoolClient,
  tenantId: string,
  filters: TransportOrderFilters = {},
): Promise<any[]> {
  const { status, priority, item_category, order_type, carrier } = filters;
  const clauses = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    clauses.push(sql.replace(/\?/g, `$${params.length}`));
  };
  if (status) add('status = ?', status);
  if (priority) add('priority = ?', priority);
  if (item_category) add('item_category = ?', item_category);
  if (order_type) add('order_type = ?', order_type);
  if (carrier) add('carrier = ?', carrier); // #583：worker 工作台按归属拉自己的运送单
  const rows = await client
    .query(
      `SELECT * FROM transport_order WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`,
      params,
    )
    .then((r) => r.rows);
  // P2：回显关联工单号（工单可能属于同一租户；跨租户 RLS 下查不到则为 null，安全降级）
  for (const o of rows) {
    if (o.work_order_id) {
      const wo = await client
        .query('SELECT order_no, title, status FROM work_orders WHERE id=$1 AND tenant_id=$2', [o.work_order_id, tenantId])
        .then((r: any) => r.rows[0] ?? null);
      o.work_order = wo ? { order_no: wo.order_no, title: wo.title, status: wo.status } : null;
    } else {
      o.work_order = null;
    }
  }
  return rows;
}

/** 详情（原 :136-167 事务体**逐字搬出**）：订单 + 轨迹点 + 引擎算出的 available。 */
export async function getOrder(client: PoolClient, tenantId: string, id: string): Promise<any> {
  const cur = await client.query(`SELECT * FROM transport_order WHERE id = $1 AND tenant_id = $2`, [
    id,
    tenantId,
  ]);
  if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'order not found', 404);
  const o = cur.rows[0];
  // T1-B 批2：详情 available 必须与写侧用同一个版本化 def，否则按钮与实际校验不一致（R-1）。
  const def = await getWorkflowDefAtVersion(client, tenantId, 'transport_task', o.def_version, TRANSPORT_DEF);
  const available = availableTransitions(def, o.status);
  const tracks = await client
    .query(
      `SELECT * FROM transport_track_point WHERE order_id=$1 AND tenant_id=$2 ORDER BY occurred_at ASC, created_at ASC`,
      [id, tenantId],
    )
    .then((r: any) => r.rows);
  // P2：关联工单回显（无关联或为 null 时安全降级）
  let workOrder: any = null;
  if (o.work_order_id) {
    workOrder = await client
      .query('SELECT order_no, title, status FROM work_orders WHERE id=$1 AND tenant_id=$2', [o.work_order_id, tenantId])
      .then((r: any) => r.rows[0] ?? null);
  }
  return { ...o, available, tracks, work_order: workOrder ? { order_no: workOrder.order_no, title: workOrder.title, status: workOrder.status } : null };
}

/**
 * 洞②：运送单「建单后自动派单」——把人从派单环节里摘出去。
 *
 * 【为什么单独抽一个函数】createOrder 是原生路由与 `/flow` 代理 adapter **共用**的
 * 唯一 INSERT 点（`transportAdapter.ts:171` 也调它）。派单逻辑写在 createOrder 体内
 * 还是体外，两个入口的行为都必须一致 ⇒ 抽成导出函数，让「只有一个实现」是结构保证，
 * 而不是靠两处注释互相提醒。
 *
 * 【选人口径】**复用** `engine/dispatch.ts` 的 `pickWorker`（active + 技能全命中 + least_load）。
 *   初一裁决 D-4：运送单先不加资质字段 ⇒ 不传 skillTags（required=[] ⇒ 只看"在岗 + 手上活最少"）。
 *   刻意**不走** `resolveDispatch` 规则链：运送单没有 business_type/catalog 入参，
 *   `NEED_RESOLVER_REGISTRY` 也没注册 `transport_task` ⇒ 规则链现在拿不到任何 need 维度，
 *   接上去只会制造"配了规则其实没生效"的假象。等运送单真有资质维度再接，不预先铺路（YAGNI）。
 *
 * 【派不到人时】先查实：TRANSPORT_DEF（engine/themes.ts:22-36）的 states =
 *   pending / assigned / transporting / done / exception / cancelled ⇒ **没有池态**。
 *   ⇒ 保持 pending + 通知本租户 active admin（工单线 else 分支的可移植部分）。
 *   **不发明新状态、不改状态机定义**——那等于新增一个变量，且没有池态消费方。
 *
 * @returns 派中时返回流转后的行；未派中返回 null（调用方保持原行）。
 */
export async function autoDispatchTransportOrder(
  client: PoolClient,
  tenantId: string,
  row: { id: string; code?: string | null },
): Promise<any | null> {
  // 【降级纪律】只看 worker 读失败这一段（不是整个派单）：建单是主行为、自动派单是增强。
  //   读不到工人 ⇒ 退化成"派不到人"分支（保持 pending + 通知 active admin），
  //   而**不是**让建单 500 —— 建不出来比"建出来停在 pending"更糟，那正是洞②要消灭的处境。
  //   与 `engine/dispatch/needResolver.ts:118-124` 同款处理：单个环节故障不得拖挂主流程。
  // 🔴 故障不静默：console.error 留痕 + 下方必定走"通知 active admin"分支（管理员看得见）。
  //   try 块**只包这一条查询**：派单流转本身若真 403/422（实现 bug）必须照常抛，不许被吞。
  let workerRows: Array<{ id: string; skill_tags: string[]; load: number; active: boolean }> = [];
  try {
    const w = await client.query('SELECT id, skill_tags, load, active FROM worker WHERE tenant_id = $1', [tenantId]);
    workerRows = w.rows.map((x: any) => ({ ...x, skill_tags: safeParseJsonb(x.skill_tags) ?? [] }));
  } catch (e) {
    console.error('[transport.autoDispatch] worker lookup failed, degrade to no-worker path', {
      tenantId, transportOrderId: row.id, err: e,
    });
  }
  const picked = pickWorker(workerRows, {});
  const code = row.code ?? row.id;
  if (!picked) {
    // 与 `routes/workOrder.ts:263-280` 同款 SAVEPOINT 隔离：withTenantClient 是 BEGIN→fn→COMMIT，
    // 通知段一旦真出错会把整个 PG 事务置为 aborted —— 单纯 try/catch 吞错后外层 COMMIT 实为
    // ROLLBACK，运送单静默消失但 API 谎报 201。隔离后失败仅回滚通知段，建单保真。
    // ⚠️ SAVEPOINT 只在**事务块内**合法（生产两个入口都经 withTenantClient，恒在事务里）；
    //    直连 client 且没开事务时（如拿裸 PGlite client 直接调 adapter 的测试）会报
    //    "SAVEPOINT can only be used in transaction blocks"。建不了不等于该放弃通知：
    //    无事务 = 没有"整段被拖挂"的风险 ⇒ 照常通知，只是不再需要 RELEASE / ROLLBACK。
    const inTx = await client
      .query('SAVEPOINT transport_dispatch_notify_sp')
      .then(() => true)
      .catch(() => false);
    try {
      const admins = await client.query<{ id: string }>(
        `SELECT id FROM account_user WHERE tenant_id=$1 AND role='admin' AND active=true`,
        [tenantId],
      );
      for (const a of admins.rows) {
        await insertNotification(client, {
          tenantId, recipient: a.id, recipientKind: 'account', type: 'dispatch', workOrderId: row.id,
          title: '运送单自动派单未命中', body: `运送单 ${code} 自动派单未命中（无在岗工人），请人工派单`,
          payload: { entity_type: 'transport_order', code: row.code ?? null, from_status: 'pending' },
        });
      }
      if (inTx) await client.query('RELEASE SAVEPOINT transport_dispatch_notify_sp');
    } catch (notifyErr) {
      // 回滚只回滚通知段，事务恢复可用 ⇒ 外层建单照常提交（运送单不会静默消失）。
      if (inTx) {
        await client.query('ROLLBACK TO SAVEPOINT transport_dispatch_notify_sp').catch(() => undefined);
      }
      console.error('[transport.autoDispatch] admin notification failed (non-blocking)', {
        transportOrderId: row.id, err: notifyErr,
      });
    }
    return null;
  }
  // 直接调 transitionOrder，**不经过 loadOwnedOrder**：后者带 #583 归属守卫
  // （transport.ts:61 → middleware/role.ts:622，未指派单对 worker 必 403），
  // 而系统没有 AuthLocals 可传；transitionOrder 本来就不含该守卫（见 :71-72 注释）。
  const updated = await transitionOrder(
    client,
    tenantId,
    row.id,
    'dispatch',
    { carrier: picked.id, depart_at: 'now()' },
    { note: '自动派单' },
    'auto_dispatch',
    undefined,
    { systemAuto: true },
  );
  // 与工单线 A5 fan-out 同口径：落库通知被派单人（sms/push 为 stub，诚实未真实发送）。
  // payload 带 entity_type 是因为 notification.work_order_id 是 NOT NULL 文本列且无 FK，
  // 运送单只能借位存放——`scheduler/slaScheduler.ts:198-215` 的运送单通知已是这个约定。
  await insertNotification(client, {
    tenantId, recipient: picked.id, recipientKind: 'worker', type: 'dispatch', workOrderId: row.id,
    title: '您有一条新运送单', body: `运送单 ${code} 已自动派给您`,
    payload: { entity_type: 'transport_order', code: row.code ?? null, from_status: 'pending', to_status: 'assigned' },
  });
  return updated;
}

/**
 * 建单（原 :169-201 事务体**逐字搬出**）。
 *
 * @param actor 事件记账的操作者。**默认 'config_role'** 是既有行为（原代码硬编码），
 *   调用方不传即与改动前完全一致；代理层若要改审计口径须单独立项，不许借重构顺手改。
 *
 * 洞②：建单成功后自动派单（仅在调用方**未**显式指定 carrier 时）——
 *   显式指定了 carrier = 调用方已明确派给谁，系统不得覆盖（与
 *   `engine/dispatch/needResolver.ts` 的 explicitSkillTagsResolver 同款"显式直通"原则）。
 */
export async function createOrder(
  client: PoolClient,
  tenantId: string,
  b: TransportOrderInput,
  actor = 'config_role',
): Promise<any> {
  // T1-B 批2：盖章 —— 新单锁上建单当时的流程定义版本（无 definition 时返 0 = 未记录）。
  // 🔴 表的实体名是 transport_task，不是表名 transport_order（D1 永久双名）：
  //    传错会永远返回 0，而且一声不响 ⇒ 属于最典型的静默失败。
  const defVersion = await getWorkflowDefVersion(client, tenantId, 'transport_task');
  const r = await client.query(
    `INSERT INTO transport_order (tenant_id, code, item_name, from_loc, to_loc, carrier, priority, plan_depart_at, item_category, order_type, work_order_id, sla_due_at, status, def_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending', $13) RETURNING *`,
    [
      tenantId,
      `T${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
      b.item_name,
      b.from_loc ?? null,
      b.to_loc ?? null,
      b.carrier ?? null,
      b.priority,
      b.plan_depart_at ?? null,
      b.item_category ?? null,
      b.order_type,
      b.work_order_id ?? null,
      b.sla_due_at ?? null,
      defVersion,
    ],
  );
  const row = r.rows[0];
  await emitDomainEvent(client, { tenantId, entityType: 'transport_order', entityId: row.id, type: 'create', actor });
  // 洞②：建单即自动派单（第三条路）。派不中时 autoDispatch 返回 null ⇒ 保持 pending 原样返回。
  if (b.carrier == null || b.carrier === '') {
    const dispatched = await autoDispatchTransportOrder(client, tenantId, row);
    if (dispatched) return dispatched;
  }
  return row;
}

router.get('/orders', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { status, priority, item_category, order_type, carrier } = req.query as Record<string, string>;
    const items = await withTenantClient(tenantId, (client) =>
      listOrders(client, tenantId, { status, priority, item_category, order_type, carrier }),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// 订单详情：返回订单 + 轨迹点 + 引擎算出的 available（前端动态渲染动作按钮）
router.get('/orders/:id', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, (client) => getOrder(client, tenantId, req.params.id));
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.post('/orders', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      // 守卫保持在 body 校验**之前** ⇒ 非授权角色的 403 优先于 zod 的 400（与原 requireConfigRole 顺序一致）。
      // 权限点与 `POST /flow/:entityType` 共用 `flow.create`：同一笔业务的两个入口必须同答案，
      // 依据见 role.ts 的 flow.create 注释，由 t5RouteParity.transport.test.ts D 组钉住。
      await requirePermission(auth, client, 'flow.create');
      const b = orderSchema.parse(req.body);
      return createOrder(client, tenantId, b);
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 手动追加轨迹点（在途汇报/中转备注）
router.post('/orders/:id/tracks', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ event: z.string().min(1), loc: z.string().optional(), note: z.string().optional(), lat: z.number().optional(), lng: z.number().optional(), photo: z.string().optional() }).parse(req.body);
    const point = await withTenantClient(tenantId, async (client) => {
      // #583 归属守卫：worker 仅可为自己的运送单上报轨迹
      await loadOwnedOrder(client, tenantId, req.params.id, res.locals.auth, 'transport order');
      const r = await client.query(
        `INSERT INTO transport_track_point (tenant_id, order_id, event, loc, note, lat, lng, photo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [tenantId, req.params.id, b.event, b.loc ?? null, b.note ?? null, b.lat ?? null, b.lng ?? null, b.photo ?? null],
      );
      await emitDomainEvent(client, { tenantId, entityType: 'transport_order', entityId: req.params.id, type: 'track', actor: res.locals.auth.userId ?? 'config_role', payload: { event: b.event } });
      return r.rows[0];
    });
    return res.status(201).json({ ok: true, code: 0, item: point });
  } catch (e) {
    next(e);
  }
});

// 流转：派单/取件/送达签收/异常/取消（引擎校验 + 写库 + 轨迹点）
router.post('/orders/:id/transition', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { event, ...fields } = req.body as { event: string; [k: string]: unknown };
    if (!event || typeof event !== 'string') throw new AppError('BAD_REQUEST', 'event is required', 400);
    const extra: Record<string, unknown> = {};
    const track: { loc?: string; note?: string; lat?: number; lng?: number; photo?: string } = {};
    if (fields.loc) track.loc = String(fields.loc);
    if (fields.note) track.note = String(fields.note);
    if (fields.lat != null) track.lat = Number(fields.lat);
    if (fields.lng != null) track.lng = Number(fields.lng);
    if (fields.photo) track.photo = String(fields.photo); // 取件/签收照片凭证（防造假）
    if (event === 'dispatch') {
      extra.depart_at = 'now()';
      if (fields.carrier) extra.carrier = String(fields.carrier);
    }
    if (event === 'complete') {
      extra.arrive_at = 'now()';
      extra.sign_at = 'now()';
    }
    const item = await withTenantClient(tenantId, async (client) => {
      // #583 归属守卫：worker 仅可流转自己的运送单
      await loadOwnedOrder(client, tenantId, req.params.id, res.locals.auth, 'transport order');
      return transitionOrder(client, tenantId, req.params.id, event, extra, track, res.locals.auth.userId ?? 'config_role', res.locals.auth.role);
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

export default router;
