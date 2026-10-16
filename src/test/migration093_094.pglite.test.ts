// 093 / 094 两个迁移的**真执行**验证（PGlite = 真实 PostgreSQL 编译到 WASM）。
//
// 【为什么要有这个测试】
//   后端 1402 个用例里，没有任何一个字符执行过 093/094——它们是纯 SQL，
//   而现有测试全用 mock（repo 层的 mkClient / mockResolvedValueOnce）。
//   jsonb_set 嵌套 jsonb_agg 内层子查询 + COALESCE 空数组的语义，用 mock 在**原理上**测不出来：
//   mock 测的是我们以为 SQL 会做什么，不是 SQL 真的做了什么。
//
// 【⚠️ 版本差异（如实标注）】
//   PGlite 0.5.10 = PostgreSQL 18.6；生产库 = PostgreSQL 15.18。
//   093/094 用到的语法（jsonb_set / jsonb_agg / DO 块 / CHECK / RLS policy / gen_random_uuid）
//   在 15 与 18 上均支持，故本测试结论可迁移；但**它证明的是逻辑正确，不证明 15.18 上的执行计划**。
//   真库首次执行仍须按文件头纪律用 sudo -u postgres psql -f。
//
// 【不做什么】
//   不覆盖存量数据回填的"真实规模效果"——那必须真库。本测试用最小但**真实形状**的 schema。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { stripPsqlMeta } from '../db/psqlMeta.js';

const REPO_ROOT = join(__dirname, '..', '..');
const sql093 = () => stripPsqlMeta(readFileSync(join(REPO_ROOT, '093_retired_roles_backfill.sql'), 'utf8')).sql;
const sql094 = () => stripPsqlMeta(readFileSync(join(REPO_ROOT, '094_workflow_auto_rule.sql'), 'utf8')).sql;

// ── 最小 schema：形状抄自 001_init.sql:7（app_tenant_id）与 022_workflow_def.sql（workflow_def 原文）──
const MIN_SCHEMA = `
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS text
  LANGUAGE sql STABLE AS $$
    SELECT COALESCE(current_setting('app.tenant_id', true), '')::text;
$$;

CREATE TABLE IF NOT EXISTS workflow_def (
  id          bigserial PRIMARY KEY,
  tenant_id   text NOT NULL,
  entity_type text NOT NULL,
  def         jsonb NOT NULL DEFAULT '{}'::jsonb,
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity_type)
);

-- 093⑤ 引用 account_user(tenant_id, role)；本测试只需这两列
CREATE TABLE IF NOT EXISTS account_user (
  tenant_id text NOT NULL,
  role      text NOT NULL
);
`;

// ── 5 组 fixture：覆盖 093 的三类边 + 一个干净对照 ──
const FIXTURES: { tenant: string; def: any }[] = [
  {
    // ① dispatch：含 dispatcher + service_desk + admin
    tenant: 't1',
    def: {
      states: ['draft', 'assigned', 'completed'],
      transitions: [
        { from: 'draft', to: 'assigned', event: 'dispatch', allowedRoles: ['admin', 'dispatcher', 'service_desk'] },
      ],
    },
  },
  {
    // ② forward：只含 service_desk（摘完应为空数组，不是删边）
    tenant: 't2',
    def: {
      states: ['assigned', 'processing'],
      transitions: [
        { from: 'assigned', to: 'processing', event: 'forward', allowedRoles: ['service_desk'] },
      ],
    },
  },
  {
    // ③ cancel：含 dispatcher（改动前代码口径 ['admin','dispatcher']）
    tenant: 't3',
    def: {
      states: ['assigned', 'cancelled'],
      transitions: [
        { from: 'assigned', to: 'cancelled', event: 'cancel', allowedRoles: ['admin', 'dispatcher'] },
      ],
    },
  },
  {
    // ④ accept / claim：只摘角色，**不补权限点**（防 operator 被扩权进接单门禁）
    tenant: 't4',
    def: {
      states: ['assigned', 'processing'],
      transitions: [
        { from: 'assigned', to: 'processing', event: 'accept', allowedRoles: ['dispatcher', 'worker'] },
        { from: 'assigned', to: 'processing', event: 'claim', allowedRoles: ['dispatcher'] },
      ],
    },
  },
  {
    // ⑤ 对照：完全不含退场角色（迁移必须一个字节都不动它）
    tenant: 't5',
    def: {
      states: ['draft', 'assigned'],
      transitions: [
        { from: 'draft', to: 'assigned', event: 'dispatch', allowedRoles: ['admin', 'operator'] },
      ],
    },
  },
];

