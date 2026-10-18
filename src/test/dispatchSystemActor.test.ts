/**
 * 「系统派单不被人类角色门禁误伤」产品属性测试 —— F4 深修引入的新炸点
 *
 * 【为什么有这份测试】
 *   F4（2026-10-19）把自动派单从旁路并入 transition() 主通道后，客户配在派单边上的
 *   sideEffects/自动审核/必填都开始生效——但 transition() 的角色/权限门禁
 *   （allowedRoles/allowedPerms）也一并生效了，而系统 actor 没有角色：
 *     isTransitionAllowed(tdef, { role: undefined }) → 白名单无空串 → false → 403
 *
 *   生产实证（2026-10-19 06:00 只读取库）：**demo_tenant（开通即用样板租户）就踩中**——
 *     其 def 无 autoRoutes，resolveDispatchTarget 落②=初态首条非终态转移
 *     = submit→pending_dispatch，而该边 allowedRoles=['admin','operator']。
 *     旧旁路不查门禁所以能跑；F4 后 demo_tenant 一建单，自动派单必 403。
 *     危害面：每个新客户开通后第一张单就撞上（demo 是开通模板）。
 *
 *   产品论证（为什么系统必须跳过这道门）：
 *     角色门禁的立法意图是约束「人」——谁能点这个按钮。系统不是人，无角色可谈。
 *     客户在同一份 def 里同时配了 autoRoutes（=显式授权系统沿这条路自动派单）
 *     与 allowedRoles（=约束人类操作者）——两者不矛盾：前者授权系统，后者约束人。
 *     与 tryAutoAdvance 的 systemAuto 完全同源头：规则须持 workflow.approve 的
 *     把关人显式启用，系统执行跳过人类角色门禁；autoRoutes 同理须客户显式配置。
 *     若系统也守 allowedRoles，则任何配了角色门禁的派单边 = 自动派单永远崩，
 *     客户的两个配置互相抵消——这不是从严，是让配置变得无意义。
 *
 * 【守护口径】系统派单守：拓扑 / requiredFields / sideEffects / 自动审核（一个不跳）；
 *   系统派单跳过：allowedRoles / allowedPerms（人类门禁，系统非人类）。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const T = 't-dispatch-sysactor';

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

import { autoDispatchAfterCreate } from '../routes/workOrder.js';

/** 与 dispatchThroughGates.test.ts 同源的真 DDL 子集（001/004/008/019/020/022/028/074/094/065）。 */
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
CREATE TABLE account_user (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  text NOT NULL,
  username   text NOT NULL,
  role       text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, username)
);
-- 046 role_permission（transition() 惰性查权限点：allowedPerms 边必查，缺表会让③的 403 路径崩成 500）
CREATE TABLE role_permission (
  tenant_id  text NOT NULL,
  role       text NOT NULL CHECK (role IN ('admin','operator','dispatcher','worker')),
  perm       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, role, perm)
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
    'dispatch_rule', 'ticket_event', 'notification', 'work_orders', 'worker',
    'workflow_def', 'workflow_auto_rule', 'account_user', 'ai_shadow_suggestions',
    'role_permission',
  ]) {
    await db().query(`DELETE FROM ${t}`);
  }
});

const rows = async (sql: string, p: unknown[] = []) => (await db().query(sql, p)).rows;

/**
 * demo_tenant 生产 def 逐字复刻（2026-10-19 06:00 只读导出，开通即用样板）：
 *   无 autoRoutes → 派单落②= submit→pending_dispatch；该边 allowedRoles=['admin','operator']。
 *   这就是「F4 后新客户第一张单必 403」的生产实证形态。
 */
async function seedDemoTenantDef() {
  await db().query(
    `INSERT INTO workflow_def (tenant_id, entity_type, def, version)
     VALUES ($1, 'work_order', $2::jsonb, 1)
     ON CONFLICT (tenant_id, entity_type) DO UPDATE SET def = EXCLUDED.def, version = workflow_def.version + 1`,
    [T, JSON.stringify({
      config: { name: '标准报修工单', fields: [{ key: 'priority', type: 'select', label: '优先级', options: ['normal', 'urgent', 'emergency'] }, { key: 'location', type: 'text', label: '位置', required: true }] },
      states: ['draft', 'pending_dispatch', 'assigned', 'arrived', 'processing', 'pending_review', 'completed', 'cancelled'],
      initial: 'draft',
      transitions: [
        { to: 'pending_dispatch', from: 'draft', event: 'submit', allowedRoles: ['admin', 'operator'] },
        { to: 'assigned', from: 'pending_dispatch', event: 'assign', allowedRoles: ['admin'] },
        { to: 'processing', from: 'assigned', event: 'accept', allowedRoles: ['worker'] },
        { to: 'pending_review', from: 'processing', event: 'resolve', allowedRoles: ['worker'], requiredFields: ['remark'] },
        { to: 'completed', from: 'pending_review', event: 'close', allowedRoles: ['admin', 'operator'] },
        { to: 'cancelled', from: 'draft', event: 'cancel', allowedPerms: ['ticket.manage'], allowedRoles: ['admin', 'operator'] },
        { to: 'arrived', from: 'assigned', event: 'arrive', allowedRoles: ['admin', 'worker'] },
        { to: 'processing', from: 'arrived', event: 'start', allowedRoles: ['admin', 'worker'] },
        { to: 'cancelled', from: 'arrived', event: 'cancel', allowedPerms: ['ticket.manage'], allowedRoles: ['admin'], requiredFields: ['cancel_reason'] },
      ],
    })],
  );
}

