// transportGuard.http.test.ts —— P1（B2 接 allowedRoles + 补 SLA 字段）。
// 真·express + 真 HTTP（对齐 volunteerGuard.http.test.ts 范式），mock 掉 DB 连接池（脚本化 client）。
// 覆盖（审查报告 20260908 🟡"运送线声明式角色门禁未强制"）：
//   ① 在身承运人 worker receive（allowedRoles 含 worker）→ 200
//   ② 在身承运人 worker cancel（allowedRoles 仅 admin/operator）→ 403（P1 缺口锁定回归）
//   ③ admin cancel → 200（放行口径不变）
//   ④ 建单带 sla_due_at → INSERT 落参（B2 补 SLA：期望完成时间入列，供 SLA cron 扫描）
//   ⑤ 建单不带 sla_due_at → INSERT 落 null（诚实：不替租户估时）
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorMiddleware } from '../middleware/error.js';

// ---- mock 掉 DB 连接池：脚本化 SQL 响应 + 调用日志 ----
const h = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] }>,
  scripted: [] as Array<{ match: RegExp; rows: any[]; rowCount?: number }>,
}));
vi.mock('../db/pool.js', () => ({
  default: {},
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tenantId: string, fn: (client: any) => Promise<any>) => {
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        h.calls.push({ sql, params });
        for (const s of h.scripted) {
          if (s.match.test(sql)) return { rows: s.rows, rowCount: s.rowCount ?? s.rows.length };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    return fn(client);
  },
}));

import transportRouter from '../routes/transport.js';

const T = 't-transport-guard';
let server: Server;
let base = '';

// 注入指定角色 + prod 模式（requireAssigneeOrConfig 真校验归属，allowedRoles 门禁真生效）
function injectAuth(role: string) {
  return (_req: any, res: any, next: any) => {
    res.locals.auth = { tenantId: T, role, authMode: 'prod', userId: 'w-1', requestId: 'test' };
    next();
  };
}

