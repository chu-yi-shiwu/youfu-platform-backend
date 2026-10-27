// evaluatedStatesHttp.test.ts —— 评价完成态分支的**真 HTTP 层**回归护栏。
//
// 【为什么补这个网】
//   F10 深审收口⑨ 把 workOrder.ts 里两处 `to === 'evaluated'` 改成 `evaluatedStates(def)` 派生
//   （满意度回写 + 自动生成结算草稿），但当时 RED 探针（把 evaluatedSet 置空数组）跑全量
//   132 文件/1546 用例**仍全绿** —— 证明这两条链路根本没有任何测试网：写对了没人知道，
//   写错了也没人知道。本文件就是补这张网。
//
// 【断言纪律】
//   1) 一律真 express + 真 HTTP（照 workOrderDrillDownFilter.http.test.ts 先例），不 mock 路由；
//   2) 断言**发没发那条 SQL**（satisfaction_score UPDATE / SAVEPOINT auto_settle），
//      而不是"没报错就算过"；
//   3) 自定义评价态名的用例是本文件的核心：旧实现（写死 'evaluated'）在它上面必然静默不触发。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';
import type { AuthLocals } from '../middleware/auth.js';

const h = vi.hoisted(() => ({ client: null as unknown, def: null as unknown }));
vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(h.client),
  assertSafeTenantId: (t: string) => t,
  default: { connect: async () => { throw new Error('[evaluatedStates.http.test] 单测禁用真实 pool'); } },
}));

import workOrderRouter from '../routes/workOrder.js';

const T = 't-eval';
const WO = '77777777-7777-4777-8777-777777777777';
const W1 = 'worker-001';

/** 内置 RICH 口径：closed --satisfy--> evaluated；另加一条非评价边 closed --archive--> archived 作负面对照。 */
function defWithEvalState(evalState: string) {
  return {
    initial: 'draft',
    states: ['draft', 'assigned', 'processing', 'completed', 'closed', 'archived', evalState],
    transitions: [
      { from: 'draft', to: 'assigned', event: 'dispatch' },
      { from: 'assigned', to: 'processing', event: 'start' },
      { from: 'processing', to: 'completed', event: 'finish' },
      { from: 'completed', to: 'closed', event: 'close' },
      { from: 'closed', to: evalState, event: 'satisfy', requiredFields: ['satisfaction_score'] },
      { from: 'closed', to: 'archived', event: 'archive' },
    ],
    config: {},
  };
}

interface Handler {
  match: (text: string) => boolean;
  reply: (text: string, params: unknown[]) => { rows: unknown[]; rowCount?: number };
}

function makeClient(handlers: Handler[]) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      for (const hd of handlers) {
        if (hd.match(text)) return hd.reply(text, params ?? []);
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return { client, calls };
}

/** 从 'closed' 出发的流转所需最小 SQL 面。 */
function baseHandlers(def: unknown, fromStatus = 'closed'): Handler[] {
  const woRow = {
    id: WO,
    tenant_id: T,
    order_no: 'WO-EVAL-1',
    status: fromStatus,
    assignee_id: W1,
  };
  return [
    { match: (t) => t.includes('SELECT def FROM workflow_def'), reply: () => ({ rows: [{ def }] }) },
    { match: (t) => t.includes('FOR UPDATE'), reply: () => ({ rows: [woRow] }) },
    { match: (t) => t.includes('SELECT 1 FROM worker'), reply: () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }) },
    { match: (t) => t.includes('UPDATE work_orders'), reply: (_t, p) => ({ rows: [{ ...woRow, status: p?.[0] }] }) },
    // 学习段：唯一键冲突（rowCount!==1）→ 直接跳过 incrementalLearn，本文件不关心学习
    { match: (t) => t.includes('INSERT INTO ticket_learn_log'), reply: () => ({ rows: [], rowCount: 0 }) },
  ];
}

