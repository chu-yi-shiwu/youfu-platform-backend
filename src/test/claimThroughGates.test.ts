/**
 * 「抢单走客户配的门禁」产品属性测试 —— 真库 + 真 transition() 主通道
 *
 * 【为什么有这份测试】
 *   抢单端点（POST /open/work_order/:id/claim）与此前的自动派单同病：旁路手写
 *   UPDATE，不调 transition()。客户配在认领边（claim 事件边）上的四样东西，
 *   只有 allowedRoles 被 claimAllowedRoles 消费，其余全部落空：
 *     ① requiredFields —— 不校验；
 *     ② sideEffects（pause_sla 等）—— 不执行；
 *     ③ 自动审核规则（挂在 transition() 尾部）—— 不触发；
 *     ④ 目标态 —— 硬编码 'assigned'：客户把认领边指向别的态（或根本不要 assigned），
 *        单子被写进客户流程里不存在的状态 = 失管单（isKnownState 之后全堵）。
 *   另：allowedPerms 从未被消费（claimAllowedRoles 只看角色）。
 *   本文件守护的产品事实：**客户配的规矩，人走的每道门也都得守**。
 *
 * 【设计要点（鉴别力）】
 *   自建租户流程（不依赖 RICH 模板，排除机制态干扰）；池态（claim_hall/
 *   pending_dispatch）的单子直接播种，焦点在「认领这一刻守不守规矩」。
 *   每条期望都读真库落值，不可能蒙对。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PoolClient } from 'pg';

const T = 't-claim-gates';

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
import { claimWorkOrder } from '../services/claimWorkOrder.js';

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

/** 直插 live workflow_def（等价于「客户配好且已审批生效」的流程）。 */
async function seedDef(def: unknown) {
  await db().query(
    `INSERT INTO workflow_def (tenant_id, entity_type, def, version)
     VALUES ($1, 'work_order', $2::jsonb, 1)
     ON CONFLICT (tenant_id, entity_type) DO UPDATE SET def = EXCLUDED.def, version = workflow_def.version + 1`,
    [T, JSON.stringify(def)],
  );
}

async function seedWorkers() {
  await db().query(
    `INSERT INTO worker (id, tenant_id, name, skill_tags, load, active) VALUES
     ('w-a', $1, '工人甲', ARRAY['plumbing'], 0, true)`,
    [T],
  );
}

/** 池态单子：直接落到 claim_hall / pending_dispatch（焦点在认领这一刻）。 */
async function seedPoolOrder(id: string, status: 'claim_hall' | 'pending_dispatch') {
  await db().query(
    `INSERT INTO work_orders (id, tenant_id, business_type, priority, status, order_no)
     VALUES ($1, $2, 'repair', 'normal', $3, $4)`,
    [id, T, status, `WO_${id}`],
  );
}

function rawClient() {
  return { query: (sql: string, params: unknown[] = []) => db().query(sql, params) } as any;
}

/** PGlite 单连接：SAVEPOINT 只在事务块内合法（生产里由 withTenantClient 提供事务）。 */
async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  await db().query('BEGIN');
  try {
    return await fn();
  } finally {
    await db().query('ROLLBACK');
  }
}

/** 认领动作 + 断言必须在同一事务内（PGlite 单连接，事务外断言会被 ROLLBACK 回滚）。 */
const claim = (orderId: string, opts: { role?: string; workerId?: string; fields?: Record<string, unknown> } = {}) =>
  claimWorkOrder(rawClient() as PoolClient, T, {
    orderId,
    workerId: opts.workerId ?? 'w-a',
    role: opts.role ?? 'worker',
    fields: opts.fields,
  });

/** 包一层事务跑「认领 + 断言」整段。 */
const claimInTx = (fn: () => Promise<void>) => inTx(fn);

