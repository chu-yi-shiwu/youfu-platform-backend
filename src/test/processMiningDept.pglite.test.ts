// 过程挖掘部门过滤的数据库回归：
//   部门过滤必须同时作用于事件主查询、共振命中数和自动派发计数，
//   否则会出现"轨迹按部门、命中数仍按全租户"的假口径。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { processMining } from '../repo/processMining.js';

let db: PGlite;
const T = 't-mining-dept';
const DEPT_A = '00000000-0000-4000-8000-00000000001a';
const DEPT_B = '00000000-0000-4000-8000-00000000001b';
const asClient = () => db as unknown as PoolClient;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE domain_event (
      tenant_id text NOT NULL,
      entity_type text NOT NULL,
      entity_id text,
      type text NOT NULL,
      actor text,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE work_orders (
      id text PRIMARY KEY,
      tenant_id text NOT NULL,
      department_id uuid,
      auto_flow boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE ticket_event (
      tenant_id text NOT NULL,
      work_order_id text NOT NULL,
      to_status text NOT NULL,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE workflow_def (
      tenant_id text NOT NULL,
      entity_type text NOT NULL,
      def jsonb NOT NULL,
      version int NOT NULL DEFAULT 1
    );
    CREATE TABLE model_state (
      tenant_id text NOT NULL,
      model_key text NOT NULL,
      version int NOT NULL
    );
  `);
  await db.query(
    `INSERT INTO work_orders (id, tenant_id, department_id, auto_flow, created_at) VALUES
       ('wo-a',$1,$2,true,now()-interval '60 minutes'),
       ('wo-b',$1,$3,true,now()-interval '60 minutes')`,
    [T, DEPT_A, DEPT_B],
  );
  await db.query(
    `INSERT INTO domain_event (tenant_id, entity_type, entity_id, type, actor, created_at) VALUES
       ($1,'work_order','wo-a','create','u1',now()-interval '60 minutes'),
       ($1,'work_order','wo-a','dispatch','u1',now()-interval '50 minutes'),
       ($1,'work_order','wo-a','start','u2',now()-interval '40 minutes'),
       ($1,'work_order','wo-a','complete','u2',now()-interval '30 minutes'),
       ($1,'work_order','wo-b','create','u1',now()-interval '60 minutes'),
       ($1,'work_order','wo-b','dispatch','u1',now()-interval '50 minutes'),
       ($1,'work_order','wo-b','complete','u1',now()-interval '30 minutes')`,
    [T],
  );
  await db.query(
    `INSERT INTO ticket_event (tenant_id, work_order_id, to_status, created_at) VALUES
       ($1,'wo-a','completed',now()-interval '30 minutes'),
       ($1,'wo-b','completed',now()-interval '30 minutes')`,
    [T],
  );
  await db.query(
    `INSERT INTO model_state (tenant_id, model_key, version) VALUES ($1,'dispatch_score',3)`,
    [T],
  );
});

afterAll(async () => {
  await db.close();
});

describe('processMining department scope', () => {
  it('无部门过滤时回放全部 case', async () => {
    const out = await processMining(asClient(), T, { entityType: 'work_order', days: 30 });
    expect(out.overview.case_count).toBe(2);
    expect(out.overview.event_count).toBe(7);
    expect(out.resonance.auto_dispatched_in_scope).toBe(2);
    expect(out.resonance.learning_hits_in_scope).toBe(2);
    expect(out.scope.department_id).toBeNull();
    expect(out.scope.department_unassigned).toBe(false);
  });

  it('按 A 部门过滤：事件、自动派发、学习命中都只剩 A', async () => {
    const out = await processMining(asClient(), T, {
      entityType: 'work_order',
      days: 30,
      departmentId: DEPT_A,
    });
    expect(out.overview.case_count).toBe(1);
    expect(out.overview.event_count).toBe(4);
    expect(out.resonance.auto_dispatched_in_scope).toBe(1);
    expect(out.resonance.learning_hits_in_scope).toBe(1);
    expect(out.scope.department_id).toBe(DEPT_A);
  });

  it('按 B 部门过滤不会混入 A 的事件', async () => {
    const out = await processMining(asClient(), T, {
      entityType: 'work_order',
      days: 30,
      departmentId: DEPT_B,
    });
    expect(out.overview.case_count).toBe(1);
    expect(out.overview.event_count).toBe(3);
    expect(out.resonance.auto_dispatched_in_scope).toBe(1);
    expect(out.resonance.learning_hits_in_scope).toBe(1);
  });

  it('未分配部门过滤返回空，而不是退化成全租户', async () => {
    const out = await processMining(asClient(), T, {
      entityType: 'work_order',
      days: 30,
      departmentUnassigned: true,
    });
    expect(out.overview.case_count).toBe(0);
    expect(out.overview.event_count).toBe(0);
    expect(out.resonance.auto_dispatched_in_scope).toBe(0);
    expect(out.scope.department_unassigned).toBe(true);
  });
});