let db: PGlite;

// PGlite 的 query() 返回 rows: unknown[]；这里统一收口成 any[]，测试断言不因此失真
// （失真风险在断言内容，不在类型——见文件头的变异验证说明）。
function q(sql: string, params?: any[]): Promise<{ rows: any[] }> {
  return db.query(sql, params) as unknown as Promise<{ rows: any[] }>;
}

async function seed(): Promise<void> {
  await db.exec(MIN_SCHEMA);
  // 094 的 RLS policy / GRANT 都以 youfu_app 为被授权方；真库由运维预建，这里补上。
  const has = await q(`SELECT 1 FROM pg_roles WHERE rolname = 'youfu_app'`);
  if (!has.rows.length) await db.exec(`CREATE ROLE youfu_app`);
  for (const f of FIXTURES) {
    await q(
      `INSERT INTO workflow_def (tenant_id, entity_type, def) VALUES ($1, 'work_order', $2::jsonb)`,
      [f.tenant, JSON.stringify(f.def)],
    );
  }
  // 存量退场角色账号：093 明确「一个不动」
  await q(`INSERT INTO account_user (tenant_id, role) VALUES ('t1','dispatcher'), ('t1','service_desk')`);
}

async function defOf(tenant: string): Promise<any> {
  const r = await q(`SELECT def FROM workflow_def WHERE tenant_id = $1 AND entity_type = 'work_order'`, [tenant]);
  return r.rows[0].def;
}
async function edgeOf(tenant: string, event: string): Promise<any> {
  const d = await defOf(tenant);
  return d.transitions.find((t: any) => t.event === event);
}

