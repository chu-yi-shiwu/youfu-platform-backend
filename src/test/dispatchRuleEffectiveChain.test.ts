/**
 * 「派单规则生效链」产品属性测试 —— 真 HTTP 存规则 + 真库 + 真派单
 *
 * 【为什么有这份测试】
 *   客户唯一在用的配置能力就是派单规则（t-verification 生产 9 条全启用）。
 *   但此前对它的守护全是 mock 级（autoDispatch.test.ts 用 SQL 子串分流造规则行），
 *   证明的是「给定规则行，选人函数逻辑对」；没有一条测试看守
 *   「客户从界面存的规则 → 真落 dispatch_rule 表 → 派单真按它派」这条产品链。
 *   这条链上任一環断（configRouter 不落盘 / getActiveRules 不读 / 派单不读规则），
 *   1472 个测试可能照样全绿，而客户现场派单全错。
 *
 * 【设计要点（鉴别力）】
 *   match_json.skill_tags 与 strategy_json.skill_tags 刻意不同：
 *     need = plumbing 报修单；规则命中条件=plumbing 单，派单策略=派给 electrical 工。
 *   于是「规则生效」派 w-elec，「规则断/未命中」走 least_load 兜底派 w-plumb——
 *   两种结果落在不同人身上，测试报的 assignee 直接区分两条路径，不可能"蒙对"。
 *
 * 【诚实边界】
 *   - 建单路由本身不经过（其 http 覆盖归 workOrderFilterAssigneeFlag.http.test.ts 等），
 *     本文件焦点是「配置→派单」断点：规则从 HTTP 真入口进、派单在真库上跑。
 *   - PGlite 无 youfu_app 角色/RLS，withTenantClient 的 SET LOCAL 被拦截忽略（同
 *     roleConfigHttpFullChain.test.ts 的既有约定）。
 *   - resolveDispatchShadow 内部 try/catch 吞错（ai_shadow_suggestions 表不存在也只 warn），
 *     不建该表、不断言。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

const T = 't-dispatch-chain';

// ---- PGlite 真库：vi.mock 内不能直接引用外部变量，用 hoisted 容器搬运 ----
const box = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@electric-sql/pglite', async () => {
  const actual = (await vi.importActual('@electric-sql/pglite')) as { PGlite: new () => unknown };
  return { ...actual, PGlite: class extends (actual.PGlite as any) {} };
});

vi.mock('../db/pool.js', () => ({
  default: {
    query: async () => ({ rows: [], rowCount: 0 }),
  },
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => {
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        const s = String(sql);
        if (/^\s*SET\s+LOCAL\s+(ROLE|app\.)/i.test(s)) return { rows: [], rowCount: 0 };
        return (box.db as { query: (a: string, b: unknown[]) => Promise<unknown> }).query(s, params);
      },
    };
    return fn(client);
  },
}));

import { PGlite } from '@electric-sql/pglite';
import configRouter from '../routes/config.js';
import { autoDispatchAfterCreate } from '../routes/workOrder.js';

let server: Server;
let base = '';

/** 与 001/004/008/019/020/022/028/074 真 DDL 对齐，仅剔除 RLS/GRANT/依赖 youfu_app 部分。 */
const DDL = `
CREATE TABLE worker (
  id         text PRIMARY KEY,
  tenant_id  text NOT NULL,
  name       text NOT NULL,
  skill_tags text[] NOT NULL DEFAULT '{}',
  load       int NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE work_orders (
  id            text PRIMARY KEY,
  tenant_id     text NOT NULL,
  business_type text NOT NULL,
  catalog       text,
  priority      text NOT NULL DEFAULT 'normal',
  location      text,
  title         text,
  description   text,
  contact       text,
  status        text NOT NULL DEFAULT 'draft',
  assignee_id   text,
  auto_flow     boolean NOT NULL DEFAULT false,
  assets        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  sla_minutes   int,
  sla_due_at    timestamptz,
  assigned_at   timestamptz
);
CREATE TABLE ticket_event (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL,
  work_order_id text NOT NULL,
  type         text NOT NULL,
  from_status  text,
  to_status    text,
  actor        text,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- 008 + 019（weight/score 学习列）
CREATE TABLE dispatch_rule (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  name          text NOT NULL,
  priority      int NOT NULL DEFAULT 100,
  match_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
  strategy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled       boolean NOT NULL DEFAULT true,
  weight        real NOT NULL DEFAULT 1.0,
  score         real NOT NULL DEFAULT 0.0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE domain_event (
  id          bigserial PRIMARY KEY,
  tenant_id   text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text,
  type        text NOT NULL,
  actor       text,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notification (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  recipient     text NOT NULL,
  recipient_kind text NOT NULL DEFAULT 'worker',
  type          text NOT NULL,
  work_order_id text NOT NULL,
  title         text NOT NULL,
  body          text,
  channel       text NOT NULL DEFAULT 'in_app',
  delivered     boolean NOT NULL DEFAULT false,
  read          boolean NOT NULL DEFAULT false,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE model_state (
  id              bigserial PRIMARY KEY,
  tenant_id       text NOT NULL,
  model_key       text NOT NULL,
  version         int NOT NULL DEFAULT 1,
  params          jsonb NOT NULL DEFAULT '{}'::jsonb,
  metric_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  trained_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, model_key)
);
CREATE TABLE workflow_def (
  id          bigserial PRIMARY KEY,
  tenant_id   text NOT NULL,
  entity_type text NOT NULL,
  def         jsonb NOT NULL DEFAULT '{}'::jsonb,
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity_type)
);
`;

