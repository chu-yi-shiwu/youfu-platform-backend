// 工单阶段时长 P50/P90 的数据库回归：
//   - 分位值只统计两个里程碑都存在且顺序合法的单；
//   - 部门过滤与工单列表/工作台共用 buildWorkOrderWhere；
//   - 空部门返回 null 而不是 0，避免把"没有样本"伪装成"时长为 0"。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { clearStatsCache, workOrderDurations } from '../repo/stats.js';

let db: PGlite;
const T = 't-durations';
const DEPT_A = '00000000-0000-4000-8000-00000000000a';
const DEPT_B = '00000000-0000-4000-8000-00000000000b';
const DEPT_EMPTY = '00000000-0000-4000-8000-00000000000c';
const asClient = () => db as unknown as PoolClient;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE work_orders (
      id text PRIMARY KEY,
      tenant_id text NOT NULL,
      status text NOT NULL DEFAULT 'draft',
      department_id uuid,
      created_at timestamptz NOT NULL,
      assigned_at timestamptz,
      arrived_at timestamptz,
      started_at timestamptz,
      completed_at timestamptz
    );
  `);
  await db.query(
    `INSERT INTO work_orders
       (id, tenant_id, status, department_id, created_at, assigned_at, arrived_at, started_at, completed_at)
     VALUES
       ('wo-a1',$1,'completed',$2,now()-interval '60 minutes',now()-interval '50 minutes',now()-interval '40 minutes',now()-interval '30 minutes',now()-interval '0 minutes'),
       ('wo-a2',$1,'completed',$2,now()-interval '120 minutes',now()-interval '100 minutes',now()-interval '80 minutes',now()-interval '70 minutes',now()-interval '20 minutes'),
       ('wo-a3',$1,'completed',$2,now()-interval '180 minutes',now()-interval '150 minutes',now()-interval '120 minutes',now()-interval '110 minutes',now()-interval '50 minutes'),
       ('wo-a4',$1,'completed',$2,now()-interval '240 minutes',now()-interval '200 minutes',now()-interval '160 minutes',now()-interval '150 minutes',now()-interval '80 minutes'),
       ('wo-a5',$1,'completed',$2,now()-interval '600 minutes',now()-interval '500 minutes',now()-interval '400 minutes',now()-interval '380 minutes',now()-interval '200 minutes'),
       ('wo-a6',$1,'cancelled',$2,now()-interval '30 minutes',NULL,NULL,NULL,NULL),
       ('wo-b1',$1,'completed',$3,now()-interval '60 minutes',now()-interval '50 minutes',now()-interval '40 minutes',now()-interval '30 minutes',now()-interval '0 minutes'),
       ('wo-u1',$1,'completed',NULL,now()-interval '60 minutes',now()-interval '50 minutes',now()-interval '40 minutes',now()-interval '30 minutes',now()-interval '0 minutes')`,
    [T, DEPT_A, DEPT_B],
  );
});

beforeEach(() => {
  clearStatsCache();
});

afterAll(async () => {
  await db.close();
});

describe('workOrderDurations', () => {
  it('按部门计算 P50/P90，缺里程碑的单不计入对应分位值', async () => {
    const out = await workOrderDurations(asClient(), T, { departmentId: DEPT_A, days: 30 });
    expect(out.sample).toEqual({
      total: 6,
      completed: 5,
      with_assigned: 5,
      with_arrived: 5,
      with_started: 5,
    });
    // dispatch: 10/20/30/40/100 → p50=30, p90=76
    expect(out.dispatch).toEqual({ p50: 30, p90: 76, count: 5 });
    // arrive: 20/40/60/80/200 → p50=60, p90=152
    expect(out.arrive).toEqual({ p50: 60, p90: 152, count: 5 });
    // start: 10/10/10/10/20 → p50=10, p90=16
    expect(out.start).toEqual({ p50: 10, p90: 16, count: 5 });
    // handle: 30/50/60/70/180 → p50=60, p90=136
    expect(out.handle).toEqual({ p50: 60, p90: 136, count: 5 });
    // total: 60/100/130/160/400 → p50=130, p90=304
    expect(out.total).toEqual({ p50: 130, p90: 304, count: 5 });
  });

  it('部门互斥：B 部门的单不会进入 A 部门样本', async () => {
    const b = await workOrderDurations(asClient(), T, { departmentId: DEPT_B, days: 30 });
    expect(b.sample.total).toBe(1);
    expect(b.dispatch).toEqual({ p50: 10, p90: 10, count: 1 });
    expect(b.total).toEqual({ p50: 60, p90: 60, count: 1 });
  });

  it('未分配部门单独统计，不与具体部门混算', async () => {
    const unassigned = await workOrderDurations(asClient(), T, { departmentUnassigned: true, days: 30 });
    expect(unassigned.sample.total).toBe(1);
    expect(unassigned.total).toEqual({ p50: 60, p90: 60, count: 1 });
  });

  it('空部门返回 null 分位值 + count=0，不能伪装成 0 分钟', async () => {
    const empty = await workOrderDurations(asClient(), T, { departmentId: DEPT_EMPTY, days: 30 });
    expect(empty.sample.total).toBe(0);
    expect(empty.dispatch).toEqual({ p50: null, p90: null, count: 0 });
    expect(empty.total).toEqual({ p50: null, p90: null, count: 0 });
  });
});
