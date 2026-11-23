// 工作台统一统计真库测试：sum(buckets)=total、timeout=列表、today=列表、bucket 下钻一致。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { workbenchStats } from '../repo/workbenchStats.js';
import { RICH_WORK_ORDER_DEF } from '../engine/stateMachine.js';
import { list } from '../repo/ticket.js';

let db: PGlite;
const T = 't-workbench';
const asClient = () => db as unknown as PoolClient;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE workflow_def (
      tenant_id text NOT NULL, entity_type text NOT NULL, def jsonb NOT NULL,
      version int NOT NULL DEFAULT 1, PRIMARY KEY (tenant_id, entity_type)
    );
    CREATE TABLE workflow_def_history (
      tenant_id text NOT NULL, entity_type text NOT NULL, version int NOT NULL,
      def jsonb NOT NULL, PRIMARY KEY (tenant_id, entity_type, version)
    );
    CREATE TABLE worker (
      id text PRIMARY KEY, tenant_id text NOT NULL, name text, department_id uuid,
      skill_tags text[] NOT NULL DEFAULT '{}', load int NOT NULL DEFAULT 0,
      active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE dept (
      id uuid PRIMARY KEY, tenant_id text NOT NULL, name text, is_default boolean NOT NULL DEFAULT false
    );
    INSERT INTO dept (id, tenant_id, name, is_default)
      VALUES ('00000000-0000-4000-8000-000000000001', '${T}', '总务科', true);
    CREATE TABLE work_orders (
      id text PRIMARY KEY, tenant_id text NOT NULL, order_no text, business_type text NOT NULL DEFAULT 'repair',
      catalog text, priority text NOT NULL DEFAULT 'normal', location text, title text,
      description text, contact text, status text NOT NULL DEFAULT 'draft', assignee_id text,
      department_id uuid, department_source text, auto_flow boolean NOT NULL DEFAULT false,
      assets jsonb NOT NULL DEFAULT '[]'::jsonb, ext jsonb NOT NULL DEFAULT '{}'::jsonb,
      sla_due_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
      satisfaction_score smallint,
      def_version int NOT NULL DEFAULT 0
    );
  `);
  await db.query(
    `INSERT INTO workflow_def (tenant_id, entity_type, def, version) VALUES ($1,'work_order',$2::jsonb,1)`,
    [T, JSON.stringify(RICH_WORK_ORDER_DEF)],
  );
  await db.query(
    `INSERT INTO work_orders (id, tenant_id, order_no, status, department_id, auto_flow, sla_due_at, satisfaction_score, created_at, completed_at) VALUES
      ('wo-pending',$1,'P','assigned','00000000-0000-4000-8000-000000000001',true,now()-interval '1 hour',NULL,now(),NULL),
      ('wo-active',$1,'A','processing','00000000-0000-4000-8000-000000000001',true,now()-interval '2 hour',NULL,now(),NULL),
      ('wo-done',$1,'D','completed','00000000-0000-4000-8000-000000000001',true,NULL,NULL,now(),now()),
      ('wo-eval',$1,'E','evaluated','00000000-0000-4000-8000-000000000001',false,NULL,NULL,now(),now()),
      ('wo-cancel',$1,'C','cancelled','00000000-0000-4000-8000-000000000001',false,NULL,NULL,now(),NULL)`,
    [T],
  );
});

afterAll(async () => {
  await db.close();
});

describe('workbenchStats', () => {
  it('sum(buckets)=total，且 timeout/today 与 list 同口径', async () => {
    const stats = await workbenchStats(asClient(), T, {});
    const sum = Object.values(stats.buckets).reduce((a, b) => a + b, 0);
    expect(sum).toBe(stats.total);
    expect(stats.buckets.pending).toBe(1);
    expect(stats.buckets.active).toBe(1);
    expect(stats.buckets.done).toBe(2);
    expect(stats.buckets.cancelled).toBe(1);
    expect(stats.timeout).toBe(2);
    expect(stats.today_new).toBe(5);
    expect(stats.today_done).toBe(2);
    expect(stats.data_quality.evaluated_missing_score).toBe(1);

    const timeoutList = await list(asClient(), T, { timeoutOnly: true, limit: 1, offset: 0 } as never);
    expect(stats.timeout).toBe(timeoutList.total);
    const todayList = await list(asClient(), T, { todayOnly: true, limit: 1, offset: 0 } as never);
    expect(stats.today_new).toBe(todayList.total);
  });

  it('bucket=other 下钻与 stats.buckets.other 一致', async () => {
    const stats = await workbenchStats(asClient(), T, {});
    expect(stats.buckets.other).toBe(0);
    const other = await list(asClient(), T, { status: '__none__', limit: 1, offset: 0 } as never);
    expect(other.total).toBe(0);
  });

  it('部门筛选同时作用于统计和列表', async () => {
    const stats = await workbenchStats(asClient(), T, {
      departmentId: '00000000-0000-4000-8000-000000000001',
    });
    expect(stats.total).toBe(5);
    const empty = await workbenchStats(asClient(), T, {
      departmentId: '00000000-0000-4000-8000-000000000009',
    });
    expect(empty.total).toBe(0);
  });
});