const db = () => box.db as unknown as { query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }> };

beforeAll(async () => {
  box.db = new PGlite();
  await (box.db as unknown as { exec: (s: string) => Promise<void> }).exec(DDL);

  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = {
      tenantId: T,
      role: 'admin',
      authMode: 'prod',
      userId: 'u-admin',
      username: 'admin-a',
      requestId: 'test',
    };
    next();
  });
  app.use('/api/v1', configRouter);
  app.use(errorMiddleware);

  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await (box.db as unknown as { close: () => Promise<void> }).close();
});

beforeEach(async () => {
  for (const t of ['dispatch_rule', 'ticket_event', 'notification', 'work_orders', 'worker']) {
    await db().query(`DELETE FROM ${t}`);
  }
});

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: r.status, body: parsed };
}

const rows = async (sql: string, p: unknown[] = []) => (await db().query(sql, p)).rows;

/** 造两个工人：电工（会 electrical）与水管工（会 plumbing），负载都 0 */
async function seedWorkers() {
  await db().query(
    `INSERT INTO worker (id, tenant_id, name, skill_tags, load, active) VALUES
     ('w-elec',  $1, '电工张', ARRAY['electrical'], 0, true),
     ('w-plumb', $1, '水管李', ARRAY['plumbing'],  0, true)`,
    [T],
  );
}

/** 造一张 draft 工单；need = plumbing 报修单 */
async function seedOrder(id: string) {
  await db().query(
    `INSERT INTO work_orders (id, tenant_id, business_type, priority, status)
     VALUES ($1, $2, 'repair', 'normal', 'draft')`,
    [id, T],
  );
}

/** autoDispatchAfterCreate 只用到 client.query；PGlite 裸 query 即满足 PoolClient 形态 */
function rawClient() {
  return { query: (sql: string, params: unknown[] = []) => db().query(sql, params) } as any;
}

