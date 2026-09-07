// workOrderFilterAssigneeFlag.http.test.ts —— 2026-09-07 三项决策的真·HTTP 层回归护栏。
//
//   任务一（决策 #8）：工单列表服务端筛选 department/priority/source/service_desk
//     —— 单独过滤生效 + 与 status 组合生效 + 不传时行为与旧版完全一致（回归）。
//   任务二（决策 #7）：列表/详情下发 assignee_name（LEFT JOIN worker，无承接人 → null）。
//   任务三（决策 #5）：租户开关 ticket_require_service_desk —— 默认关（建单不带服务台完全合法）；
//     开启后直接建单缺服务台 → 422 SERVICE_DESK_REQUIRED；来电弹屏代申告路径豁免；翻转接口。
//
// 断言纪律：一律断言真实 HTTP 状态码（对齐 acceptance.http.test.ts），禁止 try/catch 空过。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  reply: (text: string, params?: unknown[]) => { rows: unknown[]; rowCount?: number };
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
    { match: (t) => t.includes('UPDATE work_orders SET status'), reply: () => ({ rows: [], rowCount: 1 }) },
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

  it('豁免：开关开启后来电弹屏代申告（POST /service-desk/tickets 语义）仍成功', async () => {
    const { client } = makeClient([
      ...createHandlers({ systemConfigValue: 'true' }),
      // serviceDesk 代申告路径：desk 存在性校验 + 幂等回查旧形状兼容
      { match: (t) => t.includes('SELECT id FROM service_desk WHERE id=$1 AND tenant_id=$2'), reply: () => ({ rows: [{ id: DESK_UUID }], rowCount: 1 }) },
    ]);
    h.client = client;
    const r = await post('/tickets', {
      deskId: DESK_UUID,
      callerName: '王护士',
      catalog: 'repair',
      description: '输液泵无法开机',
    });
    expect(r.status).toBe(201);
    expect(r.body.ok).toBe(true);
  });

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
