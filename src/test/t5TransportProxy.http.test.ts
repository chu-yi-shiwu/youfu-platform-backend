// t5TransportProxy.http.test.ts —— T5「写入落点 + 事件口径」护栏（S6b）。
//
// 【钉的是什么】
//   同一笔运送业务，`/transport/orders*`（原生）写 `transport_order`，
//   `/flow/transport_task*`（通用通道）写 `business_flow_tasks` ⇒ **异表双轨**。
//   本文件断言：代理开起来之后，`/flow` 侧必须
//     ① **不再碰** `business_flow_tasks`；
//     ② **真写** `transport_order`；
//     ③ `domain_event.entity_type` 与原生侧**相同**（D1 裁定的 `transport_order`）。
//
// 【夹具沿用】
//   `makeClient` / `appWith` 与 `t5EventEntityType.http.test.ts:64-136` 同口径
//   （DB 桩 + express 真起服务 + 真发 HTTP）。🔴 `t5EventEntityType.http.test.ts` **保持不动**：
//   它钉的是"两条通道口径必须一致"这条**独立的**语义，本文件钉的是"落点"，两者不互相替代。
//
// 【🔴 必须留一条对照绿：未代理实体不许被顺手改坏】
//   `cycle_check` **不在** registry 里（D3：本期只代理 transport_task）⇒ 它必须
//   **照旧**写 `business_flow_tasks`。这条是本文件的"哨兵"：
//   它要是红了，说明分派写成了"全部走代理"，那不是修 bug，是把半个系统的落点搬家。
//
// 【转红时的判断顺序（不许反过来）】
//   ① 先看**两条对照绿**（cycle_check 落点 / 原生侧实拍）绿不绿：
//      它们红 ⇒ 端点/夹具坏了，先修，**不许动断言**；
//   ② 它们绿、三条红 ⇒ 代理没开或开错，改代码，**不许动断言**；
//   ③ 全绿 ⇒ T5 落点已统一。
//
// 【边界（不要夸大）】
//   DB 是**桩**（`vi.mock('../db/pool.js')`）⇒ 证明的是"路由发了什么 SQL、写下什么 entity_type"，
//   不证明这条 SQL 在真库上一定跑得通（真库层由 `*.pglite.test.ts` 负责）。
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WorkflowDef } from '../engine/stateMachine.js';

interface CapturedQuery {
  text: string;
  params?: unknown[];
}

const h = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(h.client),
  assertSafeTenantId: (t: string) => t,
  default: { connect: async () => { throw new Error('[t5TransportProxy] 单测禁用真实 pool'); } },
}));

import transportRouter from '../routes/transport.js';
import businessFlowRouter from '../routes/businessFlow.js';
import { TRANSPORT_DEF } from '../engine/themes.js';
import { errorMiddleware } from '../middleware/error.js';

const TENANT = 't-t5';
const ORDER_ID = 'to-1';
// 静态断言读源码原文：DB 是桩，但「代码里调的是哪个函数、传的是哪个实参」只能看原文才验得到。
const BUSINESSFLOW_SRC = readFileSync(join(__dirname, '..', 'routes', 'businessFlow.ts'), 'utf8');

