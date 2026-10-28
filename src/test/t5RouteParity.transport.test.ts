// t5RouteParity.transport.test.ts —— T5「老路由行为不变 + 双入口对照」护栏。
//
// 【这个文件为什么在 S2 之前就写】
//   S2 是「行为零变化的纯重构」（把 transport.ts 四个 handler 的事务体抽成导出函数）。
//   零变化不能靠"我没改逻辑"这句话，要靠**同一份护栏前后两次跑、输出一致**。
//   ⇒ 本文件就是那把尺子：**A 组（老路由行为快照）在 S2 前后必须逐条同结果**，
//     B/C 组的红在 S2 前后也必须**一模一样**（S2 不许让任何一条红转绿——那反而说明行为变了）。
//
// 【三组断言的分工（改任何一条前先看这段）】
//   A 组「老路由行为快照」——**现在就是绿的，且 S2 之后必须还是绿的**。
//     钉的是 `/transport/orders*` 四个端点的可观察结果（条数/顺序/过滤下推/available/
//     建单字段/流转目标态/非法流转 422）。它转红 = 原生路由行为被改坏了。
//   B 组「双入口对照」——**S5 之后才绿**。同一份夹具分别打 `/transport/orders*`
//     与 `/flow/transport_task*`，断言**落点、条数、状态**一致。
//     现在红，因为 `/flow` 还在写 `business_flow_tasks`（这正是 T5 要修的）。
//   C 组「预期变化对照」——**S5 之后才绿**。R4：代理会带上原生侧两道守卫，
//     ⇒ `/flow` 侧从 200 变 403 是**安全方向的收紧**，本组把它钉成"必须与原生侧同码"。
//
// 【🔴 明确排除（X6）：不许为对上去而补能力】
//   · **tracks**（`transport.ts:204` 手动追加轨迹点）：`/flow` 侧**没有**对应能力，不参与对照；
//   · **work_order 回显**（`transport.ts:117-126` 关联工单）：同上，`/flow` 侧没有。
//   这两项**不在**本文件断言范围内，也不许借代理层偷偷给 `/flow` 补上。
//
// 【转红时的判断顺序（不许反过来）】
//   ① A 组绿不绿？A 组红 ⇒ **原生路由被改坏了**，先修它，**不许动 B/C 组断言**；
//   ② A 组绿、B/C 红 ⇒ 代理还没开/开错了，改代码统一口径，**不许动断言**；
//   ③ A 组绿、B/C 绿 ⇒ T5 完成，此时才谈摘白名单。
//
// 【边界（不要夸大）】
//   DB 客户端按本仓库 `*.http.test.ts` 惯例**替换为桩**（`vi.mock('../db/pool.js')`），
//   **不是 PGlite 真库** ⇒ 能证明"路由发了什么 SQL、返回了什么响应"，
//   不能证明这条 SQL 在真库上一定执行成功。真库层由 `*.pglite.test.ts` 负责。
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

interface CapturedQuery {
  text: string;
  params?: unknown[];
}

const h = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(h.client),
  assertSafeTenantId: (t: string) => t,
  default: { connect: async () => { throw new Error('[t5RouteParity] 单测禁用真实 pool'); } },
}));

import transportRouter from '../routes/transport.js';
import businessFlowRouter from '../routes/businessFlow.js';
import { TRANSPORT_DEF } from '../engine/themes.js';
import { applyEvent, availableTransitions } from '../engine/stateMachine.js';
import { errorMiddleware } from '../middleware/error.js';

const TENANT = 't-t5';
const ORDER_ID = 'to-1';
/** 一个 TRANSPORT_DEF 里绝对不存在的事件名：用于"非法流转必须 422"的断言。 */
const ILLEGAL_EVENT = '__t5_no_such_event__';

