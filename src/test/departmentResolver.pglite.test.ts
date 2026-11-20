// 111 + repo/departmentResolver 真库测试：
//   - 显式覆盖
//   - 路由规则优先于默认部门
//   - 规则按 priority
//   - 无规则落默认部门
//   - 默认部门缺失时明确 422（不静默 500）
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { resolveDepartment } from '../repo/departmentResolver.js';

let db: PGlite;
const T = 't-dept';
const DEFAULT_DEPT = '00000000-0000-4000-8000-000000000001';
const EQUIP_DEPT = '00000000-0000-4000-8000-000000000002';

const asClient = () => db as unknown as PoolClient;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE youfu_app;
    CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS text
      LANGUAGE sql STABLE AS $$ SELECT COALESCE(current_setting('app.tenant_id', true), '') $$;
    CREATE TABLE dept (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id text NOT NULL,
      name text NOT NULL,
      code text,
      is_default boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE worker (
      id text PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL, department text
    );
    CREATE TABLE work_orders (
      id text PRIMARY KEY, tenant_id text NOT NULL, department text,
      status text NOT NULL DEFAULT 'draft'
    );
    CREATE TABLE fault_category (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL,
      code text, name text, enabled boolean NOT NULL DEFAULT true, skill_tags jsonb
    );
    CREATE TABLE location_dict (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL,
      code text, name text, enabled boolean NOT NULL DEFAULT true
    );
    CREATE TABLE asset (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL,
      asset_no text, name text
    );
    CREATE TABLE reporter_dict (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL,
      code text, name text, phone text, enabled boolean NOT NULL DEFAULT true
    );
  `);
  await db.exec(readFileSync(join(process.cwd(), '111_department_model.sql'), 'utf8'));
  await db.query(
    `INSERT INTO dept (id, tenant_id, name, code, is_default) VALUES
       ($1,$2,'总务科','001',true),
       ($3,$2,'设备科','002',false)`,
    [DEFAULT_DEPT, T, EQUIP_DEPT],
  );
  await db.query(
    `INSERT INTO fault_category (tenant_id, code, name, enabled) VALUES
       ($1,'HVAC','空调维修',true), ($1,'ELEVATOR','电梯故障',true)`,
    [T],
  );
  await db.query(
    `INSERT INTO department_route_rule (tenant_id, name, priority, match_json, department_id) VALUES
       ($1,'空调归设备科',200,'{"business_type":"hvac"}'::jsonb,$2),
       ($1,'电梯归设备科',300,'{"catalog_name_contains":"电梯"}'::jsonb,$2)`,
    [T, EQUIP_DEPT],
  );
});

afterAll(async () => {
  await db.close();
});

describe('departmentResolver', () => {
  it('显式 department_id 最高优先', async () => {
    const r = await resolveDepartment(asClient(), T, {
      departmentId: DEFAULT_DEPT,
      businessType: 'hvac',
    });
    expect(r).toMatchObject({ departmentId: DEFAULT_DEPT, source: 'explicit' });
  });

  it('路由规则命中：business_type=hvac → 设备科', async () => {
    const r = await resolveDepartment(asClient(), T, { businessType: 'hvac' });
    expect(r.departmentId).toBe(EQUIP_DEPT);
    expect(r.source).toContain('rule:');
  });

  it('路由规则命中：分类名包含电梯 → 设备科', async () => {
    const r = await resolveDepartment(asClient(), T, { catalog: 'ELEVATOR', businessType: 'repair' });
    expect(r.departmentId).toBe(EQUIP_DEPT);
  });

  it('无规则命中 → 默认部门', async () => {
    const r = await resolveDepartment(asClient(), T, {
      businessType: 'unknown',
      description: '没有匹配规则',
    });
    expect(r).toMatchObject({ departmentId: DEFAULT_DEPT, source: 'default' });
  });

  it('默认部门缺失 → 明确 422（不是静默 500）', async () => {
    await db.query(`UPDATE dept SET is_default = false WHERE tenant_id = $1`, [T]);
    await expect(resolveDepartment(asClient(), T, { businessType: 'unknown' })).rejects.toMatchObject({
      code: 'DEPARTMENT_UNRESOLVED',
      status: 422,
    });
  });
});
