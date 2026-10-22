/**
 * 「业务流程可配置」审批落 live 全链路 —— 真 express 路由 + 真 PGlite 库
 *
 * 【为什么要有这份】
 *   096 迁移把 workflow_def.def（live）里 assign/submit 边上的退场角色摘掉了。
 *   但 live 还有第二条写入路径：**草稿审批**（PUT draft → submit → approve → saveWorkflowDef）。
 *   这条路径走不走退场角色闸门，此前没有任何用例覆盖——只有纯函数级
 *   `assertWorkflowDefRolesUsable` 用例（workflowDefValidate.test.ts:154），且那组用的
 *   是 admin/worker 两个**未退场**的内置角色，**退场角色一个都没测**。
 *   本文件把「草稿 → 提交 → 审批 → live」整条链在真库上跑一遍，把行为钉死。
 *
 * 【诚实边界】
 *   - PGlite 单用户，无 youfu_app 角色、无 RLS ⇒ 本文件**不证明租户隔离**。
 *   - ① 断言的是**当前现状**（放行），不是期望行为。待初一拍板是否加闸门；
 *     一旦修复，① 会变红，届时把 ① 改成"期望被挡"即可——这不是假绿，是刻意的行为锚。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';
import type { AuthLocals } from '../middleware/auth.js';

const T = 't-flow';
const ET = 'work_order';

const box = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('../db/pool.js', () => ({
  default: { query: async () => ({ rows: [], rowCount: 0 }) },
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
import workflowDefRouter from '../routes/workflowDef.js';

let server: Server;
let base = '';

/** 当前请求的登录态（测试内可变，用于切换提交人 / 审批人 / 角色）。 */
const mkAuth = (over: Record<string, unknown> = {}): AuthLocals =>
  ({
    tenantId: T,
    role: 'admin',
    authMode: 'prod',
    userId: 'u-admin',
    username: 'admin-a',
    requestId: 'test',
    ...over,
  }) as unknown as AuthLocals;

let auth: AuthLocals = mkAuth();

const DDL = `
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
CREATE TABLE workflow_def_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  entity_type text NOT NULL,
  version     int  NOT NULL,
  def         jsonb NOT NULL,
  operator    text,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_workflow_def_history UNIQUE (tenant_id, entity_type, version)
);
CREATE TABLE workflow_def_change (
  id            bigserial PRIMARY KEY,
  tenant_id     text NOT NULL,
  entity_type   text NOT NULL,
  def           jsonb NOT NULL,
  note          text,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted')),
  base_version  int  NOT NULL,
  created_by    text,
  submitted_by  text,
  submitted_at  timestamptz,
  reject_comment text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  rev           int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, entity_type)
);
CREATE TABLE role_def (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  code        text NOT NULL,
  name        text NOT NULL,
  description text,
  enabled     boolean NOT NULL DEFAULT true,
  sort        int NOT NULL DEFAULT 100,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CONSTRAINT role_def_code_format CHECK (code ~ '^[a-z][a-z0-9_]{1,31}$')
);
CREATE TABLE role_permission (
  tenant_id  text NOT NULL,
  role       text NOT NULL,
  perm       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, role, perm)
);
CREATE TABLE account_user (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      text NOT NULL,
  username       text NOT NULL,
  password_hash  text NOT NULL,
  display_name   text,
  role           text NOT NULL DEFAULT 'operator',
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  phone          text,
  UNIQUE (tenant_id, username)
);
CREATE TABLE platform_audit (
  id            bigserial PRIMARY KEY,
  actor         text NOT NULL,
  action        text NOT NULL,
  resource      text,
  target_tenant text,
  payload       jsonb,
  at            timestamptz NOT NULL DEFAULT now()
);
`;

const db = () => box.db as unknown as { query: (s: string, p?: unknown[]) => Promise<{ rows: unknown[] }> };

beforeAll(async () => {
  process.env.WORKFLOW_CONFIG_OWNER = 'tenant'; // 097：本文件验证的是「归属放开」后的流程语义（审批链/乐观锁/删态硬闸）
  box.db = new PGlite();
  await (box.db as unknown as { exec: (s: string) => Promise<void> }).exec(DDL);
  // T0（101 迁移）：workflow_def 新增 updated_by；库形状须与生产迁移一致（否则写语句假红）
  await (box.db as unknown as { exec: (s: string) => Promise<void> }).exec(
    `ALTER TABLE workflow_def ADD COLUMN IF NOT EXISTS updated_by text;`,
  );

  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = auth;
    next();
  });
  // 与 src/server.ts:201 同前缀，URL 与线上逐字一致
  app.use('/api/v1/workflow-defs', workflowDefRouter);
  app.use(errorMiddleware);

  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  delete process.env.WORKFLOW_CONFIG_OWNER; // 097：环境隔离，避免污染同进程其它测试文件
  await new Promise<void>((r) => server.close(() => r()));
  await (box.db as unknown as { close: () => Promise<void> }).close();
});

