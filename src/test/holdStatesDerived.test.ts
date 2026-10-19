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
import type { PoolClient } from 'pg';

const T = 't-hold-derived';

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
import { transition } from '../repo/ticket.js';
import { holdStates, activeStates } from '../engine/stateMachine.js';

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

async function seedWorker(id = 'w-a', load = 0) {
  await db().query(
    `INSERT INTO worker (id, tenant_id, name, skill_tags, load, active) VALUES ($1, $2, '工人甲', ARRAY['plumbing'], $3, true)`,
    [id, T, load],
  );
}

async function seedOrder(id: string, status: string, assignee: string | null) {
  await db().query(
    `INSERT INTO work_orders (id, tenant_id, business_type, priority, status, assignee_id, order_no)
     VALUES ($1, $2, 'repair', 'normal', $3, $4, $5)`,
    [id, T, status, assignee, `WO_${id}`],
  );
}

function rawClient() {
  return { query: (sql: string, params: unknown[] = []) => db().query(sql, params) } as any;
}

async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  await db().query('BEGIN');
  try {
    return await fn();
  } finally {
    await db().query('ROLLBACK');
  }
}

const move = (id: string, to: string, opts: Record<string, unknown> = {}) =>
  transition(rawClient() as PoolClient, T, id, to as never, { actor: 'admin-1', role: 'admin', ...opts } as never);

/**
 * 客户自定义挂起态流程（全程不出现 paused/suspended 字面量）：
 *   draft --assign--> handling --wait_part--> waiting_part --resume--> handling --finish--> completed
 * waiting_part 边上挂着 sideEffects: ['pause_sla'] —— 挂起的语义锚点。
 */
function customHoldDef(opts: { explicit?: boolean } = {}) {
  return {
    initial: 'draft',
    states: ['draft', 'handling', 'waiting_part', 'completed'],
    transitions: [
      { from: 'draft', to: 'handling', event: 'assign' },
      { from: 'handling', to: 'waiting_part', event: 'wait_part', sideEffects: ['pause_sla'] },
      { from: 'waiting_part', to: 'handling', event: 'resume', sideEffects: ['resume_sla'] },
      { from: 'handling', to: 'completed', event: 'finish' },
    ],
    config: {
      doneStates: ['completed'],
      ...(opts.explicit ? { holdStates: ['waiting_part'] } : {}),
    },
  };
}

describe('挂起态由流程派生（不再硬编码 paused/suspended）', () => {
  it('① holdStates 派生：pause_sla 边的目标态即挂起态（客户自定义名也认得）', () => {
    const def = customHoldDef() as never;
    expect(holdStates(def)).toEqual(['waiting_part']);
    // 活跃态 = 全态 − 完成 − 终态 − 挂起
    expect(activeStates(def).sort()).toEqual(['draft', 'handling']);
  });

  it('② 显式声明优先：def.config.holdStates 覆盖派生（配置台可强制口径）', () => {
    const def = customHoldDef({ explicit: true }) as never;
    expect(holdStates(def)).toEqual(['waiting_part']);
  });

  it('③ 存量兼容：RICH 模板的 paused/suspended 仍是挂起态（行为零变化）', async () => {
    const { RICH_WORK_ORDER_DEF } = await import('../engine/stateMachine.js');
    const hs = holdStates(RICH_WORK_ORDER_DEF as never);
    expect(hs).toContain('paused');
    expect(hs).toContain('suspended');
  });

  it('④ 客户自定义挂起态：人离场 → worker.load 必须回收（硬编码时代不减，派单均衡长期虚高）', async () => {
    await seedDef(customHoldDef());
    await seedWorker('w-a', 3);
    await seedOrder('WO-hold-1', 'handling', 'w-a');

    await inTx(async () => {
      await move('WO-hold-1', 'waiting_part');

      const w = await rows(`SELECT load FROM worker WHERE id='w-a'`);
      expect(w[0].load).toBe(2); // 3 → 2：挂起即离场，在身单 -1（硬编码时代 = 3）
    });
  });

  it('⑤ 恢复：从自定义挂起态回到活跃态 → load 重新计入（对称，不重复累加）', async () => {
    await seedDef(customHoldDef());
    await seedWorker('w-a', 2);
    await seedOrder('WO-hold-2', 'waiting_part', 'w-a');

    await inTx(async () => {
      await move('WO-hold-2', 'handling');

      const w = await rows(`SELECT load FROM worker WHERE id='w-a'`);
      expect(w[0].load).toBe(3); // 2 → 3：回到在身（挂起期间不重复计）
    });
  });

  it('⑥ 挂起时 SLA 暂停照常执行（自定义态名不副作用丢失）', async () => {
    await seedDef(customHoldDef());
    await seedWorker('w-a', 0);
    await seedOrder('WO-hold-3', 'handling', 'w-a');

    await inTx(async () => {
      await move('WO-hold-3', 'waiting_part');
      const wo = await rows(`SELECT status, sla_paused_at FROM work_orders WHERE id='WO-hold-3'`);
      expect(wo[0].status).toBe('waiting_part');
      expect(wo[0].sla_paused_at).not.toBeNull();
    });
  });
});