/** 夹具：记录每条 SQL，并对特定语句给出让流程走通的最小返回（与 t5EventEntityType 同口径）。 */
function makeClient() {
  const calls: CapturedQuery[] = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      const p = params ?? [];
      if (text.includes('INSERT INTO domain_event')) return { rows: [], rowCount: 1 };
      // T1-B 批3：桩刻意返 **5**（非 0）。桩值若等于「错误实现的默认值（写死 0 = 永不上锁）」，
      //   断言就会恒绿 —— 那是本项目最严重的一种错（与批 2 的 http 桩同款铁律）。
      if (text.includes('SELECT version FROM workflow_def')) return { rows: [{ version: 5 }], rowCount: 1 };
      if (text.includes('FROM workflow_def')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM work_orders')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM worker')) return { rows: [{ id: 'w-1' }], rowCount: 1 };
      if (text.includes('INSERT INTO transport_track_point')) return { rows: [{ id: 'tp-1' }], rowCount: 1 };
      if (text.includes('FROM transport_track_point')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO transport_order')) {
        return { rows: [{ id: 'to-new', status: TRANSPORT_DEF.initial, item_name: String(p[2]) }], rowCount: 1 };
      }
      if (text.includes('UPDATE transport_order')) return { rows: [{ id: String(p[0]), status: String(p[2]) }], rowCount: 1 };
      if (text.includes('FROM transport_order') && text.startsWith('SELECT id, carrier')) {
        return { rows: [{ id: ORDER_ID, carrier: 'w-1' }], rowCount: 1 };
      }
      if (text.includes('FROM transport_order') && text.includes('ORDER BY')) {
        return { rows: [{ id: 'to-2', status: TRANSPORT_DEF.initial }, { id: 'to-1', status: TRANSPORT_DEF.initial }], rowCount: 2 };
      }
      if (text.includes('FROM transport_order')) {
        return { rows: [{ id: ORDER_ID, status: TRANSPORT_DEF.initial, carrier: 'w-1', work_order_id: null }], rowCount: 1 };
      }
      if (text.includes('INSERT INTO business_flow_tasks')) {
        return { rows: [{ id: 'bft-1', entity_type: String(p[1]), status: 'draft' }], rowCount: 1 };
      }
      if (text.includes('UPDATE business_flow_tasks')) {
        return { rows: [{ id: String(p[0]), entity_type: 'transport_task', status: String(p[2]) }], rowCount: 1 };
      }
      if (text.includes('FROM business_flow_tasks') && text.includes('ORDER BY')) {
        return { rows: [{ id: 'bft-2', entity_type: 'transport_task', status: 'draft' }], rowCount: 1 };
      }
      if (text.includes('FROM business_flow_tasks')) {
        return { rows: [{ id: 'bft-1', entity_type: 'transport_task', status: TRANSPORT_DEF.initial }], rowCount: 1 };
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

/** 造一个"已登录的 admin"：requireConfigRole / requireAssigneeOrConfig 都对 admin 放行。 */
function appWith(router: express.Router, mountPath: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = {
      tenantId: TENANT,
      requestId: 'rid-t5',
      role: 'admin',
      userId: 'u-admin',
      username: 'admin',
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

/** domain_event 的 INSERT 参数顺序见 src/db/eventBus.ts：$1 tenant_id / $2 entity_type */
function eventTypes(calls: CapturedQuery[]): string[] {
  return calls.filter((c) => c.text.includes('INSERT INTO domain_event')).map((c) => String((c.params ?? [])[1]));
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

describe('T5/S6b 写入落点 + 事件口径', () => {
  it('🔴 建单落点：/flow/transport_task 不再写 business_flow_tasks，真写 transport_order', async () => {
    const flow = makeClient();
    h.client = flow.client;
    const app = await listen(appWith(businessFlowRouter, '/flow'));
    const res = await post(`${app.url}/flow/transport_task`, { title: '送标本到 3 楼检验科' });
    app.server.close();
    expect(res.status, '/flow 建单应当跑通（跑不通是端点问题，不是落点结论）').toBe(201);

    expect(
      countSql(flow.calls, 'INSERT INTO business_flow_tasks'),
      '运送建单仍落在 business_flow_tasks：与原生侧 transport_order 异表双轨，' +
        '下游按表统计时这笔业务根本不在运送表里',
    ).toBe(0);
    expect(
      countSql(flow.calls, 'INSERT INTO transport_order'),
      '运送建单没有落到原生表 transport_order ⇒ 两条通道仍然各写各的',
    ).toBe(1);
  });

  it('🔴 事件口径：/flow 与原生侧写进 domain_event 的 entity_type 必须相同', async () => {
    const native = makeClient();
    h.client = native.client;
    const appA = await listen(appWith(transportRouter, '/transport'));
    const a = await post(`${appA.url}/transport/orders`, { item_name: '标本' });
    appA.server.close();
    expect(a.status, '原生侧建单应当跑通').toBe(201);
    const typeA = eventTypes(native.calls);
    expect(typeA.length, '原生侧没写 domain_event ⇒ 夹具没跑到位').toBe(1);

    const flow = makeClient();
    h.client = flow.client;
    const appB = await listen(appWith(businessFlowRouter, '/flow'));
    const b = await post(`${appB.url}/flow/transport_task`, { title: '送标本到 3 楼检验科' });
    appB.server.close();
    expect(b.status, '/flow 建单应当跑通').toBe(201);
    const typeB = eventTypes(flow.calls);
    expect(typeB.length, '/flow 没写 domain_event ⇒ 夹具没跑到位').toBe(1);

    expect(
      typeB,
      `事件口径断裂：原生路由记 ${typeA[0]}、通用通道记 ${typeB[0]}。` +
        '下游按 entity_type 聚合/订阅时，同一笔运送业务会被算成两个实体',
    ).toEqual(typeA);
    // D1 裁定的落点：统一到原生名（不是反过来把原生改成 transport_task）
    expect(typeB[0]).toBe('transport_order');
  });

  it('🔴 列表查询源：/flow/transport_task 不再查 business_flow_tasks', async () => {
    const flow = makeClient();
    h.client = flow.client;
    const app = await listen(appWith(businessFlowRouter, '/flow'));
    const res = await get(`${app.url}/flow/transport_task`);
    app.server.close();
    expect(res.status, '/flow 列表应当跑通').toBe(200);

    expect(
      countSql(flow.calls, 'FROM business_flow_tasks'),
      '/flow 仍在查 business_flow_tasks ⇒ 列表看到的是另一张表的行，' +
        '与 /transport/orders 看到的不是同一批单',
    ).toBe(0);
    expect(
      countSql(flow.calls, 'FROM transport_order'),
      '/flow 列表没有查原生表 transport_order ⇒ 双轨未收口',
    ).toBeGreaterThan(0);
  });

  it('对照（守卫·绿）：cycle_check 未代理 ⇒ 照旧写 business_flow_tasks', async () => {
    // D3：本期只代理 transport_task。这条是"分派没有一刀切"的哨兵。
    const flow = makeClient();
    h.client = flow.client;
    const app = await listen(appWith(businessFlowRouter, '/flow'));
    const res = await post(`${app.url}/flow/cycle_check`, { title: '例行巡检' });
    app.server.close();
    expect(res.status).toBe(201);
    expect(
      countSql(flow.calls, 'INSERT INTO business_flow_tasks'),
      '未代理实体必须照旧写 business_flow_tasks —— 若变成 0，说明分派写成了"全部走代理"，' +
        '那不是修 bug，是把半个系统的落点强行搬家',
    ).toBe(1);
    expect(
      countSql(flow.calls, 'INSERT INTO transport_order'),
      'cycle_check 不该写运送表',
    ).toBe(0);
  });

  it('🔴 D2：emergency_plan 收口 —— GET/POST /flow/emergency_plan 返回 410 Gone 并指路', async () => {
    // 🔴 为什么是 410 不是代理、也不是加列：`034_emergency_transport.sql:7-21` 建的
    //    emergency_plan 表**没有 status 列**（只有 enabled 布尔），而 EMERGENCY_DEF 是
    //    6 态状态机 ⇒ 代理**无落点**；且应急预案本质是知识库目录，不是带状态的业务流。
    //    🔴 **明确否决"加 status 列"**：那是生产库 DDL，与"不动存量"冲突。
    const g = makeClient();
    h.client = g.client;
    const appG = await listen(appWith(businessFlowRouter, '/flow'));
    // ⚠️ 别把局部变量命名成 `get` / `post`：本文件顶部有同名 helper（TDZ 会让它们互相遮蔽）
    const got = await fetch(`${appG.url}/flow/emergency_plan`);
    const getBody: any = await got.json().catch(() => ({}));
    appG.server.close();

    expect(got.status, 'GET /flow/emergency_plan 必须 410 Gone（不再是 200 空列表）').toBe(410);
    expect(String(getBody.code ?? ''), '错误码要能一眼看出是"这个入口没了"').toBe('GONE');
    expect(
      JSON.stringify(getBody),
      '响应体必须指路到 /emergency/plans —— 只给 410 不给去处，调用方无从改起',
    ).toMatch(/\/emergency\/plans/);

    const p = makeClient();
    h.client = p.client;
    const appP = await listen(appWith(businessFlowRouter, '/flow'));
    const created = await post(`${appP.url}/flow/emergency_plan`, { title: '火灾应急预案' });
    appP.server.close();

    expect(created.status).toBe(410);
    expect(
      countSql(p.calls, 'INSERT INTO business_flow_tasks'),
      '收口实体不许再建行（410 必须拦在写库之前，不能"报了错也照样写进去"）',
    ).toBe(0);
  });

  it('🔴 D2：/flow/emergency_plan/:id/transition 同样 410（收口要收干净，不留半个入口）', async () => {
    const t = makeClient();
    h.client = t.client;
    const app = await listen(appWith(businessFlowRouter, '/flow'));
    const res = await post(`${app.url}/flow/emergency_plan/ep-1/transition`, { event: 'activate' });
    app.server.close();
    expect(res.status).toBe(410);
    expect(countSql(t.calls, 'UPDATE business_flow_tasks')).toBe(0);
  });

  it('对照（现状实拍·绿）：原生运送路由照旧写 transport_order', async () => {
    const native = makeClient();
    h.client = native.client;
    const app = await listen(appWith(transportRouter, '/transport'));
    const res = await post(`${app.url}/transport/orders`, { item_name: '标本' });
    app.server.close();
    expect(res.status).toBe(201);
    expect(countSql(native.calls, 'INSERT INTO transport_order')).toBe(1);
    expect(countSql(native.calls, 'INSERT INTO business_flow_tasks')).toBe(0);
  });

  // ── D2 收口：`emergency_plan` 不再走 /flow（410 + 指路）────────────────────
  // 【为什么钉这条】`emergency_plan` 表**没有 status 列**（`034_emergency_transport.sql:7-21`
  //   只有 `enabled` 布尔），而 `themes.ts:38-51 EMERGENCY_DEF` 是 6 态状态机 ⇒
  //   **代理无落点**；加列要碰生产库 DDL，与"不动存量"冲突 ⇒ 显式把这个误配入口关掉。
  // 🔴 这三条是**行为级**：断言的是调用方收到的状态码与响应体，不是内部标志位。
  it('🔴 D2 收口：GET /flow/emergency_plan ⇒ 410 Gone，且响应体指路 /emergency/plans', async () => {
    h.client = makeClient().client;
    const app = await listen(appWith(businessFlowRouter, '/flow'));
    const res = await fetch(`${app.url}/flow/emergency_plan`);
    const body = await res.json().catch(() => ({}));
    app.server.close();
    expect(res.status).toBe(410);
    expect(
      JSON.stringify(body),
      '410 必须带指路信息，否则调用方只知道"没了"、不知道该去哪',
    ).toContain('/emergency/plans');
  });

  it('🔴 D2 收口：POST /flow/emergency_plan ⇒ 410，且不许写任何 INSERT', async () => {
    const flow = makeClient();
    h.client = flow.client;
    const app = await listen(appWith(businessFlowRouter, '/flow'));
    const res = await post(`${app.url}/flow/emergency_plan`, { title: '消防演练' });
    app.server.close();
    expect(res.status).toBe(410);
    expect(
      countSql(flow.calls, 'INSERT INTO'),
      '收口入口不许写任何 INSERT —— 写了说明 410 拦截没生效，单还建进去了',
    ).toBe(0);
  });

  it('对照（哨兵·绿）：只收口 emergency_plan，work_order 不许被连带挡掉', async () => {
    h.client = makeClient().client;
    const app = await listen(appWith(businessFlowRouter, '/flow'));
    const res = await post(`${app.url}/flow/work_order`, { title: '报修' });
    app.server.close();
    expect(
      res.status,
      'RETIRED_FLOW_ENDPOINT 若被写成通配，未收口实体会一起 410 —— 那是"关错了门"',
    ).not.toBe(410);
  });
});

// ============================================================
// T1-B 批3 · cycle_check（**未代理**通道）在途单锁版本
// 【为什么钉在 cycle_check 上】transport_task 已被 flowProxy 代理去原生表 transport_order，
//   businessFlow.ts:214 就分派走了 ⇒ 根本走不到本表的 INSERT。cycle_check 是未代理的泛型实体，
//   是全仓唯一能真的驱动到 businessFlow.ts:231 那条 INSERT 的入口（本文件 :223 那条哨兵同理）。
// 【与 *.pglite.test.ts 的分工】那边验「锁了之后行为对不对」（真库 + 真 transitionEntity），
//   这边验「调的是哪个函数、传的是哪个实参、INSERT 带没带列」——桩层互补，缺一边都留缝。
// ============================================================

/** v1：pending --start--> doing（无必填）。老单锁这一版。 */
const CC_V1: WorkflowDef = {
  initial: 'pending',
  states: ['pending', 'doing', 'done'],
  transitions: [{ from: 'pending', to: 'doing', event: 'start' }] as any,
  config: {},
} as WorkflowDef;
/** v2 = v1 + 给 start 边**新增必填 note**。这是 A3b 的判别关键。 */
const CC_V2: WorkflowDef = {
  initial: 'pending',
  states: ['pending', 'doing', 'done'],
  transitions: [{ from: 'pending', to: 'doing', event: 'start', requiredFields: ['note'] }] as any,
  config: {},
} as WorkflowDef;

/**
 * 列表口专用 def 对（A3c）。与 CC_* 分开造（E6）：CC_* 的差别在「必填项」，
 * A3c 要的差别在「v2 多一条边」。两行都停在 **doing** —— v1 在 doing 上只有 finish，
 * v2 多一条 cancel ⇒ 老单（锁 v1）若拿到 cancel 按钮，一眼可见。
 */
const LST_V1: WorkflowDef = {
  initial: 'pending',
  states: ['pending', 'doing', 'done'],
  transitions: [
    { from: 'pending', to: 'doing', event: 'start' },
    { from: 'doing', to: 'done', event: 'finish' },
  ] as any,
  config: {},
} as WorkflowDef;
const LST_V2: WorkflowDef = {
  initial: 'pending',
  states: ['pending', 'doing', 'done', 'cancelled'],
  transitions: [
    { from: 'pending', to: 'doing', event: 'start' },
    { from: 'doing', to: 'done', event: 'finish' },
    { from: 'doing', to: 'cancelled', event: 'cancel' },
  ] as any,
  config: {},
} as WorkflowDef;

/**
 * 专供 A3d 的夹具：**单行老单**（锁 v1，live 已升 v2），停在 doing 上。
 * 与 A3c 的夹具分开造（E6）：两个口子各用各的夹具，改一个不会连带影响另一个。
 */
function makeOldDetailClient() {
  const calls: CapturedQuery[] = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      const p = params ?? [];
      if (text.includes('SELECT version FROM workflow_def')) return { rows: [{ version: 2 }], rowCount: 1 };
      if (text.includes('FROM workflow_def_history')) {
        return { rows: [{ def: p[2] === 1 ? LST_V1 : LST_V2 }], rowCount: 1 };
      }
      if (text.includes('FROM workflow_def')) return { rows: [{ def: LST_V2 }], rowCount: 1 };
      if (text.includes('FROM business_flow_tasks')) {
        return { rows: [{ id: 'bft-old', status: 'doing', def_version: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { client, calls };
}

/**
 * 专供 A3c 的夹具：**同一次列表里混着两个版本**（老行锁 v1、新行锁 v2，live = v2）。
 * 这是抓 R-2 的唯一形态 —— 只放一种版本的话，「N 行共用一个 def」与「分组读」结果相同。
 */
function makeListRowsClient() {
  const calls: CapturedQuery[] = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      const p = params ?? [];
      if (text.includes('SELECT version FROM workflow_def')) return { rows: [{ version: 2 }], rowCount: 1 };
      // history 的 $3 是版本号（workflowDef.ts:556-557）⇒ 按版本分流，不按调用顺序分流。
      if (text.includes('FROM workflow_def_history')) {
        return { rows: [{ def: p[2] === 1 ? LST_V1 : LST_V2 }], rowCount: 1 };
      }
      if (text.includes('FROM workflow_def')) return { rows: [{ def: LST_V2 }], rowCount: 1 };
      if (text.includes('FROM business_flow_tasks')) {
        return {
          rows: [
            { id: 'bft-old', status: 'doing', def_version: 1 },
            { id: 'bft-new', status: 'doing', def_version: 2 },
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { client, calls };
}

/**
 * 专供 A3b 的夹具：**老行锁 v1、live 已升 v2** 的形态。
 * 与 makeClient 分开造，是为了不把「v2 的 start 边有必填」这个前提泄露给同文件其它用例（E6）。
 */
function makeOldRowClient() {
  const calls: CapturedQuery[] = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      const p = params ?? [];
      if (text.includes('INSERT INTO domain_event')) return { rows: [], rowCount: 1 };
      // live 版本号 = 2，而老行锁的是 1 ⇒ 必须真回查 history 拿 v1 快照，而不是顺手用 live。
      if (text.includes('SELECT version FROM workflow_def')) return { rows: [{ version: 2 }], rowCount: 1 };
      if (text.includes('FROM workflow_def_history')) return { rows: [{ def: CC_V1 }], rowCount: 1 };
      if (text.includes('FROM workflow_def')) return { rows: [{ def: CC_V2 }], rowCount: 1 };
      if (text.startsWith('SELECT status, def_version FROM business_flow_tasks')) {
        return { rows: [{ id: String(p[0]), status: 'pending', def_version: 1 }], rowCount: 1 };
      }
      // 🔴 这条兜底**刻意不带 def_version**：真实数据库里没 SELECT 的列就不会出现在行上。
      //    之前它顺手带上 def_version:1，等于替产品把「漏查这一列」的洞填平了 ⇒
      //    把产品 :317 的 `SELECT status, def_version` 改成 `SELECT status`，A3b 照样绿（假绿）。
      //    修法就是让兜底如实反映 SELECT 了什么：漏查 ⇒ 行上没有 ⇒ 流转走 live ⇒ A3b 必红。
      if (text.includes('FROM business_flow_tasks')) {
        return { rows: [{ id: String(p[0]), status: 'pending', data: {} }], rowCount: 1 };
      }
      if (text.includes('UPDATE business_flow_tasks')) {
        return { rows: [{ id: String(p[0]), status: 'doing', def_version: 1, data: {} }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return { client, calls };
}

describe('T1-B 批3 · cycle_check（未代理通道）在途单锁版本', () => {
  it('A4-盖章：POST /flow/cycle_check 把当时的 live 版本号盖进 def_version（10 参，末位 = 5）', async () => {
    const flow = makeClient();
    h.client = flow.client;
    const app = await listen(appWith(businessFlowRouter, '/flow'));
    const res = await post(`${app.url}/flow/cycle_check`, { title: '例行巡检' });
    app.server.close();
    expect(res.status, '未代理实体的建单必须照旧跑通（跑不通是端点问题，不是盖章结论）').toBe(201);

    const ins = flow.calls.filter((c) => c.text.includes('INSERT INTO business_flow_tasks'));
    expect(ins.length, 'cycle_check 必须照旧写 business_flow_tasks（变 0 就是把落点搬了家）').toBe(1);
    const params = ins[0].params ?? [];
    expect(ins[0].text, 'INSERT 列清单必须带上 def_version').toMatch(/created_by,\s*def_version\)/);
    expect(params.length, '原 9 列 + def_version = 10 参').toBe(10);
    expect(params[9], '末位必须是取到的 live 版本号（桩返 5）').toBe(5);
  });

  it('A3-静态：三处读点走版本化 def、列表口走分组，且本文件无读 live 的残留', async () => {
    expect(
      BUSINESSFLOW_SRC.match(/getWorkflowDefAtVersion\(client, tenantId, entityType/g)?.length,
      '建单返回 / 详情 / 流转 三处读点都必须走版本化读取，少一处即 R-1（按钮与实际校验不一致）',
    ).toBe(3);
    expect(
      BUSINESSFLOW_SRC.match(/getDefsForVersions\(client, tenantId, entityType/g)?.length,
      '列表口必须按 def_version 分组（N 行套 1 个 def 在版本化之后不成立）',
    ).toBe(1);
    // 注意：本文件 :61 的注释里也出现过这个名字，但后面没有 `(` ⇒ 这个正则不会误伤。
    expect(
      BUSINESSFLOW_SRC.match(/getWorkflowDefOrDefault\s*\(/g)?.length ?? 0,
      '本文件不该再有读 live 的调用',
    ).toBe(0);
  });

  it('A4-实体名：取版本号传的是变量 entityType，不是表名 business_flow_tasks（D1 双名的另一半）', async () => {
    // 🔴 批 2 的雷是「表 transport_order vs 口径 transport_task」；批 3 反过来：
    //    **表**叫 business_flow_tasks，但 def **口径**是路由传进来的 entityType 变量。
    //    写死成表名（或写死成任何一个具体实体）⇒ 永远返回 0，而且一声不响（E3 反面：静默失败）。
    const m = BUSINESSFLOW_SRC.match(/getWorkflowDefVersion\(client,\s*tenantId,\s*([^)'\s]+)\)/);
    expect(m, '建单处必须有一次 getWorkflowDefVersion 调用').not.toBeNull();
    expect(m![1], '版本号必须按 def 口径取（变量 entityType），不能按表名取').toBe('entityType');
    expect(
      BUSINESSFLOW_SRC.includes(`getWorkflowDefVersion(client, tenantId, 'business_flow_tasks')`),
      '把表名当 def 口径传 ⇒ 永远返回 0 且不报错',
    ).toBe(false);
  });

  it('A3b：老单锁 v1 ⇒ 流转的必填校验也按 v1（v2 新增的必填项不能卡死老单）', async () => {
    // 🔴 改前：必填校验读 live（v2）、流转按行锁的版本（v1）走 ⇒
    //    老单被要求填一个它出生时不存在的字段 note，填了 v1 也不认 ⇒ **死锁**。
    //    这是批 2 补在 transportAdapter.ts:192 的同款原则，批 3 必须同样成立。
    const old = makeOldRowClient();
    h.client = old.client;
    const app = await listen(appWith(businessFlowRouter, '/flow'));
    const res = await post(`${app.url}/flow/cycle_check/bft-1/transition`, { event: 'start' });
    app.server.close();

    expect(
      res.status,
      '老单按 v1 走流转 ⇒ v1 的 start 没有必填项 ⇒ 不传 data 也必须 200。' +
        '若必填校验改成读 live，这里会变成 422 missing required field: note',
    ).toBe(200);
    // 同时锁住「流转确实是按 v1 走的」：v1 里 start 的目标态是 doing。
    const upd = old.calls.filter((c) => c.text.includes('UPDATE business_flow_tasks'));
    expect(upd.length, '流转必须真的落库一次').toBe(1);
    expect((upd[0].params ?? [])[2], 'v1 的 start 目标态 = doing').toBe('doing');
  });

  it('A3c：列表口按行分组给 available —— 老单（锁 v1）拿不到 v2 独有的 cancel 按钮（抓 R-2）', async () => {
    // 🔴 为什么要穿透到列表路由本身：真库那条 A3 是直调 availableTransitions 的，
    //    它只看「给的 def 对不对」，看不见「每一行拿到的是不是自己那一版」。
    //    ⇒ 把 `defs.get(该行版本)` 换成「N 行共用一个 def」，真库 A3 照绿，只有这条会红。
    //    代价对照：共用 def 写着省事，后果是老单凭空多出按钮，点了就是 422。
    const c = makeListRowsClient();
    h.client = c.client;
    const app = await listen(appWith(businessFlowRouter, '/flow'));
    const res = await get(`${app.url}/flow/cycle_check`);
    app.server.close();

    expect(res.status, '列表必须照旧跑通（跑不通是端点问题，不是分组结论）').toBe(200);
    const items = (res.body as any).items ?? [];
    expect(items.length, '夹具给了两行 ⇒ 两行都要回来').toBe(2);

    const evs = (id: string) =>
      (items.find((x: any) => x.id === id)?.available ?? []).map((t: any) => t.event);
    const oldEvs = evs('bft-old');
    const newEvs = evs('bft-new');

    expect(
      oldEvs,
      '老单锁 v1 ⇒ v1 在 doing 上只有 finish。出现 cancel 就是它错拿了 v2 的 def',
    ).not.toContain('cancel');
    expect(newEvs, '新单锁 v2 ⇒ 必须有 cancel（没有则本条退化成永真断言，白写）').toContain('cancel');
    expect(oldEvs, '两行同一个状态但锁不同版本 ⇒ available 必须不同').not.toEqual(newEvs);

    // 分组读本身：两行两个版本 ⇒ history 只查 1 次（v2 是 live，走 live 分支不进 history）。
    // 逐行读会查 2 次；而「共用一个 def」连这次都不查 ⇒ 这个计数同时压住两头。
    expect(
      c.calls.filter((x) => x.text.includes('FROM workflow_def_history')).length,
      '分组读：2 个版本 ⇒ history 查 1 次（v2 = live 不进 history）',
    ).toBe(1);
  });

  it('A3d：详情口按行锁的版本给 available —— 老单（锁 v1）拿不到 v2 独有的 cancel 按钮（抓 R-1 读侧）', async () => {
    // 🔴 详情口是「用户盯着按钮的那一屏」，也是最容易漏改的一处：
    //    它只 SELECT 一行，看起来不需要分组，顺手就留着读 live 了。
    //    后果（R-1）：详情给你看 finish，你点 finish 却 422 —— 因为写侧按 v1 校验而按钮是 v2 给的。
    //    A3-静态只能数到「调了 getWorkflowDefAtVersion」，数不到「传进去的是行上的版本还是 0」。
    const c = makeOldDetailClient();
    h.client = c.client;
    const app = await listen(appWith(businessFlowRouter, '/flow'));
    const res = await get(`${app.url}/flow/cycle_check/bft-old`);
    app.server.close();

    expect(res.status, '详情必须照旧跑通（跑不通是端点问题，不是读侧结论）').toBe(200);
    const item = (res.body as any).item;
    expect(item?.id, '拿到的必须是老单').toBe('bft-old');

    const evs = (item?.available ?? []).map((t: any) => t.event);
    expect(
      evs,
      '老单锁 v1 ⇒ v1 在 doing 上只有 finish。出现 cancel = 详情口读的是 live（R-1）',
    ).not.toContain('cancel');
    expect(evs, '详情口必须给得出 v1 的可用边（一条都没有则本条退化成永真，白写）').toContain('finish');

    // 路径断言：老行锁 1 而 live = 2 ⇒ 必须真回查 history 拿 v1 快照。
    // 读 live 的实现连这次 history 都不会查 ⇒ 这个计数把它单独钉死（与上面 available 的断言互不依赖）。
    expect(
      c.calls.filter((x) => x.text.includes('FROM workflow_def_history')).length,
      '老行锁 v1、live=v2 ⇒ 详情口必须回查 history 1 次（读 live 则一次都不查）',
    ).toBe(1);
  });
});
