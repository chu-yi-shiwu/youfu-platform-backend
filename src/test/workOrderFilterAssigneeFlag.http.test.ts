// workOrderFilterAssigneeFlag.http.test.ts —— 2026-09-07 三项决策的真·HTTP 层回归护栏。
//
//   任务一（决策 #8）：工单列表服务端筛选 department/priority/source/service_desk
//     —— 单独过滤生效 + 与 status 组合生效 + 不传时行为与旧版完全一致（回归）。
//   任务二（决策 #7）：列表/详情下发 assignee_name（LEFT JOIN worker，无承接人 → null）。
//   任务三（决策 #5）：租户开关 ticket_require_service_desk —— 默认关（建单不带服务台完全合法）；
//     开启后直接建单缺服务台 → 422 SERVICE_DESK_REQUIRED；翻转接口。
//     ⚠️ 原「来电弹屏代申告路径豁免」随该端点 2026-10-28 下线删除（现已无豁免分支）。
//
// 断言纪律：一律断言真实 HTTP 状态码（对齐 acceptance.http.test.ts），禁止 try/catch 空过。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorMiddleware } from '../middleware/error.js';
import type { AuthLocals } from '../middleware/auth.js';

// ---- mock 掉 DB 连接池 ----
const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(h.client),
  assertSafeTenantId: (t: string) => t,
  default: { connect: async () => { throw new Error('[workOrderFilterAssigneeFlag.http.test] 单测禁用真实 pool'); } },
}));

import workOrderRouter from '../routes/workOrder.js';
import configRouter from '../routes/config.js';
import serviceDeskRouter from '../routes/serviceDesk.js';

interface Handler {
  match: (text: string) => boolean;
  reply: (text: string, params: unknown[]) => { rows: unknown[]; rowCount?: number };
}

function makeClient(handlers: Handler[], opts?: { strict?: boolean }) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      for (const hd of handlers) {
        if (hd.match(text)) return hd.reply(text, params ?? []);
      }
      if (opts?.strict) throw new Error(`[mock] 未命中 handler 的 SQL：${text}`);
      return { rows: [], rowCount: 1 };
    },
  };
  return { client, calls } as { client: unknown; calls: typeof calls };
}

const T = 't-wo-filter';
const WO_ID = '22222222-2222-4222-8222-222222222222';
const DESK_UUID = '11111111-1111-4111-8111-111111111111';

/** 任务一：list() 的 SQL 形状断言辅助——COUNT 与 SELECT 两条 SQL 都要带上（或都不带）新条件。 */
function listHandlers(listRows: unknown[]): Handler[] {
  return [
    {
      match: (t) => t.includes('FROM work_orders wo') && (t.includes('COUNT(*)') || t.includes('ORDER BY wo.created_at')),
      reply: (t) => (t.includes('COUNT(*)') ? { rows: [{ c: String(listRows.length) }] } : { rows: listRows }),
    },
    { match: (t) => t.includes('FROM workflow_def'), reply: () => ({ rows: [] }) }, // getWorkflowDef → 引擎默认 def
  ];
}