beforeEach(async () => {
  auth = mkAuth();
  for (const t of [
    'workflow_def_change',
    'workflow_def_history',
    'workflow_def',
    'platform_audit',
    'account_user',
    'role_permission',
    'role_def',
  ]) {
    await db().query(`DELETE FROM ${t}`);
  }
});

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: r.status, body: parsed };
}

const rows = async (sql: string, p: unknown[] = []) => (await db().query(sql, p)).rows;

/** PGlite 的 jsonb 列直接返回已解析对象；pg 驱动返回字符串。两种都接住。 */
function asJson(v: unknown): Record<string, unknown> {
  return (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown>;
}

const STATES = ['draft', 'assigned', 'processing', 'completed'];

/** 造一份合法 def；transitions 由调用方给。 */
function defOf(trs: unknown[], config: Record<string, unknown> = {}) {
  return { initial: 'draft', states: STATES, transitions: trs, config };
}

/** 预置 live（模拟 096 已清理：assign 边只剩 admin）。 */
async function seedLive(version = 1, trs: unknown[] = [{ from: 'draft', to: 'assigned', event: 'assign', allowedRoles: ['admin'] }]) {
  await db().query(`INSERT INTO workflow_def (tenant_id, entity_type, def, version) VALUES ($1,$2,$3,$4)`, [
    T,
    ET,
    JSON.stringify(defOf(trs)),
    version,
  ]);
}

async function putDraft(trs: unknown[]) {
  return call('PUT', `/workflow-defs/${ET}`, { def: defOf(trs) });
}

describe('流程可配置 —— 草稿审批落 live（真路由 + 真库）', () => {
  it('① 退场角色不得经审批写回 live —— 096 的清理不被一份旧草稿复活', async () => {
    // live 已被 096 清理：assign 边只剩 admin
    await seedLive();
    // 一份 096 之前保存的旧草稿，assign 边仍带 dispatcher
    expect((await putDraft([{ from: 'draft', to: 'assigned', event: 'assign', allowedRoles: ['admin', 'dispatcher'] }])).status).toBe(200);
    expect((await call('POST', `/workflow-defs/${ET}/submit`, {})).status).toBe(200);

    const ap = await call('POST', `/workflow-defs/${ET}/approve`, {});
    expect(ap.status).toBe(422);
    expect(String((ap.body as { message?: string }).message)).toMatch(/已退场/);

    // live 一个字节都没动，变更行也还在（审批失败不吞草稿，可改后重提）
    const v = await rows(`SELECT version FROM workflow_def WHERE tenant_id=$1`, [T]);
    expect((v[0] as { version: number }).version).toBe(1);
    const chg = await rows(`SELECT status FROM workflow_def_change WHERE tenant_id=$1`, [T]);
    expect(chg).toEqual([{ status: 'submitted' }]);
  });

  it('② 另一个退场角色 service_desk 同样被挡（两个退场角色口径一致）', async () => {
    await seedLive();
    expect((await putDraft([{ from: 'draft', to: 'assigned', event: 'assign', allowedRoles: ['service_desk'] }])).status).toBe(200);
    expect((await call('POST', `/workflow-defs/${ET}/submit`, {})).status).toBe(200);
    const ap = await call('POST', `/workflow-defs/${ET}/approve`, {});
    expect(ap.status).toBe(422);
    expect(String((ap.body as { message?: string }).message)).toMatch(/已退场/);
  });

  it('③ 存量豁免：live 里本来就有的退场角色，草稿沿用不拦（不翻旧账，防存量租户流程被卡死）', async () => {
    // 尚未执行 096 清理的租户：live 里就是带 dispatcher
    await seedLive(1, [{ from: 'draft', to: 'assigned', event: 'assign', allowedRoles: ['admin', 'dispatcher'] }]);
    // 草稿沿用（只是改了别的边），不算"新增退场角色引用"
    expect((await putDraft([{ from: 'draft', to: 'assigned', event: 'assign', allowedRoles: ['admin', 'dispatcher'] }])).status).toBe(200);
    expect((await call('POST', `/workflow-defs/${ET}/submit`, {})).status).toBe(200);
    expect((await call('POST', `/workflow-defs/${ET}/approve`, {})).status).toBe(200);
    const v = await rows(`SELECT version FROM workflow_def WHERE tenant_id=$1`, [T]);
    expect((v[0] as { version: number }).version).toBe(2);
  });

  it('④ 对照组：未创建的自定义角色 → 422（自定义角色仍按"本租户是否存在"判）', async () => {
    await seedLive();
    expect((await putDraft([{ from: 'draft', to: 'assigned', event: 'assign', allowedRoles: ['ghost_role'] }])).status).toBe(200);
    expect((await call('POST', `/workflow-defs/${ET}/submit`, {})).status).toBe(200);
    const ap = await call('POST', `/workflow-defs/${ET}/approve`, {});
    expect(ap.status).toBe(422);
    expect(String((ap.body as { message?: string }).message)).toMatch(/不存在的角色/);
    // live 没被写脏
    const v = await rows(`SELECT version FROM workflow_def WHERE tenant_id=$1`, [T]);
    expect((v[0] as { version: number }).version).toBe(1);
  });

  it('③ 正常审批：live 落新 def + version 自增 + history 存旧快照 + 变更行删除', async () => {
    await seedLive();
    expect((await putDraft([{ from: 'draft', to: 'assigned', event: 'assign', allowedRoles: ['admin', 'reviewer'] }])).status).toBe(200);
    expect((await call('POST', `/workflow-defs/${ET}/submit`, {})).status).toBe(200);
    expect((await call('POST', `/workflow-defs/${ET}/approve`, {})).status).toBe(200);

    const live = await rows(`SELECT def, version FROM workflow_def WHERE tenant_id=$1`, [T]);
    const row = live[0] as { def: unknown; version: number };
    expect(row.version).toBe(2);
    const tr = (asJson(row.def).transitions as { allowedRoles?: string[] }[])[0];
    expect(tr.allowedRoles).toEqual(['admin', 'reviewer']);

    const hist = await rows(`SELECT version, reason FROM workflow_def_history WHERE tenant_id=$1`, [T]);
    expect(hist).toEqual([{ version: 1, reason: 'approve' }]);

    const chg = await rows(`SELECT count(*)::int AS n FROM workflow_def_change WHERE tenant_id=$1`, [T]);
    expect((chg[0] as { n: number }).n).toBe(0);
  });

  it('④ 审批权：无 workflow.approve 的账号 → 403（不能绕过审批流直写 live）', async () => {
    await seedLive();
    expect((await putDraft([{ from: 'draft', to: 'assigned', event: 'assign', allowedRoles: ['admin'] }])).status).toBe(200);
    expect((await call('POST', `/workflow-defs/${ET}/submit`, {})).status).toBe(200);

    auth = mkAuth({ role: 'worker', username: 'worker-w' });
    const ap = await call('POST', `/workflow-defs/${ET}/approve`, {});
    expect(ap.status).toBe(403);
    const v = await rows(`SELECT version FROM workflow_def WHERE tenant_id=$1`, [T]);
    expect((v[0] as { version: number }).version).toBe(1);
  });

  it('⑤ 自批护栏：多 admin 租户，提交人自己审批 → 403 SELF_APPROVAL', async () => {
    await db().query(
      `INSERT INTO account_user (tenant_id, username, password_hash, role, active) VALUES ($1,$2,$3,$4,true),($1,$5,$3,$4,true)`,
      [T, 'admin-a', 'x', 'admin', 'admin-b'],
    );
    await seedLive();
    expect((await putDraft([{ from: 'draft', to: 'assigned', event: 'assign', allowedRoles: ['admin'] }])).status).toBe(200);
    // 提交人与审批人同为 admin-a
    expect((await call('POST', `/workflow-defs/${ET}/submit`, {})).status).toBe(200);
    const ap = await call('POST', `/workflow-defs/${ET}/approve`, {});
    expect(ap.status).toBe(403);
    expect(String((ap.body as { code?: string }).code ?? '') + String((ap.body as { message?: string }).message ?? '')).toMatch(
      /SELF_APPROVAL|self-approval/,
    );
  });

  it('⑥ 版本锚点：live 已被他人推进 → 409 DRAFT_STALE（防脏写覆盖）', async () => {
    await seedLive();
    expect((await putDraft([{ from: 'draft', to: 'assigned', event: 'assign', allowedRoles: ['admin'] }])).status).toBe(200);
    expect((await call('POST', `/workflow-defs/${ET}/submit`, {})).status).toBe(200);
    // 提交后 live 被别处推进到 9
    await db().query(`UPDATE workflow_def SET version = 9 WHERE tenant_id=$1`, [T]);
    const ap = await call('POST', `/workflow-defs/${ET}/approve`, {});
    expect(ap.status).toBe(409);
    expect(String((ap.body as { code?: string }).code ?? '') + String((ap.body as { message?: string }).message ?? '')).toMatch(
      /DRAFT_STALE/,
    );
  });

  it('⑦ 驳回：live 不动、不产生新版本，status 回 draft 且回填意见', async () => {
    await seedLive();
    expect((await putDraft([{ from: 'draft', to: 'assigned', event: 'assign', allowedRoles: ['admin'] }])).status).toBe(200);
    expect((await call('POST', `/workflow-defs/${ET}/submit`, {})).status).toBe(200);

    const rj = await call('POST', `/workflow-defs/${ET}/reject`, { comment: '派单人选要重新过一遍' });
    expect(rj.status).toBe(200);

    const v = await rows(`SELECT version FROM workflow_def WHERE tenant_id=$1`, [T]);
    expect((v[0] as { version: number }).version).toBe(1);
    const hist = await rows(`SELECT count(*)::int AS n FROM workflow_def_history WHERE tenant_id=$1`, [T]);
    expect((hist[0] as { n: number }).n).toBe(0);
    const chg = await rows(`SELECT status, reject_comment FROM workflow_def_change WHERE tenant_id=$1`, [T]);
    expect(chg).toEqual([{ status: 'draft', reject_comment: '派单人选要重新过一遍' }]);
  });
});
