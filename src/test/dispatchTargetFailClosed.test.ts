/**
 * 派单目标态 fail-closed（对齐审查修复 F1，2026-10-19）
 *
 * 【缺陷实证（审查发现）】
 *   两处派单旁路（routes/workOrder.ts autoDispatchAfterCreate、services/linkedWorkOrder.ts）
 *   都写 `autoRouteFor(def, initial)?.to ?? 'assigned'`：租户未配置 autoRoutes 时硬编码
 *   回退 'assigned'。若该租户 def 根本没有 assigned 态（自定义流程完全可以用别的
 *   状态名），派单直接把单子写进客户流程里不存在的状态，之后 transition() 的
 *   isKnownState 拒绝一切流转 = 造失管单。
 *   现网无实例（t-verification/t-phasea 均配了 autoRoutes draft→assigned，走①不受影响），
 *   但是地基级潜在缺陷：客户配什么流程，派单就必须落在什么流程里。
 *
 * 【修法】resolveDispatchTarget（engine/stateMachine.ts 纯函数，旁路唯一入口）：
 *   ① autoRoutes 合法声明 → 用之；
 *   ② 未配置 → 初态第一条「非终态且非完成态」转移的目标（客户流程的天然第一步，
 *      对 RICH/DEFAULT 即 assigned，与旧硬编码在标准 def 上结果一致）；
 *   ③ 没有可用转移 → null，调用方 422 拒绝派单（不再硬编码任何状态名）。
 *   另：解析边的 requiredFields 里除 assignee（系统派单自带）外无法提供的字段 → 422，
 *   绝不静默跳过客户配在派单边上的门禁。
 *
 * 【鉴别力设计】自定义 def 的状态名刻意与内置全套不同（pending/triaged/done），
 *   旧代码写 'assigned'（未知态）与新代码写 'triaged'（客户流程真实第一步）
 *   结果完全不同，测试直接区分两条路径，不可能蒙对。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  resolveDispatchTarget,
  DEFAULT_WORK_ORDER_DEF,
  RICH_WORK_ORDER_DEF,
  type WorkflowDef,
} from '../engine/stateMachine.js';

const T = 't-dispatch-target';

// ---- PGlite 真库（同 dispatchRuleEffectiveChain.test.ts 约定）----
const box = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@electric-sql/pglite', async () => {
  const actual = (await vi.importActual('@electric-sql/pglite')) as { PGlite: new () => unknown };
  return { ...actual, PGlite: class extends (actual.PGlite as any) {} };
});

vi.mock('../db/pool.js', () => ({
  default: { query: async () => ({ rows: [], rowCount: 0 }) },
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => {
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        if (/^\s*SET\s+LOCAL\s+(ROLE|app\.)/i.test(String(sql))) return { rows: [], rowCount: 0 };
        return (box.db as { query: (a: string, b: unknown[]) => Promise<unknown> }).query(sql, params);
      },
    };
    return fn(client);
  },
}));

import { PGlite } from '@electric-sql/pglite';
import { autoDispatchAfterCreate } from '../routes/workOrder.js';

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
});

afterAll(async () => {
  await (box.db as unknown as { close: () => Promise<void> }).close();
});

beforeEach(async () => {
  for (const t of ['dispatch_rule', 'ticket_event', 'notification', 'work_orders', 'worker', 'workflow_def']) {
    await db().query(`DELETE FROM ${t}`);
  }
});

const rows = async (sql: string, p: unknown[] = []) => (await db().query(sql, p)).rows;

async function seedDef(def: WorkflowDef) {
  await db().query(
    `INSERT INTO workflow_def (tenant_id, entity_type, def, version) VALUES ($1, 'work_order', $2, 1)`,
    [T, JSON.stringify(def)],
  );
}

async function seedWorkers() {
  await db().query(
    `INSERT INTO worker (id, tenant_id, name, skill_tags, load, active) VALUES
     ('w-elec', $1, '电工张', ARRAY['electrical'], 0, true)`,
    [T],
  );
}

async function seedOrder(id: string, status = 'pending') {
  await db().query(
    `INSERT INTO work_orders (id, tenant_id, business_type, priority, status)
     VALUES ($1, $2, 'repair', 'normal', $3)`,
    [id, T, status],
  );
}

function rawClient() {
  return { query: (sql: string, params: unknown[] = []) => db().query(sql, params) } as any;
}

/** 自定义 def：状态名与内置全套不同（pending/triaged/done），无 autoRoutes */
const CUSTOM_DEF: WorkflowDef = {
  initial: 'pending',
  states: ['pending', 'triaged', 'done'],
  transitions: [
    { from: 'pending', to: 'triaged', event: 'triage' },
    { from: 'triaged', to: 'done', event: 'finish' },
  ],
};

