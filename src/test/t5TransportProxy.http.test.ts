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
  default: { connect: async () => { throw new Error('[t5TransportProxy] 单测禁用真实 pool'); } },
}));

import transportRouter from '../routes/transport.js';
import businessFlowRouter from '../routes/businessFlow.js';
import { TRANSPORT_DEF } from '../engine/themes.js';
import { errorMiddleware } from '../middleware/error.js';

const TENANT = 't-t5';
const ORDER_ID = 'to-1';

/** 夹具：记录每条 SQL，并对特定语句给出让流程走通的最小返回（与 t5EventEntityType 同口径）。 */
function makeClient() {
  const calls: CapturedQuery[] = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      const p = params ?? [];
      if (text.includes('INSERT INTO domain_event')) return { rows: [], rowCount: 1 };
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
});
