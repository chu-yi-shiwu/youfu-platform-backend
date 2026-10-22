// t5EventEntityType.http.test.ts —— T5「事件口径已断裂」RED 探针（只加测试，不改源码）。
//
// ⚠️⚠️【本文件是"行为护栏"，不是"形状护栏"——但有一处必须说清的边界】⚠️⚠️
//
// · **行为护栏**：**真跑**两条路由（`routes/transport.ts` 的 `POST /orders/:id/transition`、
//   `routes/businessFlow.ts` 的 `POST /:entityType`），**真调** `emitDomainEvent`，
//   断言的是"落到 `domain_event` 的 `entity_type` 到底是什么" ⇒ 断的是语义。
// · **边界（不要夸大）**：DB 客户端按本仓库 `src/test/*.http.test.ts` 的既有惯例
//   **替换为桩**（`vi.mock('../db/pool.js')`），**不是 PGlite 真库**。
//   ⇒ 它能证明"路由把什么 entityType 交给了 emitDomainEvent"，
//     **不能**证明"这条 INSERT 在真库上一定能执行成功"。
//   要补这一层，得照 `src/test/migration101.pglite.test.ts` 的建库方式再写一份真库版。
//
// 【骨架声明（第 283 行）】同一运送业务：`transport.ts:74` 记 `entityType:'transport_order'`，
//   `businessFlow.ts:128` 记 `entityType`（值为 `transport_task`）⇒ 事件口径断裂。
//   本探针把"同一笔运送业务，两条通道产生的 entity_type 必须一致"钉死。
//
// 【转红时的判断顺序（必须照做，不许反过来）】
//   ① 先看**现状实拍**那两条（本文件里标了"对照·绿"的）是不是还绿：
//      · 它们绿 ⇒ 两条通道**真的都写进 domain_event 了**，红的是"口径不一致"这个真缺口，
//        改**代码**统一口径，**不许动任何断言**；
//      · 它们也红 ⇒ 端点压根跑不通（不是口径问题），先修端点/夹具，**同样不许靠改断言让它绿**。
//   ② 再看有没有新增的第三条运送写入路径：新增路径也必须走同一口径，
//      否则本护栏只盯住两条、第三条继续分裂。
//
// 【同类的形状护栏散在别的文件里，别只盯着这一个】
//   · 同类护栏另见：`src/test/t0*.test.ts`
//     （用**命名模式**而非穷举：符合该模式的新文件自动被覆盖，零维护。
//       不符合该模式的新形状/行为护栏，需回来在本段补一句指路。）
//   · **本段故意不写任何个数**：用例数一条命令就能查准
//     （`npx vitest run <单文件>` 每次跑都打印该文件用例数）；
//     条目数由清单给出，另写数字必然与清单失同步。
//   · 覆盖面收缩必须留痕：**清单少一项即为收缩**，须写明"由 N 减为 N-1：原因：xxx"，
//     允许缩小，不许悄悄缩。（留痕靠清单，不靠数字。）
//   · 改任何一处前，先看它对应的对照用例绿不绿。
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ---- mock 掉 DB 连接池（与 src/test/acceptance.http.test.ts 同口径）----
interface CapturedQuery {
  text: string;
  params?: unknown[];
}

const h = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(h.client),
  assertSafeTenantId: (t: string) => t,
  default: { connect: async () => { throw new Error('[t5EventEntityType] 单测禁用真实 pool'); } },
}));

import transportRouter from '../routes/transport.js';
import businessFlowRouter from '../routes/businessFlow.js';
import { TRANSPORT_DEF } from '../engine/themes.js';
import { errorMiddleware } from '../middleware/error.js';

const TENANT = 't-t5';
const ORDER_ID = 'to-1';

