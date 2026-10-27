/**
 * 「挂起态由流程派生，不硬编码」产品属性测试 —— 真库 + 真 transition() 主通道
 *
 * 【为什么有这份测试】
 *   worker.load（= 工人当前在身单数）是**派单负载均衡的唯一输入**
 *   （engine/dispatch.ts:46/79/105 的 least_load / 模型评分都按它排序）。
 *   而"在不在身"的判定此前在两处各写死 `'paused'/'suspended'`：
 *     · repo/ticket.ts      —— load 净结算（离场 -1 / 入场 +1）
 *     · scheduler/slaScheduler.ts —— SLA 扫描活跃集
 *   完成态/终态却早已是流程派生的（doneStates/terminalStates）。于是客户在流程里
 *   自定义挂起态名（如 waiting_part / on_hold）时：
 *     · 人已离场，load 却不减 → 该工人长期虚高 → 派单均衡把单派给别人（或压根派不出）；
 *     · 挂起的单 SLA 继续跑 → 超时率被污染。
 *   这正是"客户配了个状态，引擎不认识"——违反「不改代码发版、界面全搞定」第一原则。
 *
 * 【设计要点（鉴别力）】
 *   用**客户自定义挂起态名**的流程（全程不出现 paused/suspended 字面量）：
 *   若实现回退成硬编码，下列断言立刻红。每条期望都读真库落值。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

const T = 't-load-drift';

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
import { workerLoadDrift } from '../repo/stats.js';

/** 与真 DDL 对齐（001/004/008/019/020/022/028/065/074/094），仅剔除 RLS/GRANT/youfu_app 部分。 */
const DDL = `
CREATE TABLE worker (
  id         text PRIMARY KEY,
  tenant_id  text NOT NULL,
  name       text NOT NULL,
  account_id text,
  department text,
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
  order_no      text,
  department    text,
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
  ext           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- T1-B 103 迁移（work_orders.def_version）所加列：本文件是手写 DDL，等价补齐，
  -- 否则 workerLoadDrift 走「各版本名单」时 SELECT DISTINCT def_version 会报列不存在。
  def_version   int NOT NULL DEFAULT 0
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
  for (const t of [
    'ticket_event', 'domain_event', 'notification', 'work_orders', 'worker',
    'workflow_def', 'workflow_auto_rule', 'ai_shadow_suggestions',
  ]) {
    await db().query(`DELETE FROM ${t}`);
  }
});

const rows = async (sql: string, p: unknown[] = []) => (await db().query(sql, p)).rows;

async function seedDef(def: unknown) {
  await db().query(
    `INSERT INTO workflow_def (tenant_id, entity_type, def, version)
     VALUES ($1, 'work_order', $2::jsonb, 1)
     ON CONFLICT (tenant_id, entity_type) DO UPDATE SET def = EXCLUDED.def, version = workflow_def.version + 1`,
    [T, JSON.stringify(def)],
  );
}

function rawClient() {
  return { query: (sql: string, params: unknown[] = []) => db().query(sql, params) } as any;
}

async function seedWorker(id: string, load: number) {
  await db().query(
    `INSERT INTO worker (id, tenant_id, name, skill_tags, load, active) VALUES ($1, $2, $3, ARRAY['plumbing'], $4, true)`,
    [id, T, `工人-${id}`, load],
  );
}

async function seedOrder(id: string, status: string, assignee: string | null) {
  await db().query(
    `INSERT INTO work_orders (id, tenant_id, business_type, priority, status, assignee_id, order_no)
     VALUES ($1, $2, 'repair', 'normal', $3, $4, $5)`,
    [id, T, status, assignee, `WO_${id}`],
  );
}

/** 含自定义挂起态的流程：waiting_part 挂起不计在身（与 load 净结算同源）。 */
const DEF = {
  initial: 'draft',
  states: ['draft', 'handling', 'waiting_part', 'completed', 'cancelled'],
  transitions: [
    { from: 'draft', to: 'handling', event: 'assign' },
    { from: 'handling', to: 'waiting_part', event: 'wait_part', sideEffects: ['pause_sla'] },
    { from: 'waiting_part', to: 'handling', event: 'resume', sideEffects: ['resume_sla'] },
    { from: 'handling', to: 'completed', event: 'finish' },
    { from: 'handling', to: 'cancelled', event: 'cancel' },
  ],
  config: { doneStates: ['completed'] },
};

describe('worker.load 漂移对账（只读诊断，不自动改数据）', () => {
  it('① 逐工人比对：load 与真实在身单的差值如实暴露（正=虚高少派，负=虚低多派）', async () => {
    await seedDef(DEF);
    await seedWorker('w-ok', 1);
    await seedWorker('w-high', 9);
    await seedWorker('w-low', 1);
    await seedOrder('o1', 'handling', 'w-ok');
    await seedOrder('o2', 'handling', 'w-low');
    await seedOrder('o3', 'handling', 'w-low');
    await seedOrder('o4', 'handling', 'w-low');

    const out = await workerLoadDrift(rawClient(), T);
    const by = Object.fromEntries(out.map((x) => [x.worker_id, x]));
    expect(by['w-ok']).toMatchObject({ load: 1, active_orders: 1, drift: 0 });
    expect(by['w-high']).toMatchObject({ load: 9, active_orders: 0, drift: 9 });
    expect(by['w-low']).toMatchObject({ load: 1, active_orders: 3, drift: -2 });
    // 失真最大的排最前（管理员一眼看到要紧的）
    expect(out[0].worker_id).toBe('w-high');
  });

  it('② 口径同源：挂起态/完成态/终态的单不计在身（与 load 净结算一致，不重复计）', async () => {
    await seedDef(DEF);
    await seedWorker('w-a', 0);
    await seedOrder('o-hold', 'waiting_part', 'w-a');   // 挂起 → 不计
    await seedOrder('o-done', 'completed', 'w-a');      // 完成 → 不计
    await seedOrder('o-cancel', 'cancelled', 'w-a');    // 终态 → 不计
    await seedOrder('o-live', 'handling', 'w-a');       // 活跃 → 计 1

    const out = await workerLoadDrift(rawClient(), T);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ active_orders: 1, drift: -1 });
  });

  it('③ 只读：对账不写任何数据（worker.load 与工单状态原样不动）', async () => {
    await seedDef(DEF);
    await seedWorker('w-a', 5);
    await seedOrder('o-live', 'handling', 'w-a');
    await workerLoadDrift(rawClient(), T);
    const w = await rows(`SELECT load FROM worker WHERE id='w-a'`);
    expect(w[0].load).toBe(5); // 对账只报不改——校正写库必须人工批准
  });
});