/** 标准池态流程：claim_hall --claim--> assigned（认领边可带门禁/副作用）。 */
function poolDef(claimEdge: Record<string, unknown> = {}) {
  return {
    initial: 'draft',
    states: ['draft', 'claim_hall', 'assigned', 'processing', 'completed'],
    transitions: [
      { from: 'draft', to: 'claim_hall', event: 'submit' },
      { from: 'claim_hall', to: 'assigned', event: 'claim', ...claimEdge },
      { from: 'assigned', to: 'processing', event: 'start' },
      { from: 'processing', to: 'completed', event: 'complete' },
    ],
    config: { doneStates: ['completed'] },
  };
}

describe('抢单走客户配的门禁 —— 人走的每道门也都得守客户规矩（产品属性）', () => {
  it('① 认领边的 sideEffects 必须执行：客户配 pause_sla，抢单后 SLA 暂停落库', async () => {
    await seedDef(poolDef({ sideEffects: ['pause_sla'] }));
    await seedWorkers();
    await seedPoolOrder('WO-claim-1', 'claim_hall');

    await claimInTx(async () => {
      await claim('WO-claim-1');

      const wo = await rows(`SELECT status, sla_paused_at, auto_flow, assignee_id FROM work_orders WHERE id='WO-claim-1'`);
      expect(wo[0].status).toBe('assigned');
      expect(wo[0].sla_paused_at).not.toBeNull(); // 旁路时代 = null（RED 点）
      expect(wo[0].assignee_id).toBe('w-a');
      expect(wo[0].auto_flow).toBe(false); // 人工认领，不许被打成自动
    });
  });

  it('② 认领边的 requiredFields 必须校验：缺字段 422，带字段放行', async () => {
    await seedDef(poolDef({ requiredFields: ['claim_note'] }));
    await seedWorkers();
    await seedPoolOrder('WO-claim-2', 'claim_hall');

    await claimInTx(async () => {
      // 工人端没带认领备注 → 422（旁路时代直接成功 = RED 点）
      await expect(claim('WO-claim-2')).rejects.toThrow(/missing required fields/);

      // 带上客户要的字段 → 认领成功
      await claim('WO-claim-2', { fields: { claim_note: '接单备注' } });
      const wo = await rows(`SELECT status FROM work_orders WHERE id='WO-claim-2'`);
      expect(wo[0].status).toBe('assigned');
    });
  });

  it('③ 自动审核规则必须被抢单触发：认领落 assigned → 规则自动推到 review_passed', async () => {
    await seedDef({
      initial: 'draft',
      states: ['draft', 'claim_hall', 'assigned', 'review_passed', 'completed'],
      transitions: [
        { from: 'draft', to: 'claim_hall', event: 'submit' },
        { from: 'claim_hall', to: 'assigned', event: 'claim' },
        { from: 'assigned', to: 'review_passed', event: 'approve' },
        { from: 'review_passed', to: 'completed', event: 'complete' },
      ],
      config: { doneStates: ['completed'] },
    });
    // 客户在「自动审核」页配的规则：进入已分派就自动审过
    await db().query(
      `INSERT INTO workflow_auto_rule (tenant_id, from_state, event, enabled, note)
       VALUES ($1, 'assigned', 'approve', true, '测试：认领后自动审过')`,
      [T],
    );
    await seedWorkers();
    await seedPoolOrder('WO-claim-3', 'claim_hall');

    await claimInTx(async () => {
      await claim('WO-claim-3');

      const wo = await rows(`SELECT status FROM work_orders WHERE id='WO-claim-3'`);
      expect(wo[0].status).toBe('review_passed'); // 旁路时代 = 'assigned'（RED 点）
      const ev = await rows(
        `SELECT type, actor FROM ticket_event WHERE work_order_id='WO-claim-3' AND type='auto_rule'`,
      );
      expect(ev).toHaveLength(1);
      expect(ev[0].actor).toBe('system:auto');
    });
  });

  it('④ 反向守护：认领边 allowedRoles=["admin"] → 工人认领 403（人类门禁没被拆）', async () => {
    await seedDef(poolDef({ allowedRoles: ['admin'] }));
    await seedWorkers();
    await seedPoolOrder('WO-claim-4', 'claim_hall');

    await claimInTx(async () => {
      await expect(claim('WO-claim-4', { role: 'worker' })).rejects.toThrow(/not allowed/);
      // 管理员走同一条边 → 放行
      await claim('WO-claim-4', { role: 'admin' });
      const wo = await rows(`SELECT status FROM work_orders WHERE id='WO-claim-4'`);
      expect(wo[0].status).toBe('assigned');
    });
  });

  it('⑤ 目标态从客户的认领边派生：客户指向 handling 就落 handling，绝不硬编码 assigned', async () => {
    await seedDef({
      initial: 'draft',
      states: ['draft', 'claim_hall', 'handling', 'completed'],
      transitions: [
        { from: 'draft', to: 'claim_hall', event: 'submit' },
        { from: 'claim_hall', to: 'handling', event: 'claim' },
        { from: 'handling', to: 'completed', event: 'complete' },
      ],
      config: { doneStates: ['completed'] },
    });
    await seedWorkers();
    await seedPoolOrder('WO-claim-5', 'claim_hall');

    await claimInTx(async () => {
      await claim('WO-claim-5');

      const wo = await rows(`SELECT status FROM work_orders WHERE id='WO-claim-5'`);
      expect(wo[0].status).toBe('handling'); // 旁路时代硬写 'assigned'（RED 点）
    });
  });

  it('⑥ 待派单池认领：注入的 claim 边生效，工人可认领 pending_dispatch 单，load 恰好 +1', async () => {
    await seedDef({
      initial: 'draft',
      states: ['draft', 'pending_dispatch', 'assigned', 'completed'],
      transitions: [
        { from: 'draft', to: 'pending_dispatch', event: 'submit' },
        // RICH 同构：待派单池只有 admin+dispatch.override 的 dispatch 边，无 claim 边
        { from: 'pending_dispatch', to: 'assigned', event: 'dispatch', allowedRoles: ['admin'], allowedPerms: ['dispatch.override'], requiredFields: ['assignee'] },
        { from: 'assigned', to: 'completed', event: 'complete' },
      ],
      config: { doneStates: ['completed'] },
    });
    await seedWorkers();
    await seedPoolOrder('WO-claim-6', 'pending_dispatch');

    await claimInTx(async () => {
      await claim('WO-claim-6');

      const wo = await rows(`SELECT status, assignee_id FROM work_orders WHERE id='WO-claim-6'`);
      expect(wo[0].status).toBe('assigned');
      expect(wo[0].assignee_id).toBe('w-a');
      const w = await rows(`SELECT load FROM worker WHERE id='w-a'`);
      expect(w[0].load).toBe(1); // 防双计：transition 净结算替代手工 +1
    });
  });

  it('⑦ 事件流类型不断：ticket_event type=claim 保留（存量消费方照旧）', async () => {
    await seedDef(poolDef());
    await seedWorkers();
    await seedPoolOrder('WO-claim-7', 'claim_hall');

    await claimInTx(async () => {
      await claim('WO-claim-7');

      const ev = await rows(
        `SELECT type, from_status, to_status, actor FROM ticket_event WHERE work_order_id='WO-claim-7'`,
      );
      const claimEv = ev.find((e) => e.type === 'claim');
      expect(claimEv).toBeDefined();
      expect(claimEv.from_status).toBe('claim_hall');
      expect(claimEv.to_status).toBe('assigned');
    });
  });

  it('⑧ 守护：抢单通知照旧落库（不因换通道丢通知）', async () => {
    await seedDef(poolDef());
    await seedWorkers();
    await seedPoolOrder('WO-claim-8', 'claim_hall');

    await claimInTx(async () => {
      await claim('WO-claim-8');

      const notes = await rows(
        `SELECT recipient, type FROM notification WHERE work_order_id='WO-claim-8' AND type='claim'`,
      );
      expect(notes).toHaveLength(1);
      expect(notes[0].recipient).toBe('w-a');
    });
  });
});