function scriptTransportOrder(status: string) {
  h.scripted.length = 0;
  h.calls.length = 0;
  // workflow_def 查不到 → 走 TRANSPORT_DEF 内置默认（门禁口径即内置声明）
  h.scripted.push({ match: /FROM workflow_def/, rows: [] });
  // 归属守卫探测（SELECT id, carrier）与 transitionOrder 全量读（SELECT *）都命中
  h.scripted.push({
    match: /FROM transport_order WHERE id/,
    rows: [{ id: 'to-1', tenant_id: T, status, carrier: 'w-1', item_name: '标本' }],
  });
  h.scripted.push({ match: /FROM worker WHERE tenant_id/, rows: [{ id: 'w-1' }] });
  h.scripted.push({ match: /UPDATE transport_order/, rows: [{ id: 'to-1', status: 'next' }] });
  h.scripted.push({ match: /INSERT INTO transport_track_point/, rows: [] });
  h.scripted.push({ match: /INSERT INTO domain_event/, rows: [] });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/transport', injectAuth('worker'), transportRouter);
  app.use('/api/v1/admin-sim', injectAuth('admin'), transportRouter);
  app.use(errorMiddleware);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('transport transition allowedRoles 门禁（P1）', () => {
  it('① 在身承运人 worker receive → 200（allowedRoles 含 worker）', async () => {
    scriptTransportOrder('assigned');
    const r = await fetch(`${base}/api/v1/transport/orders/to-1/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'receive' }),
    });
    expect(r.status).toBe(200);
  });

  it('② 在身承运人 worker cancel → 403（P1 缺口锁定：此前可越权取消）', async () => {
    scriptTransportOrder('transporting');
    const r = await fetch(`${base}/api/v1/transport/orders/to-1/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'cancel' }),
    });
    expect(r.status).toBe(403);
  });

  it('③ admin cancel → 200（放行口径不变）', async () => {
    scriptTransportOrder('transporting');
    const r = await fetch(`${base}/api/v1/admin-sim/orders/to-1/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'cancel' }),
    });
    expect(r.status).toBe(200);
  });
});

describe('transport 建单 sla_due_at 落参（P1 B2 补 SLA）', () => {
  function scriptCreate() {
    h.scripted.length = 0;
    h.calls.length = 0;
    h.scripted.push({ match: /INSERT INTO transport_order/, rows: [{ id: 'to-new' }] });
    h.scripted.push({ match: /INSERT INTO domain_event/, rows: [] });
  }

  it('④ 带 sla_due_at → INSERT 参数含该值', async () => {
    scriptCreate();
    const r = await fetch(`${base}/api/v1/admin-sim/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item_name: '标本', sla_due_at: '2026-09-09T18:00:00+08:00' }),
    });
    expect(r.status).toBe(201);
    const ins = h.calls.find((c) => /INSERT INTO transport_order/.test(c.sql));
    expect(ins?.sql).toContain('sla_due_at');
    expect(ins?.params).toContain('2026-09-09T18:00:00+08:00');
  });

  it('⑤ 不带 sla_due_at → INSERT 落 null（不纳入 SLA 扫描）', async () => {
    scriptCreate();
    const r = await fetch(`${base}/api/v1/admin-sim/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item_name: '文件' }),
    });
    expect(r.status).toBe(201);
    const ins = h.calls.find((c) => /INSERT INTO transport_order/.test(c.sql));
    expect(ins?.sql).toContain('sla_due_at');
    // sla_due_at 是第 12 个参数（$12），插值位置落 null
    expect(ins?.params[11]).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T1-B 批 2 · transport_order 在途单锁版本
//
// 【与 adapter 那份的分工】src/test/transportAdapter.map.test.ts 验 /flow 代理侧
//   （真 adapter + 假 client，断言"查了几次、哪个版本"）；本文件验原生路由侧：
//   盖章值对不对、读写两侧是不是同一条路径。两侧都要有，只验一侧会留缝。
// ═══════════════════════════════════════════════════════════════════════════
const TRANSPORT_SRC = readFileSync(join(__dirname, '..', 'routes', 'transport.ts'), 'utf8');

describe('T1-B 批2 · transport_order 在途单锁版本', () => {
  it('A4：建单 INSERT 带上 def_version，且值 = 建单时查到的 live version', async () => {
    h.scripted.length = 0;
    h.calls.length = 0;
    // 🔴 刻意让 workflow_def 返回一个**非 0** 的版本号。若让它返回 0（无定义），
    //    实现把版本号写死 0（= 永不上锁，最严重那种错）时本断言照样绿 ——
    //    批 1 在 http 桩上刚踩过这个坑：桩值恰好等于"错误实现的默认值"就是假绿的温床。
    h.scripted.push({ match: /SELECT version FROM workflow_def/, rows: [{ version: 5 }] });
    h.scripted.push({ match: /INSERT INTO transport_order/, rows: [{ id: 'to-new' }] });
    h.scripted.push({ match: /INSERT INTO domain_event/, rows: [] });

    const r = await fetch(`${base}/api/v1/admin-sim/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item_name: '标本' }),
    });
    expect(r.status).toBe(201);
    const ins = h.calls.find((c) => /INSERT INTO transport_order/.test(c.sql));
    expect(ins, '没发建单 SQL').toBeTruthy();
    expect(ins!.sql, 'INSERT 列清单缺 def_version ⇒ 新单不入版本锁').toContain('def_version');
    expect(ins!.params.length, '参数数应为 13（原 12 + def_version）').toBe(13);
    // 漏传 ⇒ length 是 12；写死 0 或别的常量 ⇒ 不等于 5。三种错都能抓住。
    expect(ins!.params[12], 'def_version 参数必须取 getWorkflowDefVersion 的返回值').toBe(5);
  });

  it('A3-静态：读写两侧走同一条 versioned read 路径（漏改任一侧都被这条抓住）', () => {
    const re = /getWorkflowDefAtVersion\(client, tenantId, 'transport_task', [to]\.def_version, TRANSPORT_DEF\)/g;
    expect(TRANSPORT_SRC.match(re)?.length, '写侧 + 读侧 = 2 处，少一处即 R-1').toBe(2);
    // 文件内不得残留裸调用：那条残留路径读的就是 live，等于锁了个寂寞。
    expect(TRANSPORT_SRC).not.toMatch(/getWorkflowDefOrDefault\s*\(/);
  });

  it('A4-实体名：取版本号必须传 transport_task，不是表名 transport_order', () => {
    // 🔴 D1 永久双名：表名 transport_order，def 口径却是 transport_task。
    //    传错会永远返回 0 而一声不响 ⇒ 最典型的静默失败（E3 反面）。这条把实体名钉死。
    const m = TRANSPORT_SRC.match(/getWorkflowDefVersion\(client, tenantId, '([^']+)'\)/);
    expect(m, '源码里没找到取版本号的调用 —— 本测试已与实现脱节').toBeTruthy();
    expect(m![1], 'def 口径实体名必须是 transport_task').toBe('transport_task');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 洞② · 建单即自动派单（HTTP 层：真 express + 真 HTTP）
//
// 【为什么还要这一组】批 1 那 6 例（已迁至 src/test/autoDispatch.test.ts）是**引擎级**：
//   直调 createOrder / transitionOrder，**不过 express、不发 HTTP**。而洞② 的产品承诺
//   「把人从派单环节摘出去」是一条**对外接口承诺**——租户和小程序只看到
//   `POST /api/v1/transport/orders` 的响应。中间隔着鉴权、zod 校验、权限点、
//   withTenantClient 事务、响应外壳 5 层 ⇒ 引擎级绿推不出 HTTP 层绿：任何一层把派单行
//   吞掉或绕过，引擎级用例照样全绿。本组把整条链真跑一遍。
//
// 【为什么落在 transportGuard.http.test.ts】
//   · t5RouteParity.transport.test.ts 的主题是「两条路由行为一致」（原生 vs /flow），
//     往里塞一条只关于单路由的业务断言会稀释它真正要验的东西；
//   · 本文件的主题就是「真 express + 真 HTTP + 运送线」，且 ④⑤/A4 已经在这条链上建单，
//     范式（scripted 桩 + 从 h.calls 断言 SQL 参数）完全同源，可直接复用。
//     （注：ae3b8a6 否掉本文件是因为那批用例是**单元级**直调函数，不是因为文件选错。）
//
// 【断言真值落在哪】桩行是常量，回显什么取决于我写什么 ⇒ 一律**钉 SQL 参数**：
//   UPDATE transport_order 的 $4 就是写入的 carrier（见 transitionOrder 的 values 组装），
//   只有它能证明"选中的是手上活最少的那个"，而不是"桩里写了谁"。
// ═══════════════════════════════════════════════════════════════════════════
describe('洞② · 建单即自动派单（HTTP 层）', () => {
  /** 建单链路的桩：worker 行由调用方给（其余与 scriptTransportOrder 同源）。 */
  function scriptCreateWithWorkers(workerRows: any[], adminRows: any[] = []) {
    h.scripted.length = 0;
    h.calls.length = 0;
    // workflow_def 查不到 ⇒ 走内置 TRANSPORT_DEF（拓扑/门禁口径 = 内置声明）
    h.scripted.push({ match: /FROM workflow_def/, rows: [] });
    // 洞② 选人读的就是这一条；列名必须与 routes/transport.ts 的 autoDispatch 查询逐字一致，
    // 实现改了查询（比如漏掉 active）⇒ 这里匹配不上 ⇒ 桩回空 ⇒ 用例立刻红。
    h.scripted.push({ match: /SELECT id, skill_tags, load, active FROM worker/, rows: workerRows });
    h.scripted.push({
      match: /INSERT INTO transport_order/,
      rows: [{ id: 'to-new', code: 'T-1', status: 'pending', carrier: null, item_name: '标本', def_version: 0 }],
    });
    h.scripted.push({
      match: /SELECT \* FROM transport_order WHERE id/,
      rows: [{ id: 'to-new', status: 'pending', carrier: null, item_name: '标本', def_version: 0 }],
    });
    h.scripted.push({
      match: /UPDATE transport_order/,
      rows: [{ id: 'to-new', status: 'assigned', carrier: 'wt-2', item_name: '标本', def_version: 0 }],
    });
    h.scripted.push({ match: /INSERT INTO transport_track_point/, rows: [] });
    h.scripted.push({ match: /INSERT INTO domain_event/, rows: [] });
    h.scripted.push({ match: /INSERT INTO notification/, rows: [] });
    h.scripted.push({ match: /SELECT id FROM account_user/, rows: adminRows });
    h.scripted.push({ match: /SAVEPOINT/, rows: [] });
    return h.calls;
  }

  function postOrder(body: unknown): Promise<Response> {
    return fetch(`${base}/api/v1/admin-sim/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('① 有在岗工人 ⇒ 201 + status:assigned + carrier 落库 + dispatch 事件 + 1 条通知', async () => {
    const calls = scriptCreateWithWorkers([
      { id: 'wt-1', skill_tags: '[]', load: 3, active: true },
      { id: 'wt-2', skill_tags: '[]', load: 1, active: true },
    ]);

    const r = await postOrder({ item_name: '标本' });
    expect(r.status, '建单必须 201（派单失败不得把建单拖成 500）').toBe(201);
    const body: any = await r.json();
    expect(body.item.status, '建单即自动派单：响应态必须是 assigned，不能停在 pending 等人来派').toBe('assigned');

    const upd = calls.find((c) => /UPDATE transport_order/.test(c.sql));
    expect(upd, '没发派单 UPDATE ⇒ 建单后根本没派出去（洞② 掉链子）').toBeTruthy();
    expect(upd!.params[3], '必须挑中「手上活最少」的在岗工人 wt-2（least_load 口径）').toBe('wt-2');

    // 事件口径：create + dispatch 两条，实体口径都是 transport_order（D1 永久双名）
    const evs = calls.filter((c) => /INSERT INTO domain_event/.test(c.sql));
    expect(evs.map((c) => String(c.params[1]))).toEqual(['transport_order', 'transport_order']);
    expect(evs.map((c) => String(c.params[3])), '建单后必须留下 dispatch 事件').toEqual(['create', 'dispatch']);

    // 通知：被派中的工人收到 1 条（payload 标 transport_order，借位存放的约定）
    const notes = calls.filter((c) => /INSERT INTO notification/.test(c.sql));
    expect(notes.length).toBe(1);
    expect(String(notes[0].params[1]), '通知必须发给被派中的工人').toBe('wt-2');
    expect(String(notes[0].params[9])).toContain('transport_order');
  });

  it('② 无在岗工人 ⇒ 仍 201 + 保持 pending（不谎报派出）+ 通知本租户 active admin', async () => {
    const calls = scriptCreateWithWorkers(
      [{ id: 'wt-off', skill_tags: '[]', load: 0, active: false }],
      [{ id: 'u-admin-1' }],
    );

    const r = await postOrder({ item_name: '标本' });
    expect(r.status, '派不到人不得让建单报错（建单是主行为、派单是增强）').toBe(201);
    const body: any = await r.json();
    // 运送线无池态 ⇒ 保持 pending，不发明新状态（设计如此，不是漏派）
    expect(body.item.status).toBe('pending');
    expect(calls.find((c) => /UPDATE transport_order/.test(c.sql)), '无人可派时不许偷偷把单推进 assigned').toBeUndefined();

    const notes = calls.filter((c) => /INSERT INTO notification/.test(c.sql));
    expect(notes.length).toBe(1);
    expect(String(notes[0].params[1]), '必须通知本租户 active admin 去人工派单（否则这张单又是 56 天无人知）').toBe('u-admin-1');
    // 通知段 SAVEPOINT 隔离：通知失败不得把整个事务拖挂 ⇒ 建单静默消失但 API 谎报 201
    expect(calls.find((c) => /SAVEPOINT/.test(c.sql))).toBeTruthy();

    const evs = calls.filter((c) => /INSERT INTO domain_event/.test(c.sql));
    expect(evs.map((c) => String(c.params[3])), '建单事件照常留痕，且**没有** dispatch 事件').toEqual(['create']);
  });

  it('③ 显式传 carrier ⇒ 系统不覆盖（尊重调用方明确意图，与 needResolver 显式直通同口径）', async () => {
    const calls = scriptCreateWithWorkers([{ id: 'wt-1', skill_tags: '[]', load: 0, active: true }]);

    const r = await postOrder({ item_name: '标本', carrier: 'w-explicit' });
    expect(r.status).toBe(201);
    const ins = calls.find((c) => /INSERT INTO transport_order/.test(c.sql));
    expect(ins?.params).toContain('w-explicit');
    expect(
      calls.find((c) => /UPDATE transport_order/.test(c.sql)),
      '调用方已明确派给谁 ⇒ 系统不得再派一次覆盖它',
    ).toBeUndefined();
  });
});
