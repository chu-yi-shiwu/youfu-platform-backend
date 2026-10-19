/**
 * 「自动派单走客户配的门禁」产品属性测试 —— 真 HTTP 配流程 + 真库 + 真自动派单
 *
 * 【为什么有这份测试】
 *   自动派单（autoDispatchAfterCreate）是旁路：自己写状态/事件/通知，不调
 *   transition()。于是客户配在派单边上的东西只有 requiredFields 被消费，
 *   其余三样在自动路径上全部落空：
 *     ① sideEffects（pause_sla/resume_sla/notify_*）—— 不执行；
 *     ② 自动审核规则（workflow_auto_rule，挂在 transition() 尾部）—— 不触发；
 *     ③ auto_flow 口径 —— 旁路写 true，一旦并入 transition() 会被
 *        「带 assignee 必为人工」的 P0-6 逻辑打成 false（自动派单率失真）。
 *   本文件守护的是产品事实：**客户配的规矩，系统干活也必须守**。
 *
 * 【设计要点（鉴别力）】
 *   自建租户流程（不依赖 RICH 模板注入，排除机制态干扰）：
 *     draft --assign--> assigned（派单边，配 sideEffects=['pause_sla']）
 *     draft --submit_to_review--> pending_review
 *     pending_review --approve--> review_passed（自动审核规则挂这里）
 *   每条用例的期望都直接读真库落值，不可能"蒙对"。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

const T = 't-dispatch-gates';

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
import workflowDefRouter from '../routes/workflowDef.js';
import { autoDispatchAfterCreate } from '../routes/workOrder.js';

let server: Server;
let base = '';

/** 与真 DDL 对齐（001/004/008/019/020/022/028/074/094），仅剔除 RLS/GRANT/youfu_app 部分。 */
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
  sla_paused_at timestamptz,
  assigned_at   timestamptz,
  ext           jsonb NOT NULL DEFAULT '{}'::jsonb
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
  title         text,
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
-- 094 workflow_auto_rule（对齐真 DDL；event CHECK 保留）
CREATE TABLE workflow_auto_rule (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  entity_type text NOT NULL DEFAULT 'work_order',
  from_state  text NOT NULL,
  event       text NOT NULL CHECK (event IN ('approve','reject')),
  conditions  jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled     boolean NOT NULL DEFAULT false,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity_type, from_state, event)
);
-- 065 ai_shadow_suggestions（resolveDispatchShadow 真实写；缺表会让事务进 aborted 态，
-- 与生产 QA-P1 事故同因——生产有该表，测试必须齐）
CREATE TABLE ai_shadow_suggestions (
  id           bigserial PRIMARY KEY,
  tenant_id    text NOT NULL,
  work_order_id text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('category','dispatch')),
  suggested    text NOT NULL DEFAULT '',
  suggested_by text NOT NULL DEFAULT 'k2',
  actual       text,
  matched      boolean,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