// ---- 真实 express + 真 HTTP ----
let server: Server;
let baseUrl = '';
const auth: AuthLocals & { role: string } = {
  tenantId: T,
  requestId: 'req-wo-filter',
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
  app.use('/api/v1', configRouter);
  app.use('/api/v1', serviceDeskRouter);
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

const get = async (path: string) => {
  const r = await fetch(baseUrl + path);
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const post = async (path: string, body: unknown) => {
  const r = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const put = async (path: string, body: unknown, role?: string) => {
  auth.role = (role ?? 'admin') as string;
  const r = await fetch(baseUrl + path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  auth.role = 'admin';
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

// ==================== 任务一（决策 #8）：列表服务端筛选 ====================
describe('任务一：GET /open/work_orders 服务端筛选四参', () => {
  it('department 单独过滤生效（SQL 条件 + 参数）', async () => {
    const { client, calls } = makeClient(listHandlers([{ id: WO_ID, order_no: 'WO_1', status: 'open', department: 'nursing', assignee_name: null }]));
    h.client = client;
    const r = await get('/open/work_orders?department=nursing');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const listCall = calls.find((c) => c.text.includes('ORDER BY wo.created_at'));
    expect(listCall).toBeTruthy();
    expect(listCall!.text).toContain('wo.department = $');
    expect(listCall!.params).toContain('nursing');
    expect(r.body.items[0].department).toBe('nursing');
  });

  it('priority / source / service_desk 各自单独过滤生效', async () => {
    for (const [qs, cond, val] of [
      ['priority=urgent', 'wo.priority = $', 'urgent'],
      ['source=phone', 'wo.source = $', 'phone'],
      ['service_desk=sd-9', 'wo.service_desk = $', 'sd-9'],
    ] as const) {
      const { client, calls } = makeClient(listHandlers([]));
      h.client = client;
      const r = await get(`/open/work_orders?${qs}`);
      expect(r.status).toBe(200);
      const listCall = calls.find((c) => c.text.includes('ORDER BY wo.created_at'));
      expect(listCall!.text).toContain(cond);
      expect(listCall!.params).toContain(val);
    }
  });

  it('四参与 status 组合生效（同一条 SQL 同时携带全部条件）', async () => {
    const { client, calls } = makeClient(listHandlers([]));
    h.client = client;
    const r = await get('/open/work_orders?status=open&department=nursing&priority=urgent&source=phone&service_desk=sd-9');
    expect(r.status).toBe(200);
    const listCall = calls.find((c) => c.text.includes('ORDER BY wo.created_at'));
    expect(listCall!.text).toContain('wo.status = ANY(');
    expect(listCall!.text).toContain('wo.department = $');
    expect(listCall!.text).toContain('wo.priority = $');
    expect(listCall!.text).toContain('wo.source = $');
    expect(listCall!.text).toContain('wo.service_desk = $');
    // status 为 text[] 参数（数组），其余为标量 → 扁平化后逐值断言
    const flat = (listCall!.params as unknown[]).flat();
    for (const v of ['open', 'nursing', 'urgent', 'phone', 'sd-9']) expect(flat).toContain(v);
  });

  it('回归：四参全不传时 SQL 不出现新条件，行为与旧版一致', async () => {
    const { client, calls } = makeClient(listHandlers([]));
    h.client = client;
    const r = await get('/open/work_orders?limit=5');
    expect(r.status).toBe(200);
    const listCall = calls.find((c) => c.text.includes('ORDER BY wo.created_at'));
    expect(listCall).toBeTruthy();
    expect(listCall!.text).not.toContain('wo.department =');
    expect(listCall!.text).not.toContain('wo.priority =');
    expect(listCall!.text).not.toContain('wo.source =');
    expect(listCall!.text).not.toContain('wo.service_desk =');
    // 旧口径仍在：租户隔离 + LIMIT 上限
    expect(listCall!.text).toContain('wo.tenant_id = $1');
    expect(listCall!.text).toContain('LIMIT 5');
  });
});

// ==================== 任务二（决策 #7）：assignee_name 下发 ====================
describe('任务二：列表/详情下发 assignee_name', () => {
  it('列表项透传 assignee_name（LEFT JOIN worker）', async () => {
    const { client } = makeClient(listHandlers([{ id: WO_ID, order_no: 'WO_1', status: 'assigned', assignee_id: 'w-1', assignee_name: '张三' }]));
    h.client = client;
    const r = await get('/open/work_orders');
    expect(r.status).toBe(200);
    expect(r.body.items[0].assignee_name).toBe('张三');
  });

  it('详情返回承接人姓名；SQL 为 LEFT JOIN worker 形状（JOIN 带 tenant_id 防跨租户串名）', async () => {
    const { client, calls } = makeClient([
      // findOne 新形状：SELECT wo.* ... LEFT JOIN worker w ON w.id = wo.assignee_id AND w.tenant_id = wo.tenant_id
      { match: (t) => t.includes('FROM work_orders wo') && t.includes('LEFT JOIN worker w'), reply: () => ({ rows: [{ id: WO_ID, order_no: 'WO_1', status: 'assigned', assignee_id: 'w-1', assignee_name: '李四' }] }) },
      { match: (t) => t.includes('FROM workflow_def'), reply: () => ({ rows: [] }) },
      { match: (t) => t.includes('FROM ticket_event'), reply: () => ({ rows: [] }) },
    ]);
    h.client = client;
    const r = await get(`/open/work_order/${WO_ID}`);
    expect(r.status).toBe(200);
    expect(r.body.ticket.assignee_name).toBe('李四');
    expect(r.body.ticket.code).toBe('WO_1'); // DEF-2 口径未被破坏
    const findCall = calls.find((c) => c.text.includes('LEFT JOIN worker w'));
    expect(findCall).toBeTruthy();
    expect(findCall!.text).toContain('w.name AS assignee_name');
    expect(findCall!.text).toContain('w.tenant_id = wo.tenant_id');
  });

  it('详情无承接人 → assignee_name 为 null（不丢行）', async () => {
    const { client } = makeClient([
      { match: (t) => t.includes('FROM work_orders wo') && t.includes('LEFT JOIN worker w'), reply: () => ({ rows: [{ id: WO_ID, order_no: 'WO_1', status: 'draft', assignee_id: null, assignee_name: null }] }) },
      { match: (t) => t.includes('FROM workflow_def'), reply: () => ({ rows: [] }) },
      { match: (t) => t.includes('FROM ticket_event'), reply: () => ({ rows: [] }) },
    ]);
    h.client = client;
    const r = await get(`/open/work_order/${WO_ID}`);
    expect(r.status).toBe(200);
    expect(r.body.ticket.assignee_name).toBeNull();
  });
});

// ==================== 任务三（决策 #5）：服务台租户开关 ====================
/** 建单链路 handlers：开关值可变（systemConfigValue）+ 建单 SQL 最小闭环（无工人 → 落抢单大厅）。 */
function createHandlers(opts: { systemConfigValue?: string | null } = {}): Handler[] {
  return [
    // 开关读取（workOrder 与 config 两处同 key）
    { match: (t) => t.includes('FROM system_config'), reply: () => ({ rows: opts.systemConfigValue != null ? [{ value: opts.systemConfigValue }] : [] }) },
    // 幂等抢键
    { match: (t) => t.includes('INSERT INTO idempotency_key'), reply: () => ({ rows: [], rowCount: 1 }) },
    // 建单 INSERT
    { match: (t) => t.startsWith('INSERT INTO work_orders'), reply: (_t, p) => ({ rows: [{ id: p[0] as string, tenant_id: T, order_no: p[2] as string, status: 'draft', auto_flow: false, service_desk: p[15] as string | null }], rowCount: 1 }) },
    // 幂等回查 / 建单后 findOne（LEFT JOIN 形状）——返回建好的行（真实 DB 中会命中刚插入的行）
    {
      match: (t) => t.includes('FROM work_orders wo') && t.includes('LEFT JOIN worker w'),
      reply: () => ({
        rows: [{
          id: WO_ID, tenant_id: T, order_no: 'WO_20260907_0000000001', status: 'claim_hall', auto_flow: false,
          assignee_id: null, assignee_name: null, source: 'backend', fault_type: null, service_desk: null, department: null, ext: {},
        }],
      }),
    },
    // createWithIdem 审计
    { match: (t) => t.includes('INSERT INTO ticket_event'), reply: () => ({ rows: [], rowCount: 1 }) },
    { match: (t) => t.includes('INSERT INTO domain_event'), reply: () => ({ rows: [], rowCount: 1 }) },
    // autoDispatchAfterCreate：无可用工人 → 落抢单大厅
    { match: (t) => t.includes('UPDATE work_orders SET sla_minutes'), reply: () => ({ rows: [], rowCount: 1 }) },
    { match: (t) => t.includes('FROM worker WHERE tenant_id'), reply: () => ({ rows: [] }) },
    { match: (t) => t.includes('FROM dispatch_rule WHERE'), reply: () => ({ rows: [] }) },
    { match: (t) => t.includes('SELECT def FROM workflow_def'), reply: () => ({ rows: [] }) },
    { match: (t) => t.includes('SELECT params FROM model_state'), reply: () => ({ rows: [] }) },
    // F8：落大厅由旁路 UPDATE 改为 transition() 主通道 → 需行锁读（真实 DB 中刚插入的行必命中；
    //   此前旁路不需要读行，正是"旁路不校验任何东西"的副作用之一）
    { match: (t) => t.includes('FOR UPDATE'), reply: () => ({ rows: [{ id: WO_ID, tenant_id: T, order_no: 'WO_20260907_0000000001', status: 'draft', assignee_id: null, ext: {}, priority: 'normal', catalog: null }], rowCount: 1 }) },
    { match: (t) => t.includes('UPDATE work_orders SET status'), reply: (_t, p) => ({ rows: [{ id: WO_ID, tenant_id: T, status: p[0] as string, assignee_id: null, ext: {}, auto_flow: false }], rowCount: 1 }) },
    { match: (t) => t.includes('UPDATE worker SET load'), reply: () => ({ rows: [], rowCount: 1 }) },
    // 详情 findOne（transition 等不触发，防御性）
    { match: (t) => t.includes('FROM workflow_def'), reply: () => ({ rows: [] }) },
  ];
}

describe('任务三：ticket_require_service_desk 租户开关', () => {
  const createBody = (extra: Record<string, unknown> = {}) => ({
    id: WO_ID,
    business_type: 'repair',
    title: '三楼病房灯管不亮',
    ...extra,
  });

  it('默认关（无配置行）：建单不带 service_desk 完全合法（铁律回归）', async () => {
    const { client, calls } = makeClient(createHandlers());
    h.client = client;
    const r = await post('/open/work_order', createBody());
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
    expect(calls.find((c) => c.text.startsWith('INSERT INTO work_orders'))).toBeTruthy();
  });

  it('开启后：直接建单缺 service_desk → 422 SERVICE_DESK_REQUIRED（中文文案），且不落单', async () => {
    const { client, calls } = makeClient(createHandlers({ systemConfigValue: 'true' }));
    h.client = client;
    const r = await post('/open/work_order', createBody());
    expect(r.status).toBe(422);
    expect(r.body.ok).toBe(false);
    expect(r.body.code).toBe('SERVICE_DESK_REQUIRED');
    expect(r.body.message).toBe('该租户已开启「必须指定服务台」，请先选择服务台后再提交');
    // 422 抛错令事务回滚 → 绝不能出现建单 INSERT
    expect(calls.find((c) => c.text.startsWith('INSERT INTO work_orders'))).toBeUndefined();
  });

  it('开启后：带 service_desk 的建单照常成功', async () => {
    const { client } = makeClient(createHandlers({ systemConfigValue: 'true' }));
    h.client = client;
    const r = await post('/open/work_order', createBody({ service_desk: DESK_UUID }));
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
  });

  // 原「豁免：开关开启后来电弹屏代申告（POST /service-desk/tickets 语义）仍成功」
  // 随**代申告下线**一并删除（2026-10-28，初一改判）：端点已删，该豁免语义不复存在。
  // ⚠️ 本文件测的是 /open/work_order 的开关校验 —— **开关 ticket_require_service_desk 保留**，不受影响。
  it('翻转接口：GET 默认 false → PUT true → GET true；worker 写入 403', async () => {
    // 可变 flag：PUT upsert 后读取同步翻转，验证「读-写-读」闭环
    let flag: string | null = null;
    const { client, calls } = makeClient([
      { match: (t) => t.includes('FROM system_config'), reply: () => ({ rows: flag != null ? [{ value: flag }] : [] }) },
      {
        match: (t) => t.includes('INSERT INTO system_config'),
        reply: (_t, p) => {
          flag = String(p[2]);
          return { rows: [{ id: 'cfg-1', key: p[1], value: flag, updated_at: '2026-09-07T00:00:00Z' }], rowCount: 1 };
        },
      },
    ]);
    h.client = client;
    const g1 = await get('/config/ticket-require-service-desk');
    expect(g1.status).toBe(200);
    expect(g1.body.enabled).toBe(false);

    const p = await put('/config/ticket-require-service-desk', { enabled: true });
    expect(p.status).toBe(200);
    expect(p.body.enabled).toBe(true);
    const upsert = calls.find((c) => c.text.includes('INSERT INTO system_config'));
    expect(upsert).toBeTruthy();
    expect(upsert!.params).toContain('ticket_require_service_desk');
    expect(upsert!.params).toContain('true');

    const g2 = await get('/config/ticket-require-service-desk');
    expect(g2.body.enabled).toBe(true);

    // 翻回 false
    const p2 = await put('/config/ticket-require-service-desk', { enabled: false });
    expect(p2.body.enabled).toBe(false);
    const g3 = await get('/config/ticket-require-service-desk');
    expect(g3.body.enabled).toBe(false);

    // 写权限对齐 requireConfigRole（worker 403）
    const forbidden = await put('/config/ticket-require-service-desk', { enabled: true }, 'worker');
    expect(forbidden.status).toBe(403);
  });
});

// ============================================================
// T1-B 批4 · 工单在途单锁版本 —— HTTP 穿透验收（A3-W / A4-W / A9-W）
//
// 【为什么这三条必须走 HTTP 而不是 ../../engine 单测】
//   read 侧三处改动（列表分组读 / 详情按行读 / 建单盖章）**长在 route handler 与 createWithIdem 里**，
//   真库那份（workflowDefAtVersion.pglite.test.ts 批4 组）验的是"拿到哪一版、按它流转对不对"，
//   这儿验的是"这个 HTTP 端点到底有没有走版本化读" —— 两边互补，缺一边都会留缝。
//
// 【🔴🔴 桩纪律（批 3 的血的教训）】
//   假 client 的**兜底分支返回空行**，兜底对象里**一律不得出现 def_version** ——
//   真实数据库里没被 SELECT 的列不会出现在行上。若桩给每行都塞上 def_version，
//   "那处忘了把 def_version 读出来"的 bug 会被桩填平 ⇒ 假绿。
//   本文件既有的 makeClient 兜底返回 `{ rows: [] }`，天然合规，此处只是加注释钉住不许改。
// ============================================================
const WO_OLD_ID = '33333333-3333-4333-8333-333333333333';
const WO_NEW_ID = '44444444-4444-4444-8444-444444444444';

/** v1：draft→assigned→processing→completed，三条边（老单锁的那一版）。 */
const DEF_V1 = {
  initial: 'draft',
  states: ['draft', 'assigned', 'processing', 'completed'],
  transitions: [
    { from: 'draft', to: 'assigned', event: 'assign' },
    { from: 'assigned', to: 'processing', event: 'start' },
    { from: 'processing', to: 'completed', event: 'complete' },
  ],
  config: {},
};
/** v2 = v1 + 一条 v1 **没有**的边 assigned --fast_close--> completed —— A3-W 列表/详情的判别关键。 */
const DEF_V2 = {
  initial: 'draft',
  states: ['draft', 'assigned', 'processing', 'completed'],
  transitions: [
    ...DEF_V1.transitions,
    { from: 'assigned', to: 'completed', event: 'fast_close' },
    // A3-W 抢单大厅面的判别关键：v1 里 claim_hall 只有引擎注入的三条机制出边，
    // v2 多了一条自定义的 claim_hall --grab--> processing。
    // （claim_hall 不需要写进 states：withMechanismStates 会把它连同机制边幂等补上。）
    { from: 'claim_hall', to: 'processing', event: 'grab' },
  ],
  config: {},
};

/**
 * 版本化读路径的三个必答查询。
 * 【顺序敏感】`FROM workflow_def_history` 含有子串 `FROM workflow_def` ⇒ history 分支必须排在
 * 任何宽匹配之前；本组刻意**不提供** `includes('FROM workflow_def')` 这种兜底，让未预期的查询直接暴露。
 * 【为什么必须给 SELECT version 单独一条分支】getWorkflowDefVersion 用它；没有这条 ⇒ 返回 undefined
 * ⇒ 版本号变 NaN/undefined，测试会假红成产品 bug（而不是把真实缺陷验出来）。
 */
function versionedDefHandlers(): Handler[] {
  return [
    { match: (t) => t.includes('SELECT version FROM workflow_def'), reply: () => ({ rows: [{ version: 2 }] }) },
    {
      match: (t) => t.includes('FROM workflow_def_history'),
      // getWorkflowDefHistoryVersion：$1 tenant / $2 entity / $3 version
      reply: (_t, p) => (Number(p?.[2]) === 1 ? { rows: [{ def: DEF_V1 }] } : { rows: [] }),
    },
    { match: (t) => t.includes('SELECT def FROM workflow_def'), reply: () => ({ rows: [{ def: DEF_V2 }] }) },
  ];
}

const eventOf = (list: Array<{ event: string }>) => list.map((a) => a.event);

describe('A3-W：available 老单新单各按各的版本（穿透 read 侧）', () => {
  const detailRow = (id: string, defVersion: number) => ({
    match: (t: string) => t.includes('FROM work_orders wo') && t.includes('LEFT JOIN worker w'),
    reply: () => ({
      rows: [{
        id, tenant_id: T, order_no: 'WO_A3', status: 'assigned',
        assignee_id: null, assignee_name: null, def_version: defVersion,
      }],
    }),
  });

  it('详情：老单（def_version=1，live=2）available 不含 v2 新增的 fast_close', async () => {
    const { client } = makeClient([
      detailRow(WO_OLD_ID, 1),
      ...versionedDefHandlers(),
      { match: (t) => t.includes('FROM ticket_event'), reply: () => ({ rows: [] }) },
    ]);
    h.client = client;
    const r = await get(`/open/work_order/${WO_OLD_ID}`);
    expect(r.status).toBe(200);
    const ev = eventOf(r.body.available);
    expect(ev, 'v1 自带的边照常在').toContain('start');
    expect(ev, '详情 available 不得出现 v2 独有的 fast_close').not.toContain('fast_close');
  });

  it('详情对照：同状态下新单（def_version=2 = live）available 含 fast_close', async () => {
    const { client } = makeClient([
      detailRow(WO_NEW_ID, 2),
      ...versionedDefHandlers(),
      { match: (t) => t.includes('FROM ticket_event'), reply: () => ({ rows: [] }) },
    ]);
    h.client = client;
    const r = await get(`/open/work_order/${WO_NEW_ID}`);
    expect(r.status).toBe(200);
    // 没有这条对照的话，"一律按最老版本渲染按钮"的错误实现也能让上一条全绿。
    expect(eventOf(r.body.available), '新单必须看得到 v2 的新边').toContain('fast_close');
  });

  it('列表：一行老单(v1) + 一行新单(v2) ⇒ 老单不含 fast_close、新单含（getDefsForVersions 分组读）', async () => {
    const rows = [
      { id: WO_OLD_ID, tenant_id: T, order_no: 'WO_OLD', status: 'assigned', assignee_id: null, assignee_name: null, def_version: 1 },
      { id: WO_NEW_ID, tenant_id: T, order_no: 'WO_NEW', status: 'assigned', assignee_id: null, assignee_name: null, def_version: 2 },
    ];
    const { client } = makeClient([
      {
        match: (t) => t.includes('FROM work_orders wo') && t.includes('COUNT(*)'),
        reply: () => ({ rows: [{ c: String(rows.length) }] }),
      },
      {
        match: (t) => t.includes('FROM work_orders wo') && t.includes('ORDER BY wo.created_at'),
        reply: () => ({ rows }),
      },
      ...versionedDefHandlers(),
    ]);
    h.client = client;
    const r = await get('/open/work_orders');
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBe(2);
    const byId = new Map<string, string[]>(r.body.items.map((it: any) => [it.id, eventOf(it.available)]));
    expect(byId.get(WO_OLD_ID), '列表里老单的 available 不得出现 v2 独有的边').not.toContain('fast_close');
    expect(byId.get(WO_NEW_ID), '列表里新单的 available 必须含 v2 的边').toContain('fast_close');
    // 两行同状态却给出**不同**按钮集 —— 这正是「共用 live def」做不到的事 ⇒ 锁版本真的生效了。
    expect(byId.get(WO_OLD_ID)).not.toEqual(byId.get(WO_NEW_ID));
  });

  it('抢单大厅：available 同样逐行分组读 ⇒ 老单(v1)不含 v2 独有的 grab、新单(v2)含', async () => {
    const rows = [
      { id: WO_OLD_ID, tenant_id: T, order_no: 'WO_OLD', status: 'claim_hall', assignee_id: null, def_version: 1 },
      { id: WO_NEW_ID, tenant_id: T, order_no: 'WO_NEW', status: 'claim_hall', assignee_id: null, def_version: 2 },
    ];
    const { client } = makeClient([
      // 抢单大厅先探「租户内现存哪些版本」（源 reachable 分支；没有它 ⇒ undefined 直接崩）
      {
        match: (t) => t.includes('SELECT DISTINCT def_version FROM work_orders'),
        reply: () => ({ rows: [{ def_version: 1 }, { def_version: 2 }] }),
      },
      {
        match: (t) => t.includes('FROM work_orders WHERE tenant_id=$1 AND status = ANY($2::text[])'),
        reply: () => ({ rows }),
      },
      ...versionedDefHandlers(),
    ]);
    h.client = client;
    const r = await get('/open/claim-hall');
    expect(r.status).toBe(200);
    expect(r.body.items.length, '两张单都必须在池里（池态取各版本并集）').toBe(2);
    const byId = new Map<string, string[]>(r.body.items.map((it: any) => [it.id, eventOf(it.available)]));
    // 机制注入的三条出边（claim/dispatch/cancel）两个版本都有 ⇒ 两边都在
    expect(byId.get(WO_OLD_ID)).toContain('claim');
    expect(byId.get(WO_NEW_ID)).toContain('claim');
    expect(byId.get(WO_OLD_ID), '大厅里老单不得出现 v2 独有的 grab').not.toContain('grab');
    expect(byId.get(WO_NEW_ID), '大厅里新单必须含 v2 的 grab').toContain('grab');
  });
});

// ============================================================
// A3（设计 §8 验收条款原文）· available 与写侧一致 —— 防 R-1
//
// 【这条在验什么】详情接口返回的 `available` 里**每个 event 逐个真实调用 ⇒ 无 422**。
//   这是唯一能抓住「只改写侧（流转按锁版本校验）不改读侧（按钮按 live 渲染）」的断言 ——
//   那种 bug 的表现正是：用户看得见按钮，点下去 422。
//
// 【三条不可退让的写法纪律】
//   ① available **必须**取自 GET 详情的响应体，绝不在本文件调 availableTransitions() 自己算。
//     自己算的那份与读侧实现无关 ⇒ 读侧改回「一律读 live」时它照样成立 ⇒ 假绿，等于没补。
//   ② 场景必须是「老单锁 v1、live 是 v2」的多版本并存 —— 单版本下读侧怎么错都对得上。
//   ③ 每个 event 都要真发起 HTTP 调用（走真实路由 → transition()），不是直接调引擎函数。
// ============================================================
describe('A3：详情 available 逐个真实调用 ⇒ 无 422（available 与写侧一致，防 R-1）', () => {
  const rowOf = (id: string, defVersion: number) => ({
    id, tenant_id: T, order_no: 'WO_A3_R1', status: 'assigned',
    assignee_id: null, assignee_name: null, def_version: defVersion,
  });

  /** 详情读路径：findOne 形状命中行（行上带 def_version）+ 版本化 def 读。 */
  const detailHandlers = (id: string, defVersion: number): Handler[] => [
    {
      match: (t) => t.includes('FROM work_orders wo') && t.includes('LEFT JOIN worker w'),
      reply: () => ({ rows: [rowOf(id, defVersion)] }),
    },
    ...versionedDefHandlers(),
    { match: (t) => t.includes('FROM ticket_event'), reply: () => ({ rows: [] }) },
  ];

  /** 写路径：行锁读（FOR UPDATE）返回同一行 ⇒ transition() 按**行上锁的那一版**校验。 */
  const transitionHandlers = (id: string, defVersion: number): Handler[] => [
    { match: (t) => t.includes('FOR UPDATE'), reply: () => ({ rows: [rowOf(id, defVersion)], rowCount: 1 }) },
    ...versionedDefHandlers(),
    {
      match: (t) => t.includes('UPDATE work_orders SET status'),
      reply: (_t, p) => ({ rows: [{ ...rowOf(id, defVersion), status: p[0] as string }], rowCount: 1 }),
    },
    { match: (t) => t.includes('SELECT DISTINCT def_version FROM work_orders'), reply: () => ({ rows: [{ def_version: defVersion }] }) },
  ];

  it('老单(def_version=1, live=2)与新单(v2)：详情给的 available 逐个真调 /transition ⇒ 没有一个 422', async () => {
    for (const [id, ver, label] of [
      [WO_OLD_ID, 1, '老单(v1)'],
      [WO_NEW_ID, 2, '新单(v2)'],
    ] as const) {
      // ① available 只认接口返回值（不许自己算）
      const { client } = makeClient(detailHandlers(id, ver));
      h.client = client;
      const detail = await get(`/open/work_order/${id}`);
      expect(detail.status).toBe(200);
      const available = (detail.body.available ?? []) as Array<{ to: string; event: string }>;
      expect(available.length, `${label}：详情必须给出至少 1 个可点动作，否则本条等于没跑`).toBeGreaterThan(0);

      // ② 逐个真调（真实路由 → transition()，每个 event 一次真实 HTTP 往返）
      const rejected: string[] = [];
      for (const a of available) {
        const { client: c2 } = makeClient(transitionHandlers(id, ver));
        h.client = c2;
        const r = await post(`/open/work_order/${id}/transition`, { to: a.to });
        if (r.status === 422) {
          rejected.push(`${label} ${a.event}(assigned→${a.to}) ⇒ 422 ${r.body.code ?? ''} ${r.body.message ?? ''}`);
        }
      }
      // ③ 断言：详情给了按钮、点下去却被写侧拒 ⇒ available 与写侧不一致（R-1 被造出来了）
      expect(rejected).toEqual([]);
    }
  });
});

describe('A4-W：POST /open/work_order 建单盖章（穿透 INSERT 实参）', () => {
  const createBody = (extra: Record<string, unknown> = {}) => ({
    id: WO_ID,
    business_type: 'repair',
    title: '盖章穿透验证',
    ...extra,
  });

  it('INSERT 末位实参 = 取到的版本号（非 0），且取版本号的查询排在 INSERT 之前', async () => {
    // 🔴 version 分支必须排在 createHandlers() 里那条 `includes('FROM workflow_def')` 兜底之前：
    //    `SELECT version FROM workflow_def` 同样含子串 `FROM workflow_def`，顺序反了会被兜底吃掉。
    const { client, calls } = makeClient([
      { match: (t) => t.includes('SELECT version FROM workflow_def'), reply: () => ({ rows: [{ version: 5 }] }) },
      ...createHandlers(),
    ]);
    h.client = client;
    const r = await post('/open/work_order', createBody());
    expect(r.status).toBe(201);

    const insIdx = calls.findIndex((c) => c.text.startsWith('INSERT INTO work_orders'));
    const verIdx = calls.findIndex((c) => c.text.includes('SELECT version FROM workflow_def'));
    expect(insIdx, '必须真的走了建单 INSERT').toBeGreaterThan(-1);
    expect(verIdx, '建单前必须真的取过版本号').toBeGreaterThan(-1);
    expect(verIdx, '取版本号必须排在 INSERT 之前（版本号是写入时的事实，不许事后补）').toBeLessThan(insIdx);

    const params = calls[insIdx].params as unknown[];
    expect(params.length, 'INSERT 实参个数：批4 起为 18 参').toBe(18);
    expect(params[params.length - 1], 'INSERT 末位实参必须是那次取到的版本号').toBe(5);
    expect(params[params.length - 1], '哨兵 0 = 未盖章 ⇒ 不许出现').not.toBe(0);
  });
});

describe('A9-W：刻意不改的三处仍是 live def（静态锁定，不许漂移）', () => {
  const readSrc = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

  /** 取源码里 [from, to) 这段区间（用**下一处顶层锚点**收尾，避免写死行号 ⇒ 重排不给假红）。 */
  function region(text: string, from: string, to: string, label: string): string {
    const a = text.indexOf(from);
    const b = a < 0 ? -1 : text.indexOf(to, a + from.length);
    if (a < 0 || b < 0) throw new Error(`[A9-W] 定位不到 ${label}：源码结构变了，本用例需同步更新`);
    return text.slice(a, b);
  }

  const NO_VERSION_LOCK = (body: string) => {
    expect(body).not.toContain('AtVersion');
    expect(body).not.toContain('getDefsForVersions');
  };

  it('A9-W-①：GET /open/work_order/available 仍按 live def 出 available（刻意不改）', () => {
    const src = readSrc('routes/workOrder.ts');
    const body = region(
      src,
      "router.get('/open/work_order/available'",
      "router.get('/open/work_order/:id/events'",
      '/open/work_order/available 端点',
    );
    expect(body, '该端点必须仍是单次 getWorkflowDef（按状态问"我能不能干这个"，与具体单据无关）').toContain('getWorkflowDef(');
    NO_VERSION_LOCK(body);
  });

  it('A9-W-②：autoDispatchAfterCreate 仍按 live def 派单（刻意不改）', () => {
    const src = readSrc('routes/workOrder.ts');
    const body = region(
      src,
      'async function autoDispatchAfterCreate',
      'const createSchema = z.object(',
      'autoDispatchAfterCreate',
    );
    expect(body, '派单目标态仍取自 live def（新建单的派单策略刻意不做版本化）').toContain('getWorkflowDef(');
    NO_VERSION_LOCK(body);
  });

  it('A9-W-③：services/linkedWorkOrder.ts 仍按 live def（刻意不改，整个文件不许出现版本化读）', () => {
    const src = readSrc('services/linkedWorkOrder.ts');
    expect(src).toContain("getWorkflowDef(client, p.tenantId, 'work_order')");
    NO_VERSION_LOCK(src);
  });
});