// 原生列表的"数据库返回行"：顺序故意做成 created_at 倒序（最新在前），
// 用来断言路由**不重排、不丢行**（排序本身是 SQL 的 ORDER BY 负责的）。
const NATIVE_LIST_ROWS = [
  { id: 'to-3', status: 'pending', created_at: '2026-10-03T00:00:00Z', work_order_id: null },
  { id: 'to-2', status: 'pending', created_at: '2026-10-02T00:00:00Z', work_order_id: null },
  { id: 'to-1', status: 'pending', created_at: '2026-10-01T00:00:00Z', work_order_id: null },
];
/** 路由给每行补 `work_order`（无关联工单 ⇒ null），所以期望值 = 原行 + work_order:null */
const NATIVE_LIST_EXPECTED = NATIVE_LIST_ROWS.map((r) => ({ ...r, work_order: null }));
const TRACK_ROWS = [{ id: 'tp-1', event: 'dispatch', loc: '检验科' }];

/**
 * 建单 INSERT 的 `RETURNING *` 行（生产会带回整行）。
 * 🔴 为什么提成常量：洞② 之后**建单的响应体来自派单那条 UPDATE 的 RETURNING，不再来自 INSERT**
 *    ⇒ UPDATE 桩也必须回"整行"，否则 A3 的「201 响应外壳 / item_name」断言是假绿
 *    （拿到了一条残缺行还说通过了）。两处共用同一份骨架，避免两处各写一半字段。
 */
const INSERTED_ORDER_ROW = {
  id: 'to-new',
  status: TRANSPORT_DEF.initial,
  item_name: '标本',
  priority: 'urgent',
  carrier: null as string | null,
};

/** `/flow` 侧（business_flow_tasks）的假数据：id 前缀故意与原生不同，便于一眼看出落点。 */
const BFT_LIST_ROWS = [
  { id: 'bft-2', entity_type: 'transport_task', status: TRANSPORT_DEF.initial },
  { id: 'bft-1', entity_type: 'transport_task', status: TRANSPORT_DEF.initial },
];

interface ClientOpts {
  /** 单条运送单的当前状态（detail / transition 用） */
  orderStatus: string;
  /** 该单的 carrier（归属守卫视它为 owner） */
  carrier: string;
  /** `SELECT id FROM worker ...` 的返回：当前 worker 的真实业务 id */
  workerId: string;
  /** `/flow` 侧单条行的当前状态 */
  bftStatus: string;
  /**
   * T8 第十三批：`role_permission` 的覆盖行。undefined = 无覆盖行（回退默认矩阵）。
   * 🔴 **为什么必须显式兜住这条**：本桩兜底返回 `{ rows: [], rowCount: 1 }`，
   *   而 `hasPerm`(role.ts:457) 是**按 rowCount 判定**覆盖行（`if (r.rowCount && r.rowCount > 0)`）
   *   ⇒ 走兜底会让所有非 admin 角色「命中空覆盖集」⇒ 恒 403，**回退不到默认矩阵**。
   *   不修这条，下面 D 组的 operator 放行根本测不出来（得到的是假结论）。
   */
  permRows?: { perm: string }[];
}