/** 夹具：把每条 SQL 记下来，并对特定语句给出让流程走通的最小返回。 */
function makeClient(opts: { orderStatus: string }) {
  const calls: CapturedQuery[] = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      if (text.includes('FROM transport_order')) {
        return { rows: [{ id: ORDER_ID, status: opts.orderStatus, carrier: 'w-1' }], rowCount: 1 };
      }
      if (text.includes('UPDATE transport_order')) {
        return { rows: [{ id: ORDER_ID, status: 'shipped' }], rowCount: 1 };
      }
      if (text.includes('INSERT INTO transport_track_point')) {
        return { rows: [{ id: 'tp-1' }], rowCount: 1 };
      }
      if (text.includes('INSERT INTO business_flow_tasks')) {
        return { rows: [{ id: 'bft-1', status: 'draft' }], rowCount: 1 };
      }
      if (text.includes('INSERT INTO domain_event')) {
        return { rows: [], rowCount: 1 };
      }
      // workflow_def 查不到 ⇒ getWorkflowDefOrDefault 回退内置 TRANSPORT_DEF
      if (text.includes('FROM workflow_def')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return { client, calls };
}

/** 从 TRANSPORT_DEF 里挑一条"admin 能走"的合法流转，避免把夹具写成硬编码状态。 */
function pickLegalTransition(): { from: string; event: string } {
  const initial = (TRANSPORT_DEF as { initial: string }).initial;
  const t = (TRANSPORT_DEF as { transitions: Array<{ from: string; event: string; allowedRoles?: string[] }> })
    .transitions.find(
      (x) => x.from === initial && (!x.allowedRoles || x.allowedRoles.length === 0 || x.allowedRoles.includes('admin')),
    );
  if (!t) throw new Error('[夹具] TRANSPORT_DEF 里找不到 admin 可从 initial 发起的流转，夹具需同步更新');
  return { from: initial, event: t.event };
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

/** 造一个"已登录的 admin"：两个角色守卫（requireConfigRole / requireAssigneeOrConfig）都对 admin 放行。 */
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

function domainEventParams(calls: CapturedQuery[]): Array<{ text: string; params?: unknown[] }> {
  return calls.filter((c) => c.text.includes('INSERT INTO domain_event'));
}

/** domain_event 的 INSERT 参数顺序见 src/db/eventBus.ts：$1 tenant_id / $2 entity_type / $3 entity_id */
function entityTypeOf(q: CapturedQuery): string {
  return String((q.params ?? [])[1]);
}

describe('T5-探针：同一笔运送业务的 domain_event.entityType 必须一致', () => {
  it('🔴 原生运送路由与通用业务流通道，产生的 entity_type 必须相同（现状：不同 ⇒ 口径断裂）', async () => {
    const { from, event } = pickLegalTransition();

    // —— 通道 A：原生运送路由 POST /transport/orders/:id/transition（transport.ts:74 发事件）——
    const a = makeClient({ orderStatus: from });
    h.client = a.client;
    const appA = await listen(appWith(transportRouter, '/transport'));
    const resA = await fetch(`${appA.url}/transport/orders/${ORDER_ID}/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event }),
    });
    appA.server.close();
    expect(resA.status, '原生运送路由应当跑通（跑不通说明是端点问题，不是口径问题）').toBe(200);

    // —— 通道 B：通用业务流通道 POST /flow/transport_task（businessFlow.ts:128 发事件）——
    const b = makeClient({ orderStatus: from });
    h.client = b.client;
    const appB = await listen(appWith(businessFlowRouter, '/flow'));
    const resB = await fetch(`${appB.url}/flow/transport_task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '送标本到 3 楼检验科' }),
    });
    appB.server.close();
    expect(resB.status, '通用业务流通道应当跑通（跑不通说明是端点问题，不是口径问题）').toBe(201);

    const evA = domainEventParams(a.calls);
    const evB = domainEventParams(b.calls);
    expect(evA.length, '通道 A 没有写 domain_event ⇒ 夹具没跑到位，不是口径结论').toBe(1);
    expect(evB.length, '通道 B 没有写 domain_event ⇒ 夹具没跑到位，不是口径结论').toBe(1);

    const typeA = entityTypeOf(evA[0]);
    const typeB = entityTypeOf(evB[0]);
    expect(
      typeA,
      `同一笔运送业务口径断裂：原生路由记 ${typeA}、通用通道记 ${typeB}。` +
        `下游按 entity_type 聚合事件时，一笔业务会被算成两个实体 ⇒ 统计/订阅全部对不上。` +
        `（transport.ts:74 硬编码 'transport_order'；businessFlow.ts:128 用路由参数 entityType）`,
    ).toBe(typeB);
  });

  it('对照（现状实拍·绿）：原生运送路由记的是 transport_order', async () => {
    const { from, event } = pickLegalTransition();
    const a = makeClient({ orderStatus: from });
    h.client = a.client;
    const appA = await listen(appWith(transportRouter, '/transport'));
    await fetch(`${appA.url}/transport/orders/${ORDER_ID}/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event }),
    });
    appA.server.close();
    const evA = domainEventParams(a.calls);
    expect(evA.length).toBe(1);
    expect(entityTypeOf(evA[0])).toBe('transport_order');
  });

  it('对照（现状实拍·绿）：通用业务流通道记的是路由参数 transport_task', async () => {
    const b = makeClient({ orderStatus: 'draft' });
    h.client = b.client;
    const appB = await listen(appWith(businessFlowRouter, '/flow'));
    await fetch(`${appB.url}/flow/transport_task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '送标本到 3 楼检验科' }),
    });
    appB.server.close();
    const evB = domainEventParams(b.calls);
    expect(evB.length).toBe(1);
    expect(entityTypeOf(evB[0])).toBe('transport_task');
  });

  it('🔴 同一条运送路由内部：查 workflow_def 用的 entity_type 与发事件用的必须一致', async () => {
    const { from, event } = pickLegalTransition();
    const a = makeClient({ orderStatus: from });
    h.client = a.client;
    const appA = await listen(appWith(transportRouter, '/transport'));
    await fetch(`${appA.url}/transport/orders/${ORDER_ID}/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event }),
    });
    appA.server.close();

    // getWorkflowDefOrDefault 的 SQL：SELECT def FROM workflow_def WHERE tenant_id = $1 AND entity_type = $2
    const defQuery = a.calls.find((c) => c.text.includes('FROM workflow_def'));
    expect(defQuery, '没查 workflow_def ⇒ 夹具没跑到位').toBeTruthy();
    const defEntityType = String((defQuery!.params ?? [])[1]);
    const evA = domainEventParams(a.calls);
    expect(evA.length).toBe(1);
    const emitted = entityTypeOf(evA[0]);

    expect(
      defEntityType,
      `同一个 transport.ts 内部自相矛盾：状态图按 '${defEntityType}' 读（transport_task），` +
        `发出去的事件却记 '${emitted}'（transport_order）。` +
        `⇒ 按事件流回放/订阅的消费者拿到的实体名，和引擎自己认的实体名不是同一个。`,
    ).toBe(emitted);
  });
});