describe('F1-a resolveDispatchTarget 纯函数（派单目标态单一解析入口）', () => {
  it('① autoRoutes 合法声明 → 用之（配置优先，现网 t-verification/t-phasea 走此路）', () => {
    expect(resolveDispatchTarget(RICH_WORK_ORDER_DEF, 'draft')).toBe('assigned');
    expect(resolveDispatchTarget(DEFAULT_WORK_ORDER_DEF, 'draft')).toBe('assigned'); // 无 autoRoutes → 落到②
  });

  it('② 未配置 autoRoutes → 初态第一条非终态/非完成态转移（客户流程的天然第一步）', () => {
    expect(resolveDispatchTarget(CUSTOM_DEF, 'pending')).toBe('triaged');
  });

  it('③ 初态没有任何可用转移（出边全是终态/完成态）→ null，调用方必须 422', () => {
    const dead: WorkflowDef = {
      initial: 'pending',
      states: ['pending', 'done'],
      transitions: [{ from: 'pending', to: 'done', event: 'finish' }],
    };
    expect(resolveDispatchTarget(dead, 'pending')).toBeNull();
  });

  it('④ 绝不再返回硬编码 assigned：def 无 assigned 态时结果必须是客户流程里的态', () => {
    expect(CUSTOM_DEF.states).not.toContain('assigned');
    expect(resolveDispatchTarget(CUSTOM_DEF, 'pending')).not.toBe('assigned');
  });
});

describe('F1-b autoDispatchAfterCreate 集成（真库、真派单、目标态 fail-closed）', () => {
  it('⑤ 自定义 def 派单落在客户流程真实第一步（旧代码会写未知态 assigned）', async () => {
    await seedDef(CUSTOM_DEF);
    await seedWorkers();
    await seedOrder('WO-tgt-1', 'pending');

    const r = await autoDispatchAfterCreate(rawClient(), T, { id: 'WO-tgt-1', order_no: 'WO_tgt_1' }, {
      business_type: 'repair',
      skill_tags: ['electrical'],
      priority: 'normal',
    });

    expect(r.autoFlow).toBe(true);
    expect(r.assignee).toBe('w-elec');
    expect(r.dispatchTarget).toBe('triaged');
    const wo = await rows(`SELECT status, assignee_id, auto_flow FROM work_orders WHERE id='WO-tgt-1'`);
    expect(wo[0].status).toBe('triaged');
    expect(wo[0].assignee_id).toBe('w-elec');
    expect(wo[0].auto_flow).toBe(true);
    const evt = await rows(`SELECT type, from_status, to_status FROM ticket_event WHERE work_order_id='WO-tgt-1'`);
    expect(evt).toEqual([{ type: 'assign', from_status: 'pending', to_status: 'triaged' }]);
  });

  it('⑥ 自定义 def 无可用派单路径 → 422 拒绝派单，工单保持初始态不落未知态', async () => {
    const dead: WorkflowDef = {
      initial: 'pending',
      states: ['pending', 'done'],
      transitions: [{ from: 'pending', to: 'done', event: 'finish' }],
    };
    await seedDef(dead);
    await seedWorkers();
    await seedOrder('WO-tgt-2', 'pending');

    await expect(
      autoDispatchAfterCreate(rawClient(), T, { id: 'WO-tgt-2', order_no: 'WO_tgt_2' }, {
        business_type: 'repair',
        skill_tags: ['electrical'],
        priority: 'normal',
      }),
    ).rejects.toThrow(/自动派单/);
    const wo = await rows(`SELECT status, assignee_id FROM work_orders WHERE id='WO-tgt-2'`);
    expect(wo[0].status).toBe('pending');
    expect(wo[0].assignee_id).toBeNull();
  });

  it('⑦ 派单边要求系统无法提供的必填字段 → 422（不静默跳过客户门禁）', async () => {
    const gated: WorkflowDef = {
      initial: 'pending',
      states: ['pending', 'triaged', 'done'],
      transitions: [
        { from: 'pending', to: 'triaged', event: 'triage', requiredFields: ['location'] },
        { from: 'triaged', to: 'done', event: 'finish' },
      ],
    };
    await seedDef(gated);
    await seedWorkers();
    await seedOrder('WO-tgt-3', 'pending');

    await expect(
      autoDispatchAfterCreate(rawClient(), T, { id: 'WO-tgt-3', order_no: 'WO_tgt_3' }, {
        business_type: 'repair',
        skill_tags: ['electrical'],
        priority: 'normal',
      }),
    ).rejects.toThrow(/必填字段/);
    const wo = await rows(`SELECT status FROM work_orders WHERE id='WO-tgt-3'`);
    expect(wo[0].status).toBe('pending');
  });

  it('⑧ 无 def 行租户（内置 DEFAULT 兜底）→ 仍落 assigned（零配置开通行为不变）', async () => {
    await seedWorkers();
    await seedOrder('WO-tgt-4', 'draft');
    const r = await autoDispatchAfterCreate(rawClient(), T, { id: 'WO-tgt-4', order_no: 'WO_tgt_4' }, {
      business_type: 'repair',
      skill_tags: ['electrical'],
      priority: 'normal',
    });
    expect(r.dispatchTarget).toBe('assigned');
    const wo = await rows(`SELECT status FROM work_orders WHERE id='WO-tgt-4'`);
    expect(wo[0].status).toBe('assigned');
  });
});