describe('派单规则生效链 —— 客户界面存的规则，真库、真派单（产品属性）', () => {
  it('① 界面存规则真落库：POST /config/dispatch-rules → dispatch_rule 一行 enabled=true', async () => {
    const r = await call('POST', '/config/dispatch-rules', {
      name: '水管单先派电工',
      priority: 200,
      match_json: { business_type: 'repair', skill_tags: ['plumbing'] },
      strategy_json: { type: 'skill_match', skill_tags: ['electrical'] },
    });
    expect(r.status).toBe(201);
    const got = await rows(
      `SELECT name, priority, enabled, match_json, strategy_json FROM dispatch_rule WHERE tenant_id=$1`,
      [T],
    );
    expect(got).toHaveLength(1);
    expect(got[0].name).toBe('水管单先派电工');
    expect(got[0].enabled).toBe(true);
    expect(got[0].match_json).toEqual({ business_type: 'repair', skill_tags: ['plumbing'] });
    expect(got[0].strategy_json).toEqual({ type: 'skill_match', skill_tags: ['electrical'] });
  });

  it('② 规则生效：plumbing 报修单按策略派给电工（非兜底），全链真值落库', async () => {
    await call('POST', '/config/dispatch-rules', {
      name: '水管单先派电工',
      priority: 200,
      match_json: { business_type: 'repair', skill_tags: ['plumbing'] },
      strategy_json: { type: 'skill_match', skill_tags: ['electrical'] },
    });
    await seedWorkers();
    await seedOrder('WO-chain-1');

    const r = await autoDispatchAfterCreate(rawClient(), T, { id: 'WO-chain-1', order_no: 'WO_chain_1' }, {
      business_type: 'repair',
      skill_tags: ['plumbing'],
      priority: 'normal',
    });

    // 派单结果：规则命中 → 电工（reason 带规则名，与兜底文案可区分）
    expect(r.autoFlow).toBe(true);
    expect(r.assignee).toBe('w-elec');
    expect(r.reason).toContain('水管单先派电工');
    expect(r.reason).toContain('auto dispatched by rule');

    // 真库回读：状态/指派人/自动流/里程碑 全部落真
    const wo = await rows(
      `SELECT status, assignee_id, auto_flow, assigned_at, sla_minutes FROM work_orders WHERE id='WO-chain-1'`,
    );
    expect(wo[0].status).toBe('assigned');
    expect(wo[0].assignee_id).toBe('w-elec');
    expect(wo[0].auto_flow).toBe(true);
    expect(wo[0].assigned_at).not.toBeNull();
    expect(wo[0].sla_minutes).not.toBeNull();

    // 工人负载：被派者 +1，另一人不动
    const loads = await rows(`SELECT id, load FROM worker WHERE tenant_id=$1 ORDER BY id`, [T]);
    expect(loads).toEqual([
      { id: 'w-elec', load: 1 },
      { id: 'w-plumb', load: 0 },
    ]);

    // 事件与通知真落库
    const evt = await rows(
      `SELECT type, from_status, to_status, actor FROM ticket_event WHERE work_order_id='WO-chain-1'`,
    );
    expect(evt).toEqual([{ type: 'assign', from_status: 'draft', to_status: 'assigned', actor: 'auto_dispatch' }]);
    const nt = await rows(
      `SELECT recipient, recipient_kind, type FROM notification WHERE work_order_id='WO-chain-1'`,
    );
    expect(nt).toEqual([{ recipient: 'w-elec', recipient_kind: 'worker', type: 'dispatch' }]);
  });

  it('③ 对照组（鉴别力）：规则 enabled=false → 同单走 least_load 兜底派水管工，reason=兜底文案', async () => {
    await call('POST', '/config/dispatch-rules', {
      name: '水管单先派电工',
      priority: 200,
      match_json: { business_type: 'repair', skill_tags: ['plumbing'] },
      strategy_json: { type: 'skill_match', skill_tags: ['electrical'] },
      enabled: true,
    });
    // 直接改库停用（等价于客户在界面关掉规则）
    await db().query(`UPDATE dispatch_rule SET enabled = false WHERE tenant_id=$1`, [T]);
    await seedWorkers();
    await seedOrder('WO-chain-2');

    const r = await autoDispatchAfterCreate(rawClient(), T, { id: 'WO-chain-2', order_no: 'WO_chain_2' }, {
      business_type: 'repair',
      skill_tags: ['plumbing'],
      priority: 'normal',
    });

    // 兜底路径：按 need.skill_tags=['plumbing'] 匹配 → 水管工；与规则路径派的是不同人
    expect(r.autoFlow).toBe(true);
    expect(r.assignee).toBe('w-plumb');
    expect(r.reason).toBe('auto dispatched by least_load fallback');
    const wo = await rows(`SELECT status, assignee_id FROM work_orders WHERE id='WO-chain-2'`);
    expect(wo[0].assignee_id).toBe('w-plumb');
  });

  it('④ 对照组（无规则）：干净库直接派单 → 仍走兜底派水管工（无规则租户行为不变）', async () => {
    await seedWorkers();
    await seedOrder('WO-chain-3');
    const r = await autoDispatchAfterCreate(rawClient(), T, { id: 'WO-chain-3', order_no: 'WO_chain_3' }, {
      business_type: 'repair',
      skill_tags: ['plumbing'],
      priority: 'normal',
    });
    expect(r.assignee).toBe('w-plumb');
    expect(r.reason).toBe('auto dispatched by least_load fallback');
  });
});