/** 显式配 autoRoutes 且派单边带 allowedPerms 的租户（客户两个配置并存的形态）。 */
async function seedGatedAutoRouteDef() {
  await db().query(
    `INSERT INTO workflow_def (tenant_id, entity_type, def, version)
     VALUES ($1, 'work_order', $2::jsonb, 1)
     ON CONFLICT (tenant_id, entity_type) DO UPDATE SET def = EXCLUDED.def, version = workflow_def.version + 1`,
    [T, JSON.stringify({
      initial: 'draft',
      states: ['draft', 'assigned', 'processing', 'completed'],
      transitions: [
        { from: 'draft', to: 'assigned', event: 'assign', allowedRoles: ['admin'], allowedPerms: ['dispatch.override'] },
        { from: 'assigned', to: 'processing', event: 'start' },
        { from: 'processing', to: 'completed', event: 'complete' },
      ],
      config: { autoRoutes: { draft: { to: 'assigned', strategy: 'least_load' } } },
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

/** PGlite 单连接：SAVEPOINT 只在事务块内合法（与 dispatchThroughGates.test.ts 同口径）。 */
async function inTx<T>(fn: () => Promise<T>): Promise<T> {
  await db().query('BEGIN');
  try {
    return await fn();
  } finally {
    await db().query('ROLLBACK');
  }
}

describe('系统派单不被人类角色门禁误伤（F4 深修炸点：demo_tenant 一建单即 403）', () => {
  it('① demo_tenant 形态：无 autoRoutes + 派单边带 allowedRoles → 系统派单成功落 pending_dispatch', async () => {
    await seedDemoTenantDef();
    await seedWorkers();
    await seedOrder('WO-sys-1');

    await inTx(async () => {
      const r = await autoDispatchAfterCreate(rawClient(), T, { id: 'WO-sys-1', order_no: 'WO_sys_1' }, {
        business_type: 'repair',
        priority: 'normal',
      });
      // 系统派单必须成功：落②的目标态 + 显式 auto_flow 口径
      expect(r.autoFlow).toBe(true);
      expect(r.assignee).toBe('w-a');

      const wo = await rows(`SELECT status, auto_flow, assignee_id FROM work_orders WHERE id='WO-sys-1'`);
      expect(wo[0].status).toBe('pending_dispatch');
      expect(wo[0].auto_flow).toBe(true);
      expect(wo[0].assignee_id).toBe('w-a');
      // 事件流：assign 类型保住（publicReport 平均响应时长按它聚合），actor=auto_dispatch
      const ev = await rows(`SELECT type, actor FROM ticket_event WHERE work_order_id='WO-sys-1' AND type='assign'`);
      expect(ev).toHaveLength(1);
      expect(ev[0].actor).toBe('auto_dispatch');
    });
  });

  it('② 客户显式配 autoRoutes + 派单边带 allowedRoles/allowedPerms → 两个配置并存，系统派单仍成功', async () => {
    await seedGatedAutoRouteDef();
    await seedWorkers();
    await seedOrder('WO-sys-2');

    await inTx(async () => {
      const r = await autoDispatchAfterCreate(rawClient(), T, { id: 'WO-sys-2', order_no: 'WO_sys_2' }, {
        business_type: 'repair',
        priority: 'normal',
      });
      expect(r.autoFlow).toBe(true);

      const wo = await rows(`SELECT status, auto_flow FROM work_orders WHERE id='WO-sys-2'`);
      expect(wo[0].status).toBe('assigned');
      expect(wo[0].auto_flow).toBe(true);
    });
  });

  it('③ 反向守护：人类操作者仍被角色门禁拦——同一条边，人（worker）不能派单', async () => {
    await seedGatedAutoRouteDef();
    // 证明门禁没有被人为拆掉：worker 角色走同一条 assign 边必须 403。
    //   系统跳过门禁 ≠ 门禁失效——门禁对人类的约束原样保留。
    const { transition } = await import('../repo/ticket.js');
    await seedWorkers();
    await seedOrder('WO-sys-3');

    await inTx(async () => {
      await expect(
        transition(rawClient(), T, 'WO-sys-3', 'assigned', {
          actor: 'worker-x',
          role: 'worker',
          fields: { assignee: 'w-a' },
        }),
      ).rejects.toThrow();
    });
  });
});