let server: Server;
let baseUrl = '';
const auth: AuthLocals & { role: string } = {
  tenantId: T,
  requestId: 'req-eval',
  idempotencyKey: undefined,
  userId: 'u-1',
  username: 'admin',
  role: 'admin',
  authMode: 'prod',
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = auth;
    next();
  });
  app.use('/api/v1', workOrderRouter);
  app.use((_req, res) => res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'not found' }));
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const postTransition = async (body: Record<string, unknown>) => {
  const r = await fetch(`${baseUrl}/open/work_order/${WO}/transition`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

const findCall = (calls: Array<{ text: string; params?: unknown[] }>, needle: string) =>
  calls.find((c) => c.text.includes(needle));

describe('评价完成态（evaluatedStates 派生）：满意度回写 + 自动结算草稿', () => {
  it('内置口径：closed --satisfy--> evaluated + score → 回写满意度且触发自动结算', async () => {
    const { client, calls } = makeClient(baseHandlers(defWithEvalState('evaluated')));
    h.client = client;
    const r = await postTransition({ to: 'evaluated', score: 5 });
    expect(r.status, `期望 200，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(200);
    const upd = findCall(calls, 'satisfaction_score');
    expect(upd, '未发出满意度 UPDATE —— 评价态链路静默断了').toBeTruthy();
    expect(upd!.params?.[0]).toBe(5);
    expect(findCall(calls, 'SAVEPOINT auto_settle'), '未触发自动结算草稿').toBeTruthy();
  });

  it('🔴 F10 核心：客户把评价态改名（rated）→ 仍回写满意度且触发自动结算', async () => {
    // 旧实现写死 `to === 'evaluated'`：这一例必然静默不触发（满意度不入库、草稿不生成、无报错）。
    const { client, calls } = makeClient(baseHandlers(defWithEvalState('rated')));
    h.client = client;
    const r = await postTransition({ to: 'rated', score: 4 });
    expect(r.status, `期望 200，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(200);
    const upd = findCall(calls, 'satisfaction_score');
    expect(upd, '自定义评价态名下未回写满意度 —— 派生失效').toBeTruthy();
    expect(upd!.params?.[0]).toBe(4);
    expect(findCall(calls, 'SAVEPOINT auto_settle'), '自定义评价态名下未触发自动结算').toBeTruthy();
  });

  it('负面对照：非评价边（closed --archive--> archived）→ 不回写满意度、不触发自动结算', async () => {
    const { client, calls } = makeClient(baseHandlers(defWithEvalState('evaluated')));
    h.client = client;
    const r = await postTransition({ to: 'archived' });
    expect(r.status, `期望 200，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(200);
    expect(findCall(calls, 'satisfaction_score')).toBeUndefined();
    expect(findCall(calls, 'SAVEPOINT auto_settle')).toBeUndefined();
  });

  it('评价态命中但没带 score → 只触发自动结算，不发满意度 UPDATE（不臆造评分）', async () => {
    const def = defWithEvalState('evaluated');
    // requiredFields 含 satisfaction_score，缺字段会被 transition() 判缺必填；
    // 这里改成不带 requiredFields 的等价边，单独验证「无分不写」这一支。
    const noReq = {
      ...def,
      transitions: def.transitions.map((t: any) =>
        t.event === 'satisfy' ? { ...t, requiredFields: undefined } : t,
      ),
    };
    const { client, calls } = makeClient(baseHandlers(noReq));
    h.client = client;
    const r = await postTransition({ to: 'evaluated' });
    expect(r.status, `期望 200，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(200);
    expect(findCall(calls, 'satisfaction_score')).toBeUndefined();
    expect(findCall(calls, 'SAVEPOINT auto_settle')).toBeTruthy();
  });

  // ===================== 批 8 · 热路径去重（独立评审 C2） =====================
  /**
   * 【洞】一次 `POST /open/work_order/:id/transition` 里，学习段（runIncrementalLearnStep，
   *   workOrder.ts:299）和评价段（:566）**各跑一次** `getDefsAcrossAllVersions`
   *   ⇒ 每次一条 `SELECT DISTINCT def_version FROM work_orders WHERE tenant_id=$1`（全租户扫描，
   *   work_orders 上没有 (tenant_id, def_version) 索引）。
   *   改造前这里只有 1 次 `workflow_def` 主键级查询；改造后变成 2 次全租户扫描 + 多轮 def 加载，
   *   而且发生在**持有行锁（FOR UPDATE）期间** ⇒ 直接放大流转并发争抢。
   * 【修法】一次流转只取一份 defs，两个调用点共用。
   */
  it('🔴 一次流转只扫一次 def_version（学习段与评价段共用同一份 defs）', async () => {
    const { client, calls } = makeClient(baseHandlers(defWithEvalState('evaluated')));
    h.client = client;
    const r = await postTransition({ to: 'evaluated', score: 5 });
    expect(r.status, `期望 200，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(200);

    // 前提成立：这条链路真的走了学习段和评价段（否则「0 次」是假绿）
    expect(findCall(calls, 'satisfaction_score'), '评价段必须真的执行了').toBeTruthy();

    const scans = calls.filter((c) => c.text.includes('SELECT DISTINCT def_version'));
    expect(scans.length, '一次流转只该扫一次 def_version，不能每处各扫一次').toBe(1);
  });
});