CREATE TABLE account_user (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  text NOT NULL,
  username   text NOT NULL,
  role       text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, username)
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
  app.use('/api/v1/workflow-defs', workflowDefRouter);
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
  for (const t of [
    'dispatch_rule', 'ticket_event', 'notification', 'work_orders', 'worker',
    'workflow_def', 'workflow_auto_rule', 'account_user',
  ]) {
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

/** 自建租户流程：派单边 draft→assigned 带 sideEffects；另留派单直达待审的路径。
 *  直插 live workflow_def（等价于"客户配好且已审批生效"的流程）——审批链本身
 *  由既有 workflowDef 测试守护，本文件焦点是「派单守不守客户配的规矩」。 */
async function seedDef(opts: { withSideEffect?: boolean; routeTo?: string } = {}) {
  const routeTo = opts.routeTo ?? 'assigned';
  await db().query(
    `INSERT INTO workflow_def (tenant_id, entity_type, def, version)
     VALUES ($1, 'work_order', $2::jsonb, 1)
     ON CONFLICT (tenant_id, entity_type) DO UPDATE SET def = EXCLUDED.def, version = workflow_def.version + 1`,
    [T, JSON.stringify({
      initial: 'draft',
      states: ['draft', 'assigned', 'processing', 'completed', 'pending_review', 'review_passed'],
      transitions: [
        {
          from: 'draft', to: 'assigned', event: 'assign',
          ...(opts.withSideEffect ? { sideEffects: ['pause_sla'] } : {}),
        },
        { from: 'assigned', to: 'processing', event: 'start' },
        { from: 'processing', to: 'completed', event: 'complete' },
        { from: 'draft', to: 'pending_review', event: 'submit_to_review' },
        { from: 'pending_review', to: 'review_passed', event: 'approve' },
        { from: 'review_passed', to: 'completed', event: 'complete' },
      ],
      config: { autoRoutes: { draft: { to: routeTo, strategy: 'least_load' } } },
    })],
  );
}

async function seedWorkers() {
  await db().query(
    `INSERT INTO worker (id, tenant_id, name, skill_tags, load, active) VALUES
     ('w-a', $1, '工人甲', ARRAY['plumbing'], 0, true)`,
    [T],
  );
}

async function seedOrder(id: string) {
  await db().query(
    `INSERT INTO work_orders (id, tenant_id, business_type, priority, status)
     VALUES ($1, $2, 'repair', 'normal', 'draft')`,
    [id, T],
  );
}

function rawClient() {
  return { query: (sql: string, params: unknown[] = []) => db().query(sql, params) } as any;
}

/** PGlite 单连接：SAVEPOINT 只在事务块内合法（生产里由 withTenantClient 提供事务）；
 *  测试里显式包 BEGIN/ROLLBACK，语义与生产的「通知段失败只回滚自己」一致。 */
async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  await db().query('BEGIN');
  try {
    return await fn();
  } finally {
    await db().query('ROLLBACK');
  }
}