function makeClient(o: ClientOpts) {
  const calls: CapturedQuery[] = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      const p = params ?? [];
      // T8 第十三批：权限查询必须**显式返回 rowCount = rows.length**（见 ClientOpts.permRows 注释）
      if (text.includes('SELECT perm FROM role_permission')) {
        const rows = (o.permRows ?? []).map((r) => ({ ...r }));
        return { rows, rowCount: rows.length };
      }
      if (text.includes('INSERT INTO domain_event')) return { rows: [], rowCount: 1 };
      // workflow_def 查不到 ⇒ getWorkflowDefOrDefault 回退内置 TRANSPORT_DEF
      if (text.includes('FROM workflow_def')) return { rows: [], rowCount: 0 };
      // 关联工单回显（X6 明确排除：不参与对照，只需让路由安全降级为 null）
      if (text.includes('FROM work_orders')) return { rows: [], rowCount: 0 };
      // 🔴 洞② 之后这条桩**必须**是"真实在岗工人"，只回 `{ id }` 是假绿温床：
      //   `createOrder` 建完单会调 `autoDispatchTransportOrder`，它查
      //   `SELECT id, skill_tags, load, active FROM worker` 并把结果交给 `pickWorker`
      //   选人；`pickWorker` 的第一道过滤就是 `w.active`。缺 `active` ⇒ 恒"派不中"
      //   ⇒ 建单恒停在 pending ⇒ 任何"建单后应为 assigned"的断言都会假装通过。
      //   生产上是有在岗工人的 ⇒ 夹具按生产真相补齐（least_load 用 load 排序）。
      if (text.includes('FROM worker')) {
        return { rows: [{ id: o.workerId, active: true, load: 0, skill_tags: '[]' }], rowCount: 1 };
      }
      if (text.includes('INSERT INTO transport_track_point')) return { rows: [{ id: 'tp-1' }], rowCount: 1 };
      if (text.includes('FROM transport_track_point')) return { rows: TRACK_ROWS.map((r) => ({ ...r })), rowCount: TRACK_ROWS.length };
      if (text.includes('INSERT INTO transport_order')) {
        return {
          rows: [{ ...INSERTED_ORDER_ROW, item_name: String(p[2]), priority: String(p[6]) }],
          rowCount: 1,
        };
      }
      if (text.includes('UPDATE transport_order')) {
        // `RETURNING *` ⇒ 回整行（见 INSERTED_ORDER_ROW 注释）。$4 起才是 extra 列，
        // 建单自动派单时 extra = { carrier, depart_at:'now()' } ⇒ p[3] 就是写入的 carrier。
        return {
          rows: [{ ...INSERTED_ORDER_ROW, id: String(p[0]), status: String(p[2]), carrier: (p[3] as string) ?? null }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM transport_order') && text.includes('ORDER BY')) {
        return { rows: NATIVE_LIST_ROWS.map((r) => ({ ...r })), rowCount: NATIVE_LIST_ROWS.length };
      }
      if (text.includes('FROM transport_order') && text.startsWith('SELECT id, carrier')) {
        return { rows: [{ id: ORDER_ID, carrier: o.carrier }], rowCount: 1 };
      }
      if (text.includes('FROM transport_order')) {
        return { rows: [{ id: ORDER_ID, status: o.orderStatus, carrier: o.carrier, work_order_id: null }], rowCount: 1 };
      }
      // ---- business_flow_tasks（/flow 侧）----
      if (text.includes('INSERT INTO business_flow_tasks')) {
        return { rows: [{ id: 'bft-new', entity_type: 'transport_task', status: TRANSPORT_DEF.initial }], rowCount: 1 };
      }
      if (text.includes('UPDATE business_flow_tasks')) {
        return { rows: [{ id: String(p[0]), entity_type: 'transport_task', status: String(p[2]) }], rowCount: 1 };
      }
      if (text.includes('FROM business_flow_tasks') && text.includes('ORDER BY')) {
        return { rows: BFT_LIST_ROWS.map((r) => ({ ...r })), rowCount: BFT_LIST_ROWS.length };
      }
      if (text.includes('FROM business_flow_tasks')) {
        return { rows: [{ id: 'bft-1', entity_type: 'transport_task', status: o.bftStatus }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return { client, calls };
}

interface ListenResult {
  server: Server;
  url: string;
}

async function listen(app: express.Express): Promise<ListenResult> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}` };
}

/** `role`/`userId` 可换：C 组要用 worker 角色验证两道守卫。 */
function appWith(router: express.Router, mountPath: string, role = 'admin', userId = 'u-admin'): express.Express {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = {
      tenantId: TENANT,
      requestId: 'rid-t5',
      role,
      userId,
      username: role,
      authMode: 'prod',
    };
    next();
  });
  app.use(mountPath, router);
  app.use(errorMiddleware);
  return app;
}

function countSql(calls: CapturedQuery[], needle: string): number {
  return calls.filter((c) => c.text.includes(needle)).length;
}

/**
 * domain_event 的**实体口径**序列（参数序见 `db/eventBus.ts`：$2 = entity_type）。
 * ⚠️ 函数名里的 "Types" 指的是 entity_type，不是事件名——事件名见 `domainEventKinds`。
 */
function domainEventTypes(calls: CapturedQuery[]): string[] {
  return calls
    .filter((c) => c.text.includes('INSERT INTO domain_event'))
    .map((c) => String((c.params ?? [])[1]));
}

/** domain_event 的**事件名**序列（参数序见 `db/eventBus.ts`：$4 = type）。 */
function domainEventKinds(calls: CapturedQuery[]): string[] {
  return calls
    .filter((c) => c.text.includes('INSERT INTO domain_event'))
    .map((c) => String((c.params ?? [])[3]));
}

/** 从 TRANSPORT_DEF 里挑一条"admin 能走"的合法流转，避免把夹具写成硬编码状态。 */
function legalTransition(from: string, role: string): { event: string; to: string } {
  const t = (TRANSPORT_DEF as { transitions: Array<{ from: string; to: string; event: string; allowedRoles?: string[] }> })
    .transitions.find(
      (x) => x.from === from && (!x.allowedRoles || x.allowedRoles.length === 0 || x.allowedRoles.includes(role)),
    );
  if (!t) throw new Error(`[夹具] TRANSPORT_DEF 里找不到 ${role} 可从 ${from} 发起的流转，夹具需同步更新`);
  return { event: t.event, to: t.to };
}

async function post(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function get(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

// ═══════════════════════════════════════════════════════════════════════════
// A 组：老路由（/transport/orders*）行为快照 —— ★S2 前必须全绿，S2 后必须仍全绿★
//
// ⚠️ A3 已随洞②（建单后自动派单）同步为新行为：建单响应态 = assigned（不再是 initial/pending），
//    事件序列 = create → dispatch。**它此前恰好是绿的纯属夹具巧合**（worker 桩行缺 `active`
//    ⇒ pickWorker 恒派不中），不是"洞② 没生效"。夹具已按生产真相补成在岗工人，见 `makeClient`
//    里 `FROM worker` 那条分支的注释——**改夹具前先读那段**，别把巧合再请回来。
// ═══════════════════════════════════════════════════════════════════════════
describe('T5/S6a-A 老路由行为快照（S2 前后必须一致）', () => {
  it('A1 list：条数与顺序原样透传，status 过滤真的下推到 SQL', async () => {
    const { client, calls } = makeClient({ orderStatus: 'pending', carrier: 'w-1', workerId: 'w-1', bftStatus: 'pending' });
    h.client = client;
    const app = await listen(appWith(transportRouter, '/transport'));
    const { status, body } = await get(`${app.url}/transport/orders?status=pending`);
    app.server.close();

    expect(status, '列表端点应当跑通（跑不通是端点问题，不是对照结论）').toBe(200);
    expect(body.ok).toBe(true);
    expect(body.code).toBe(0);
    expect(body.items, '列表必须条数不丢、顺序不重排（排序由 SQL 的 ORDER BY 负责）').toEqual(NATIVE_LIST_EXPECTED);

    const listSql = calls.find((c) => c.text.includes('FROM transport_order') && c.text.includes('ORDER BY created_at DESC'));
    expect(listSql, '没发列表 SQL ⇒ 夹具没跑到位').toBeTruthy();
    expect(listSql!.params, 'status 过滤必须作为参数下推，不能拉全表再在内存里筛').toEqual([TENANT, 'pending']);
  });

  it('A2 detail：available 由引擎现算，tracks 与 work_order 原样带回', async () => {
    const { client } = makeClient({ orderStatus: 'pending', carrier: 'w-1', workerId: 'w-1', bftStatus: 'pending' });
    h.client = client;
    const app = await listen(appWith(transportRouter, '/transport'));
    const { status, body } = await get(`${app.url}/transport/orders/${ORDER_ID}`);
    app.server.close();

    expect(status).toBe(200);
    expect(body.item.id).toBe(ORDER_ID);
    // available 不是硬编码列表，而是引擎按 def + 当前 status 现算的结果
    expect(body.item.available).toEqual(availableTransitions(TRANSPORT_DEF, 'pending'));
    expect(body.item.tracks).toEqual(TRACK_ROWS);
    expect(body.item.work_order).toBeNull();
  });

  it('A3 create：INSERT 字段逐位一致 + 201 响应外壳 + 事件口径 transport_order', async () => {
    const { client, calls } = makeClient({ orderStatus: 'pending', carrier: 'w-1', workerId: 'w-1', bftStatus: 'pending' });
    h.client = client;
    const app = await listen(appWith(transportRouter, '/transport'));
    const { status, body } = await post(`${app.url}/transport/orders`, {
      item_name: '标本',
      from_loc: '检验科',
      to_loc: '3 楼',
      priority: 'urgent',
    });
    app.server.close();

    expect(status).toBe(201);
    expect(body.ok).toBe(true);
    // 洞②（建单后自动派单）：夹具里有**在岗工人** ⇒ 建单即被派出去，响应态不再是 initial(pending)。
    // 🔴 这条此前断言 `TRANSPORT_DEF.initial`，在洞② 之后**只是靠夹具巧合才绿**：
    //    worker 桩行缺 `active` ⇒ `pickWorker` 恒派不中 ⇒ 状态仍是 pending ⇒ 断言恰好通过。
    //    夹具已按生产真相补成在岗工人，断言同步到新行为。
    expect(body.item.status, '建单即自动派单：有在岗工人时响应态必须是 assigned，不再是 pending').toBe('assigned');
    expect(body.item.carrier, '派中的工人必须写回 carrier（否则前端看不到"派给了谁"）').toBe('w-1');
    expect(body.item.item_name).toBe('标本');

    const ins = calls.find((c) => c.text.includes('INSERT INTO transport_order'));
    expect(ins, '没发建单 SQL ⇒ 夹具没跑到位').toBeTruthy();
    const p = ins!.params ?? [];
    // INSERT 列顺序见 transport.ts：tenant_id, code, item_name, from_loc, to_loc, carrier,
    //                            priority, plan_depart_at, item_category, order_type, work_order_id, sla_due_at
    expect(p[0], '$1 = tenant_id').toBe(TENANT);
    expect(p[2], '$3 = item_name').toBe('标本');
    expect(p[3], '$4 = from_loc').toBe('检验科');
    expect(p[4], '$5 = to_loc').toBe('3 楼');
    expect(p[6], '$7 = priority（显式传 urgent）').toBe('urgent');
    expect(p[9], '$10 = order_type（zod 默认 scheduled）').toBe('scheduled');
    expect(p[10], '$11 = work_order_id（未传 ⇒ null）').toBeNull();

    // 洞② 后建单留两条事件：create（建单）+ dispatch（自动派单）；
    // 两条的实体口径都必须是 transport_order（D1 永久双名：表名/def 是 transport_task，事件是 transport_order）。
    expect(domainEventTypes(calls)).toEqual(['transport_order', 'transport_order']);
    expect(domainEventKinds(calls), '建单后必须留下 dispatch 事件（建单即派单；只有 create = 派单没发生）').toEqual([
      'create',
      'dispatch',
    ]);
  });

  it('A4 transition：合法流转到目标态，非法流转 422', async () => {
    const from = 'pending';
    const { event, to } = legalTransition(from, 'admin');

    const ok = makeClient({ orderStatus: from, carrier: 'w-1', workerId: 'w-1', bftStatus: from });
    h.client = ok.client;
    const appOk = await listen(appWith(transportRouter, '/transport'));
    const legal = await post(`${appOk.url}/transport/orders/${ORDER_ID}/transition`, { event });
    appOk.server.close();
    expect(legal.status, '合法流转应当 200（不 200 是端点/夹具问题）').toBe(200);
    expect(legal.body.item.status, `合法流转后状态必须是引擎算出的 ${to}`).toBe(applyEvent(TRANSPORT_DEF, from, event));

    const bad = makeClient({ orderStatus: from, carrier: 'w-1', workerId: 'w-1', bftStatus: from });
    h.client = bad.client;
    const appBad = await listen(appWith(transportRouter, '/transport'));
    const illegal = await post(`${appBad.url}/transport/orders/${ORDER_ID}/transition`, { event: ILLEGAL_EVENT });
    appBad.server.close();
    expect(illegal.status, 'def 里不存在的事件必须 422，不能放行也不能 500').toBe(422);
    expect(illegal.body.code ?? illegal.body.error).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B 组：双入口对照 —— 同一份夹具打两条路由，结果必须一致（S5 后绿）
// ═══════════════════════════════════════════════════════════════════════════
describe('T5/S6a-B 双入口对照（同一笔运送业务，两条通道必须落到同一张表同一结果）', () => {
  it('🔴 B1 建单落点：/flow/transport_task 必须真写 transport_order，且不碰 business_flow_tasks', async () => {
    const native = makeClient({ orderStatus: 'pending', carrier: 'w-1', workerId: 'w-1', bftStatus: 'pending' });
    h.client = native.client;
    const appA = await listen(appWith(transportRouter, '/transport'));
    await post(`${appA.url}/transport/orders`, { item_name: '标本' });
    appA.server.close();
    expect(countSql(native.calls, 'INSERT INTO transport_order'), '原生侧应当写 transport_order').toBe(1);

    const flow = makeClient({ orderStatus: 'pending', carrier: 'w-1', workerId: 'w-1', bftStatus: 'pending' });
    h.client = flow.client;
    const appB = await listen(appWith(businessFlowRouter, '/flow'));
    const resB = await post(`${appB.url}/flow/transport_task`, { title: '送标本到 3 楼检验科' });
    appB.server.close();
    expect(resB.status, '/flow 建单应当跑通（跑不通是端点问题，不是对照结论）').toBe(201);

    expect(
      countSql(flow.calls, 'INSERT INTO business_flow_tasks'),
      '同一笔运送业务被写进了 business_flow_tasks：与原生侧 transport_order 异表双轨，' +
        '下游按表聚合时一笔业务只算到一半 ⇒ /flow 必须改走原生表',
    ).toBe(0);
    expect(
      countSql(flow.calls, 'INSERT INTO transport_order'),
      '/flow 建单没有落到原生表 transport_order ⇒ 两条通道仍然各写各的',
    ).toBe(1);
  });

  it('🔴 B2 列表：/flow/transport_task 的条数/顺序/available 必须与原生一致', async () => {
    const native = makeClient({ orderStatus: 'pending', carrier: 'w-1', workerId: 'w-1', bftStatus: 'pending' });
    h.client = native.client;
    const appA = await listen(appWith(transportRouter, '/transport'));
    const a = await get(`${appA.url}/transport/orders?status=pending`);
    appA.server.close();

    const flow = makeClient({ orderStatus: 'pending', carrier: 'w-1', workerId: 'w-1', bftStatus: 'pending' });
    h.client = flow.client;
    const appB = await listen(appWith(businessFlowRouter, '/flow'));
    const b = await get(`${appB.url}/flow/transport_task?status=pending`);
    appB.server.close();

    const idsA = (a.body.items ?? []).map((x: any) => x.id);
    const idsB = (b.body.items ?? []).map((x: any) => x.id);
    expect(idsB, `两条通道看到的不是同一批单：原生 ${JSON.stringify(idsA)} / 通用 ${JSON.stringify(idsB)}`).toEqual(idsA);

    for (const item of b.body.items ?? []) {
      expect(item.available, '/flow 每行也必须带 available（前端据此渲染动作按钮）').toEqual(
        availableTransitions(TRANSPORT_DEF, item.status),
      );
    }
  });

  it('🔴 B3 流转：/flow/transport_task 的流转必须落到 transport_order，目标态与原生一致', async () => {
    const from = 'pending';
    const { event, to } = legalTransition(from, 'admin');
    // dispatch 在 def 里声明了 requiredFields:['assignee']，/flow 侧会校验 ⇒ 夹具必须给
    const body = { event, data: { assignee: 'w-1' } };

    const flow = makeClient({ orderStatus: from, carrier: 'w-1', workerId: 'w-1', bftStatus: from });
    h.client = flow.client;
    const appB = await listen(appWith(businessFlowRouter, '/flow'));
    const b = await post(`${appB.url}/flow/transport_task/${ORDER_ID}/transition`, body);
    appB.server.close();

    expect(b.status, '/flow 流转应当跑通（跑不通是端点问题，不是对照结论）').toBe(200);
    expect(b.body.item.status).toBe(to);
    expect(
      countSql(flow.calls, 'UPDATE business_flow_tasks'),
      '/flow 流转还在改 business_flow_tasks ⇒ 与原生侧同一笔业务分落两表，状态各走各的',
    ).toBe(0);
    expect(
      countSql(flow.calls, 'UPDATE transport_order'),
      '/flow 流转没有落到原生表 transport_order ⇒ 两条通道的状态仍然分裂',
    ).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C 组：预期变化对照 —— R4：代理带上原生侧两道守卫 ⇒ /flow 从 200 收紧为 403
// ═══════════════════════════════════════════════════════════════════════════
describe('T5/S6a-C 预期变化对照（R4：/flow 必须带上原生侧两道守卫）', () => {
  it('🔴 C1 归属守卫：worker 转他人单，/flow 必须与原生同码 403', async () => {
    const from = 'assigned';
    const { event } = legalTransition(from, 'worker'); // receive：worker 在 allowedRoles 内

    const native = makeClient({ orderStatus: from, carrier: 'w-1', workerId: 'w-2', bftStatus: from });
    h.client = native.client;
    const appA = await listen(appWith(transportRouter, '/transport', 'worker', 'u-w2'));
    const a = await post(`${appA.url}/transport/orders/${ORDER_ID}/transition`, { event });
    appA.server.close();
    expect(a.status, '原生侧：worker 转他人单必须 403（这是既有守卫，不该被改掉）').toBe(403);

    const flow = makeClient({ orderStatus: from, carrier: 'w-1', workerId: 'w-2', bftStatus: from });
    h.client = flow.client;
    const appB = await listen(appWith(businessFlowRouter, '/flow', 'worker', 'u-w2'));
    const b = await post(`${appB.url}/flow/transport_task/${ORDER_ID}/transition`, { event, data: {} });
    appB.server.close();

    expect(
      b.status,
      `/flow 侧 worker 转他人单返回 ${b.status}，原生侧是 ${a.status}：` +
        '代理后必须带上 #583 归属守卫（安全方向收紧，R4 已接受）',
    ).toBe(a.status);
  });

  it('🔴 C2 角色门禁：def 的 allowedRoles 不含当前角色，/flow 必须与原生同码 403', async () => {
    const from = 'pending';
    // dispatch 的 allowedRoles = ['admin','operator']，不含 worker；归属守卫放行（owner 就是本人）
    const event = 'dispatch';
    const body = { event, data: { assignee: 'w-1' } };

    const native = makeClient({ orderStatus: from, carrier: 'w-1', workerId: 'w-1', bftStatus: from });
    h.client = native.client;
    const appA = await listen(appWith(transportRouter, '/transport', 'worker', 'u-w1'));
    const a = await post(`${appA.url}/transport/orders/${ORDER_ID}/transition`, body);
    appA.server.close();
    expect(a.status, '原生侧：allowedRoles 不含 worker 必须 403（N5 修复引入的既有门禁）').toBe(403);

    const flow = makeClient({ orderStatus: from, carrier: 'w-1', workerId: 'w-1', bftStatus: from });
    h.client = flow.client;
    const appB = await listen(appWith(businessFlowRouter, '/flow', 'worker', 'u-w1'));
    const b = await post(`${appB.url}/flow/transport_task/${ORDER_ID}/transition`, body);
    appB.server.close();

    expect(
      b.status,
      `/flow 侧返回 ${b.status}，原生侧是 ${a.status}：` +
        'def 声明 allowedRoles 时，/flow 也必须照章拒绝（否则代理等于开了一条绕过角色门禁的后门）',
    ).toBe(a.status);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T8 第十三批 D 组：双入口**权限**对照（B/C 组对照落点与状态码，本组对照权限判定）
//
// 🔴 **为什么这两个端点必须挂同一个权限点（改任何一处前先读）**：
//   `transportAdapter.create`(transportAdapter.ts:174) 与 `POST /transport/orders`(transport.ts:283)
//   **调用同一个 `createOrder`、写同一张表 `transport_order`**；而 `FLOW_PROXY`(flowProxy.ts:194)
//   把 `transport_task` 代理到该 adapter ⇒ **`POST /flow/transport_task` 是同一笔业务的第二个入口**。
//   ⇒ 两处若挂不同权限点，租户配完会出现「走 /transport/orders 建得了单、走 /flow/transport_task
//   建不了」（或反之）—— 这正是 T8 要消灭的病：**同一动作从不同入口进，答案不同**。
//   ⇒ 本组每条断言都同时打两个入口并要求**同码**：谁把它们改回两个权限点，这里立刻红。
// ═══════════════════════════════════════════════════════════════════════════
describe('T8 第十三批 · 双入口权限对照（同一动作两通道必须同码）', () => {
  const NATIVE_BODY = { item_name: '标本' };
  const FLOW_BODY = { title: '送标本到 3 楼检验科' };

  /** 同一角色分别打两个入口，返回各自状态码。 */
  async function bothEntries(role: string, permRows?: { perm: string }[]): Promise<{ native: number; flow: number }> {
    const opts: ClientOpts = {
      orderStatus: 'pending',
      carrier: 'w-1',
      workerId: 'w-1',
      bftStatus: 'pending',
      permRows,
    };
    const native = makeClient(opts);
    h.client = native.client;
    const appA = await listen(appWith(transportRouter, '/transport', role));
    const a = await post(`${appA.url}/transport/orders`, NATIVE_BODY);
    appA.server.close();

    const flow = makeClient(opts);
    h.client = flow.client;
    const appB = await listen(appWith(businessFlowRouter, '/flow', role));
    const b = await post(`${appB.url}/flow/transport_task`, FLOW_BODY);
    appB.server.close();
    return { native: a.status, flow: b.status };
  }

  // D1 是**等价性锚**：收敛不许改变现有放行分布 ⇒ 改前改后都必须绿。
  it('D1 等价性：worker 两通道同码 403；operator 两通道同码 201', async () => {
    const w = await bothEntries('worker');
    expect(w.native).toBe(403);
    expect(w.flow, 'worker 走 /flow 建单必须与原生同码：不同码说明两处守卫口径分叉了').toBe(403);

    const o = await bothEntries('operator');
    expect(o.native).toBe(201);
    expect(o.flow, 'operator 走 /flow 建单必须与原生同码').toBe(201);
  });

  // D2 是**价值锚**：requireConfigRole 只读角色白名单、不查权限表 ⇒ 授予也放不了行 ⇒ 改前必红。
  it('D2 可配置性：授 flow.create 给 reviewer ⇒ 两通道同时从 403 转 201（改前必红）', async () => {
    const before = await bothEntries('reviewer');
    expect(before.native).toBe(403);
    expect(before.flow).toBe(403);

    const after = await bothEntries('reviewer', [{ perm: 'flow.create' }]);
    expect(after.native).toBe(201);
    expect(after.flow, '两条通道必须一起放行：只放一条 = 同一个动作出现两个答案').toBe(201);
  });

  // D3 是**反例锚**：钉住「没授权就是不放行」，防止将来有人图省事把守卫挂到一个谁都有的权限点上。
  it('D3 反例锚：reviewer 授的不是 flow.create ⇒ 两通道仍同码 403', async () => {
    const r = await bothEntries('reviewer', [{ perm: 'ticket.manage' }]);
    expect(r.native).toBe(403);
    expect(r.flow).toBe(403);
  });
});