describe('093/094 迁移真执行验证（PGlite）', () => {
  beforeAll(async () => {
    db = await PGlite.create();
    await seed();
    // 记录迁移前快照，用于「迁移确实执行过」的元断言
    await q(`CREATE TABLE snap_before AS SELECT tenant_id, def, updated_at FROM workflow_def`);
  }, 120_000);

  afterAll(async () => {
    await db.close();
  });

  // ── 元断言：证明 SQL 真的被执行了（不是空跑 / 不是 mock）──
  it('093 确实执行了 UPDATE（updated_at 被推进）', async () => {
    await db.exec(sql093());
    const r = await q(
      `SELECT count(*)::int AS n FROM workflow_def w JOIN snap_before b USING (tenant_id) WHERE w.updated_at > b.updated_at`,
    );
    expect(r.rows[0].n).toBe(4); // t1..t4 被改，t5 对照不变
  });

  it('093① dispatch 边：摘两角色 + 补 dispatch.override', async () => {
    const e = await edgeOf('t1', 'dispatch');
    expect(e.allowedRoles).toEqual(['admin']);
    expect(e.allowedPerms).toEqual(['dispatch.override']);
  });

  it('093② forward 边只剩 service_desk：摘完为空数组，边本身不被删除', async () => {
    const d = await defOf('t2');
    expect(d.transitions).toHaveLength(1); // 零破坏：不新增/删除边
    const e = d.transitions[0];
    expect(e.event).toBe('forward');
    expect(e.allowedRoles).toEqual([]);
    expect(e.allowedPerms).toEqual(['dispatch.override']);
  });

  it('093③ cancel 边：摘 dispatcher + 补 ticket.manage', async () => {
    const e = await edgeOf('t3', 'cancel');
    expect(e.allowedRoles).toEqual(['admin']);
    expect(e.allowedPerms).toEqual(['ticket.manage']);
  });

  it('093④ accept/claim：只摘角色，**不得补任何权限点**（防 operator 被扩权进接单门禁）', async () => {
    const d = await defOf('t4');
    expect(d.transitions).toHaveLength(2);
    const accept = d.transitions.find((t: any) => t.event === 'accept');
    const claim = d.transitions.find((t: any) => t.event === 'claim');
    expect(accept.allowedRoles).toEqual(['worker']);
    expect(accept.allowedPerms).toBeUndefined(); // 🔴 补了就是扩权
    expect(claim.allowedRoles).toEqual([]);
    expect(claim.allowedPerms).toBeUndefined();
  });

  it('093⑤ 对照租户 t5：一个字节都不动', async () => {
    const before = await q(`SELECT def FROM snap_before WHERE tenant_id = 't5'`);
    const after = await defOf('t5');
    expect(after).toEqual(before.rows[0].def);
  });

  it('093⑥ 存量退场角色账号：一个不动（改派是管理员决策，迁移不代劳）', async () => {
    const r = await q(`SELECT tenant_id, role FROM account_user ORDER BY role`);
    expect(r.rows).toEqual([
      { tenant_id: 't1', role: 'dispatcher' },
      { tenant_id: 't1', role: 'service_desk' },
    ]);
  });

  it('093⑦ 幂等：二次执行后 def 与首次执行后逐字节相同', async () => {
    const first = JSON.stringify(await defOf('t1'));
    await db.exec(sql093()); // 第二次
    const second = JSON.stringify(await defOf('t1'));
    expect(second).toBe(first);
    // t5 依然不动
    const before = await q(`SELECT def FROM snap_before WHERE tenant_id = 't5'`);
    expect(await defOf('t5')).toEqual(before.rows[0].def);
  });

  // ── 094 ──
  it('094① 表建成，enabled 默认 false（建规则 ≠ 启用）', async () => {
    await db.exec(sql094());
    await q(`INSERT INTO workflow_auto_rule (tenant_id, from_state, event) VALUES ('t1','pending_review','approve')`);
    const r = await q(`SELECT enabled FROM workflow_auto_rule WHERE tenant_id = 't1'`);
    expect(r.rows[0].enabled).toBe(false);
  });

  it('094② 事件白名单：acceptance_pass / close 被 CHECK 挡在库外', async () => {
    await expect(
      db.query(`INSERT INTO workflow_auto_rule (tenant_id, from_state, event) VALUES ('t9','completed','acceptance_pass')`),
    ).rejects.toThrow();
    await expect(
      db.query(`INSERT INTO workflow_auto_rule (tenant_id, from_state, event) VALUES ('t9','processing','close')`),
    ).rejects.toThrow();
    // 白名单内的两个动作必须能进
    await q(`INSERT INTO workflow_auto_rule (tenant_id, from_state, event) VALUES ('t9','pending_review','reject')`);
    const r = await q(`SELECT event FROM workflow_auto_rule WHERE tenant_id = 't9'`);
    expect(r.rows.map((x: any) => x.event)).toEqual(['reject']);
  });

  it('094③ 唯一索引：同(租户,实体,触发态,事件)只允许一条', async () => {
    await q(
      `INSERT INTO workflow_auto_rule (tenant_id, entity_type, from_state, event) VALUES ('t8','work_order','pending_review','approve')`,
    );
    await expect(
      db.query(
        `INSERT INTO workflow_auto_rule (tenant_id, entity_type, from_state, event) VALUES ('t8','work_order','pending_review','approve')`,
      ),
    ).rejects.toThrow();
  });

  it('094④ RLS 已启用（未启用 = 租户串租户，属事故）', async () => {
    const r = await q(`SELECT relrowsecurity FROM pg_class WHERE relname = 'workflow_auto_rule'`);
    expect(r.rows[0].relrowsecurity).toBe(true);
  });

  it('094⑤ 幂等：二次执行不报错且表结构不变', async () => {
    const before = await q(
      `SELECT column_name, column_default FROM information_schema.columns WHERE table_name='workflow_auto_rule' ORDER BY ordinal_position`,
    );
    await db.exec(sql094()); // 第二次
    const after = await q(
      `SELECT column_name, column_default FROM information_schema.columns WHERE table_name='workflow_auto_rule' ORDER BY ordinal_position`,
    );
    expect(after.rows).toEqual(before.rows);
  });
});