describe('自动派单走客户配的门禁 —— 系统干活也必须守客户规矩（产品属性）', () => {
  it('① 派单边的 sideEffects 必须执行：客户配 pause_sla，自动派单后 SLA 暂停落库', async () => {
    await seedDef({ withSideEffect: true });
    await seedWorkers();
    await seedOrder('WO-gate-1');

    await inTx(async () => {
      const r = await autoDispatchAfterCreate(rawClient(), T, { id: 'WO-gate-1', order_no: 'WO_gate_1' }, {
        business_type: 'repair',
        priority: 'normal',
      });
      expect(r.autoFlow).toBe(true);
      expect(r.assignee).toBe('w-a');

      // 客户配在派单边上的副作用：暂停 SLA —— 真库落值
      const wo = await rows(`SELECT status, sla_paused_at, auto_flow FROM work_orders WHERE id='WO-gate-1'`);
      expect(wo[0].status).toBe('assigned');
      expect(wo[0].sla_paused_at).not.toBeNull();
    });
  });

  it('② 自动审核规则必须被自动派单触发：派单直达 pending_review → 规则自动推到 review_passed', async () => {
    await seedDef({ routeTo: 'pending_review' });
    // 客户在「自动处理」页配的规则：进入待审就自动审过
    const rule = await call('PUT', '/workflow-defs/work_order/auto-rules', {
      from_state: 'pending_review',
      event: 'approve',
      conditions: {},
      enabled: true,
      note: '测试：自动审过',
    });
    expect(rule.status).toBe(200);
    await seedWorkers();
    await seedOrder('WO-gate-2');

    await inTx(async () => {
      await autoDispatchAfterCreate(rawClient(), T, { id: 'WO-gate-2', order_no: 'WO_gate_2' }, {
        business_type: 'repair',
        priority: 'normal',
      });

      // 自动派单落 pending_review 后，客户的自动审核规则必须接走 → review_passed
      const wo = await rows(`SELECT status FROM work_orders WHERE id='WO-gate-2'`);
      expect(wo[0].status).toBe('review_passed');
      const ev = await rows(
        `SELECT type, actor FROM ticket_event WHERE work_order_id='WO-gate-2' AND type='auto_rule'`,
      );
      expect(ev).toHaveLength(1);
      expect(ev[0].actor).toBe('system:auto');
    });
  });

  it('③ auto_flow 口径守护：自动派单并入主通道后，auto_flow 仍为 true（不被人工口径污染）', async () => {
    await seedDef();
    await seedWorkers();
    await seedOrder('WO-gate-3');

    await inTx(async () => {
      await autoDispatchAfterCreate(rawClient(), T, { id: 'WO-gate-3', order_no: 'WO_gate_3' }, {
        business_type: 'repair',
        priority: 'normal',
      });

      const wo = await rows(`SELECT auto_flow FROM work_orders WHERE id='WO-gate-3'`);
      expect(wo[0].auto_flow).toBe(true);
    });
  });

  it('④ 未命中落厅机制不变：enter_hall 事件带 reason，通知全部 active admin', async () => {
    await seedDef();
    // 无工人 → 必然未命中
    await db().query(
      `INSERT INTO account_user (tenant_id, username, role) VALUES ($1, 'boss', 'admin')`,
      [T],
    );
    await seedOrder('WO-gate-4');

    await inTx(async () => {
      const r = await autoDispatchAfterCreate(rawClient(), T, { id: 'WO-gate-4', order_no: 'WO_gate_4' }, {
        business_type: 'repair',
        priority: 'normal',
      });
      expect(r.autoFlow).toBe(false);

      const wo = await rows(`SELECT status FROM work_orders WHERE id='WO-gate-4'`);
      expect(wo[0].status).toBe('claim_hall'); // 机制态由读路径注入保证合法
      const ev = await rows(
        `SELECT type, payload FROM ticket_event WHERE work_order_id='WO-gate-4' AND type='enter_hall'`,
      );
      expect(ev).toHaveLength(1);
      expect(ev[0].payload.reason).toBe('no_available_worker');
      const notes = await rows(
        `SELECT recipient_kind FROM notification WHERE work_order_id='WO-gate-4' AND type='dispatch'`,
      );
      expect(notes.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('⑤ F1 守护：派单边要求非 assignee 必填字段 → 系统无法提供，明确 422（不静默跳门禁）', async () => {
    await db().query(
      `INSERT INTO workflow_def (tenant_id, entity_type, def, version)
       VALUES ($1, 'work_order', $2::jsonb, 1)
       ON CONFLICT (tenant_id, entity_type) DO UPDATE SET def = EXCLUDED.def, version = workflow_def.version + 1`,
      [T, JSON.stringify({
        initial: 'draft',
        states: ['draft', 'assigned', 'processing', 'completed'],
        transitions: [
          { from: 'draft', to: 'assigned', event: 'assign', requiredFields: ['contact'] },
          { from: 'assigned', to: 'processing', event: 'start' },
          { from: 'processing', to: 'completed', event: 'complete' },
        ],
        config: { autoRoutes: { draft: { to: 'assigned', strategy: 'least_load' } } },
      })],
    );
    await seedWorkers();
    await seedOrder('WO-gate-5');

    await inTx(async () => {
      await expect(
        autoDispatchAfterCreate(rawClient(), T, { id: 'WO-gate-5', order_no: 'WO_gate_5' }, {
          business_type: 'repair',
          priority: 'normal',
        }),
      ).rejects.toThrow();
    });
  });

  // ── F8（2026-10-19）：落抢单大厅由旁路 UPDATE 并入 transition() 主通道 ──
  // 旧行为：workOrder.ts / linkedWorkOrder.ts 各写一条 `UPDATE work_orders SET status='claim_hall'`
  //   并手工插 enter_hall 事件 —— 客户配在**入厅边**上的规矩一条都不生效，
  //   domain_event（过程挖掘）也根本没有这一节。以下三条钉住"并入之后"的产品事实。

  it('⑥ 入厅边的 sideEffects 必须执行：客户配 pause_sla，落大厅后 SLA 暂停落库（旁路时代恒为 NULL）', async () => {
    await db().query(
      `INSERT INTO workflow_def (tenant_id, entity_type, def, version)
       VALUES ($1, 'work_order', $2::jsonb, 1)
       ON CONFLICT (tenant_id, entity_type) DO UPDATE SET def = EXCLUDED.def, version = workflow_def.version + 1`,
      [T, JSON.stringify({
        initial: 'draft',
        states: ['draft', 'assigned', 'processing', 'completed'],
        transitions: [
          { from: 'draft', to: 'assigned', event: 'assign' },
          { from: 'assigned', to: 'processing', event: 'start' },
          { from: 'processing', to: 'completed', event: 'complete' },
          // 客户自建入厅边并配副作用：机制注入因同 from+event 已存在而跳过（客户配置优先）
          { from: 'draft', to: 'claim_hall', event: 'enter_hall', sideEffects: ['pause_sla'] },
        ],
        config: { autoRoutes: { draft: { to: 'assigned', strategy: 'least_load' } } },
      })],
    );
    await seedOrder('WO-gate-6'); // 无工人 → 必落大厅

    await inTx(async () => {
      await autoDispatchAfterCreate(rawClient(), T, { id: 'WO-gate-6', order_no: 'WO_gate_6' }, {
        business_type: 'repair',
        priority: 'normal',
      });
      const wo = await rows(`SELECT status, sla_paused_at FROM work_orders WHERE id='WO-gate-6'`);
      expect(wo[0].status).toBe('claim_hall');
      expect(wo[0].sla_paused_at).not.toBeNull(); // 客户配的副作用真的执行了
    });
  });

  it('⑦ 落大厅必须进 domain_event（过程挖掘留痕，旁路时代这一节凭空消失）', async () => {
    await seedDef();
    await seedOrder('WO-gate-7'); // 无工人 → 必落大厅

    await inTx(async () => {
      await autoDispatchAfterCreate(rawClient(), T, { id: 'WO-gate-7', order_no: 'WO_gate_7' }, {
        business_type: 'repair',
        priority: 'normal',
      });
      const dom = await rows(
        `SELECT type, payload FROM domain_event WHERE entity_id='WO-gate-7' AND type='claim_hall'`,
      );
      expect(dom).toHaveLength(1);
      expect(dom[0].payload.from_status).toBe('draft'); // 真实初态（旁路时代 from=to=claim_hall 的笔误已修正）
      expect(dom[0].payload.reason).toBe('no_available_worker'); // 失配原因随事件带出，stats 聚合口径保住
    });
  });

  it('⑧ 入厅边要求必填字段 → 系统无法提供，明确失败（不静默跳门禁，与派单边同口径）', async () => {
    await db().query(
      `INSERT INTO workflow_def (tenant_id, entity_type, def, version)
       VALUES ($1, 'work_order', $2::jsonb, 1)
       ON CONFLICT (tenant_id, entity_type) DO UPDATE SET def = EXCLUDED.def, version = workflow_def.version + 1`,
      [T, JSON.stringify({
        initial: 'draft',
        states: ['draft', 'assigned', 'processing', 'completed'],
        transitions: [
          { from: 'draft', to: 'assigned', event: 'assign' },
          // 客户在入厅边上配必填：系统落厅时拿不到 → 与派单边同口径，明确失败而非静默落厅
          { from: 'draft', to: 'claim_hall', event: 'enter_hall', requiredFields: ['hall_intake_note'] },
        ],
        config: { autoRoutes: { draft: { to: 'assigned', strategy: 'least_load' } } },
      })],
    );
    await seedOrder('WO-gate-8');

    await inTx(async () => {
      await expect(
        autoDispatchAfterCreate(rawClient(), T, { id: 'WO-gate-8', order_no: 'WO_gate_8' }, {
          business_type: 'repair',
          priority: 'normal',
        }),
      ).rejects.toThrow();
      const wo = await rows(`SELECT status FROM work_orders WHERE id='WO-gate-8'`);
      expect(wo[0].status).toBe('draft'); // 没被静默写进大厅
    });
  });
});
