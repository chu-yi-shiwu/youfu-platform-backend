/**
 * accountTierGuard.http.test.ts —— 账号域 caller→target 层级校验（P0 提权链收口）。
 *
 * 【为什么有这份测试】
 *   修复前三条已确认的提权链，病根同一个：账号写接口**只校验调用者有没有 role.manage，
 *   不校验目标账号是什么角色**。
 *     ① POST /accounts/:id/reset-password：operator 重置 admin 密码 → 拿明文临时密码直接登录；
 *     ② PUT  /accounts/roles/:role/permissions：operator 给自己角色加任意权限，或把
 *        role.manage 写进 worker 角色（提权链可复制）；
 *     ③ PUT/DELETE /accounts/:id：canAssignRole 只看"新角色能不能分配"，
 *        「把 admin 改成 operator」「停用 admin」「删 admin」一路放行（≥2 个管理员时
 *        last-admin 也不触发）。
 *
 * 【为什么 authMode 必须是 'prod'】
 *   dev 模式下 requirePermission 恒放行、role 恒被当成 admin，越权用例会**假绿**——
 *   测出来的是 dev 短路，不是层级校验。本文件全部按 prod 跑，operator 的 role.manage
 *   由 role_permission 脚本行显式授予（默认矩阵里 operator 本就没有它）。
 *
 * 真 express + 真路由 + mock 连接池（脚本化 SQL 响应 + 调用日志），与 volunteerGuard.http 同范式。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';
import type { AuthLocals } from '../middleware/auth.js';

const T = 't-account-tier';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] }>,
  scripted: [] as Array<{ match: RegExp; rows: any[]; rowCount?: number }>,
  auth: {} as Record<string, unknown>,
}));

vi.mock('../db/pool.js', () => ({
  default: { query: async () => ({ rows: [], rowCount: 1 }) }, // 审计旁路
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tenantId: string, fn: (client: any) => Promise<any>) => {
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        h.calls.push({ sql, params });
        for (const s of h.scripted) {
          if (s.match.test(sql)) return { rows: s.rows, rowCount: s.rowCount ?? s.rows.length };
        }
        return { rows: [], rowCount: 1 };
      },
    };
    return fn(client);
  },
}));

import accountsRouter from '../routes/accounts.js';

interface Handler {
  match: RegExp;
  rows: any[];
  rowCount?: number;
}

/** operator 持 role.manage（租户显式授予；默认矩阵里没有它）。 */
const OPERATOR_HAS_ROLE_MANAGE: Handler = {
  match: /SELECT perm FROM role_permission/,
  rows: [{ perm: 'role.manage' }],
  rowCount: 1,
};

/** 目标账号行：PUT/DELETE/重置密码三处的 SELECT 形状不同，用一个宽匹配覆盖。 */
const accountRow = (role: string, active = true, id = 'acc-target'): Handler => ({
  match: /FROM account_user WHERE id=\$1 AND tenant_id=\$2/,
  rows: [{ id, tenant_id: T, username: 'target', display_name: null, role, active, phone: null }],
  rowCount: 1,
});

const accountUpdatedRow: Handler = {
  match: /^UPDATE account_user SET/,
  rows: [{ id: 'acc-target', tenant_id: T, username: 'target', display_name: null, role: 'worker', active: true, phone: null }],
  rowCount: 1,
};

const accountDeleted: Handler = { match: /^DELETE FROM account_user/, rows: [], rowCount: 1 };

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = h.auth as unknown as AuthLocals;
    next();
  });
  app.use('/api/v1', accountsRouter); // 与生产 server.ts:219 挂载一致
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  h.calls.length = 0;
  h.scripted = [];
  h.auth = { tenantId: T, role: 'operator', authMode: 'prod', userId: 'u-op', username: 'op', requestId: 'test' };
});

async function call(
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, any> }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: Record<string, any> = {};
  try { parsed = JSON.parse(text) as Record<string, any>; } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
}

const touched = (re: RegExp) => h.calls.some((c) => re.test(c.sql));

// ============================================================================
// ① 重置密码 = 一步接管 admin（最短的那条链）
// ============================================================================
describe('重置密码的层级校验（POST /accounts/:id/reset-password）', () => {
  it('T1 operator 重置 admin 密码 → 403，且不执行任何 UPDATE account_user', async () => {
    h.scripted = [OPERATOR_HAS_ROLE_MANAGE, accountRow('admin')];
    const r = await call('POST', '/accounts/acc-target/reset-password');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FORBIDDEN');
    // 文案要能说清"为什么被拒"，不能只有一个 FORBIDDEN
    // 2026-11-07：重置密码改用 canResetPasswordOf（严格小于），文案随之明确为"只能重置下级"
    expect(r.body.message).toContain('无权重置该账号密码');
    expect(touched(/UPDATE account_user SET password_hash/)).toBe(false);
    // 失败路径不得把临时密码发出去（否则等于把 admin 的钥匙递到手上）
    expect(r.body.temp_password).toBeUndefined();
  });

  it('T2 operator 重置 worker 密码 → 200（正常业务不误伤）', async () => {
    h.scripted = [OPERATOR_HAS_ROLE_MANAGE, accountRow('worker')];
    const r = await call('POST', '/accounts/acc-target/reset-password');
    expect(r.status).toBe(200);
    expect(typeof r.body.temp_password).toBe('string');
    expect(touched(/UPDATE account_user SET password_hash/)).toBe(true);
  });

  it('T2c operator 重置**同层** reviewer 密码 → 403（同层接管会绕过自审自批）', async () => {
    // operator 与 reviewer 同为 ROLE_RANK 3。若重置密码沿用 `<=`，operator 可以重置
    // reviewer 的密码并以 reviewer 身份登录；而 reviewer 的 workflow.approve 是租户
    // 可授的，且「自审自批禁令」按 username 比对 ⇒ 这条合规控制会被绕过。
    // 所以重置密码必须严格小于：只能重置**下级**，同层请由管理员操作。
    h.scripted = [OPERATOR_HAS_ROLE_MANAGE, accountRow('reviewer')];
    const r = await call('POST', '/accounts/acc-target/reset-password');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FORBIDDEN');
    expect(r.body.temp_password).toBeUndefined();
    expect(touched(/UPDATE account_user SET password_hash/)).toBe(false);
  });

  it('T2b 层级校验 SQL 契约：目标账号查询必须取 role（只 select id 时守卫静默失效）', async () => {
    h.scripted = [OPERATOR_HAS_ROLE_MANAGE, accountRow('worker')];
    await call('POST', '/accounts/acc-target/reset-password');
    const sel = h.calls.find((c) => /FROM account_user WHERE id=\$1 AND tenant_id=\$2/.test(c.sql));
    expect(sel).toBeDefined();
    expect(sel!.sql).toContain('role');
  });
});

// ============================================================================
// ② 更新 / 删除账号：看的是 target 的**当前**角色（canAssignRole 看不到这个维度）
// ============================================================================
describe('账号写操作的层级校验（PUT / DELETE /accounts/:id）', () => {
  it('T3 operator 把 admin 改成 operator → 403，且库不变', async () => {
    h.scripted = [OPERATOR_HAS_ROLE_MANAGE, accountRow('admin'), accountUpdatedRow];
    const r = await call('PUT', '/accounts/acc-target', { role: 'operator' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FORBIDDEN');
    expect(touched(/^UPDATE account_user SET/)).toBe(false);
  });

  it('T4 operator 停用 admin → 403', async () => {
    h.scripted = [OPERATOR_HAS_ROLE_MANAGE, accountRow('admin'), accountUpdatedRow];
    const r = await call('PUT', '/accounts/acc-target', { active: false });
    expect(r.status).toBe(403);
    expect(touched(/^UPDATE account_user SET/)).toBe(false);
  });

  it('T5 operator 删除 admin → 403，且不执行 DELETE', async () => {
    h.scripted = [OPERATOR_HAS_ROLE_MANAGE, accountRow('admin'), accountDeleted];
    const r = await call('DELETE', '/accounts/acc-target');
    expect(r.status).toBe(403);
    expect(touched(/^DELETE FROM account_user/)).toBe(false);
  });

  it('T5b operator 改 worker 的角色/停用/删除 → 200（不误伤下级账号管理）', async () => {
    h.scripted = [OPERATOR_HAS_ROLE_MANAGE, accountRow('worker'), accountUpdatedRow, accountDeleted];
    expect((await call('PUT', '/accounts/acc-target', { active: false })).status).toBe(200);
    expect((await call('DELETE', '/accounts/acc-target')).status).toBe(200);
  });
});

// ============================================================================
// ③ 权限矩阵写入：提权链的起点
// ============================================================================
describe('权限矩阵写入的三重收口（PUT /accounts/roles/:role/permissions）', () => {
  it('T6 operator 改 admin 角色的矩阵 → 403（不是 400：这是越权，不是参数写错）', async () => {
    h.scripted = [OPERATOR_HAS_ROLE_MANAGE];
    const r = await call('PUT', '/accounts/roles/admin/permissions', { perms: ['ticket.manage'] });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FORBIDDEN');
    expect(touched(/^DELETE FROM role_permission/)).toBe(false);
    expect(touched(/INSERT INTO role_permission/)).toBe(false);
  });

  it('T7 operator 改**自己角色**的矩阵 → 403（否则矩阵=自提权按钮）', async () => {
    h.scripted = [OPERATOR_HAS_ROLE_MANAGE];
    const r = await call('PUT', '/accounts/roles/operator/permissions', { perms: ['ticket.manage'] });
    expect(r.status).toBe(403);
    expect(r.body.message).toBe('不能修改自己所属角色的权限矩阵');
    expect(touched(/INSERT INTO role_permission/)).toBe(false);
  });

  it('T8 operator 给 worker 角色写 role.manage → 403（账号域控制权不可下放）', async () => {
    h.scripted = [OPERATOR_HAS_ROLE_MANAGE];
    const r = await call('PUT', '/accounts/roles/worker/permissions', { perms: ['intake.create', 'role.manage'] });
    expect(r.status).toBe(403);
    expect(r.body.message).toContain('role.manage');
    expect(touched(/INSERT INTO role_permission/)).toBe(false);
  });

  it('T8b 实例级形态 role.manage@xxx 同样被挡（permBase 口径，不靠字符串全等）', async () => {
    h.scripted = [OPERATOR_HAS_ROLE_MANAGE];
    const r = await call('PUT', '/accounts/roles/worker/permissions', { perms: ['role.manage@work_order'] });
    expect(r.status).toBe(403);
    expect(touched(/INSERT INTO role_permission/)).toBe(false);
  });

  it('T9 operator 给 worker 写普通业务权限 ticket.manage → 200（不误伤权限配置）', async () => {
    h.scripted = [OPERATOR_HAS_ROLE_MANAGE];
    const r = await call('PUT', '/accounts/roles/worker/permissions', { perms: ['ticket.manage'] });
    expect(r.status).toBe(200);
    expect(touched(/^DELETE FROM role_permission/)).toBe(true);
    expect(touched(/INSERT INTO role_permission/)).toBe(true);
  });
});

// ============================================================================
// ④ admin 不被层级校验误伤（修复只收口 operator，不动管理员能力）
// ============================================================================
describe('admin 全部放行（层级校验不得削弱管理员）', () => {
  beforeEach(() => {
    h.auth = { tenantId: T, role: 'admin', authMode: 'prod', userId: 'u-admin', username: 'root', requestId: 'test' };
  });

  it('T10a admin 重置 worker 密码 → 200', async () => {
    h.scripted = [accountRow('worker')];
    const r = await call('POST', '/accounts/acc-target/reset-password');
    expect(r.status).toBe(200);
  });

  it('T10b admin 改 operator 角色 / 停用 / 删除 → 200', async () => {
    h.scripted = [accountRow('operator'), accountUpdatedRow, accountDeleted];
    expect((await call('PUT', '/accounts/acc-target', { role: 'worker' })).status).toBe(200);
    expect((await call('PUT', '/accounts/acc-target', { active: false })).status).toBe(200);
    expect((await call('DELETE', '/accounts/acc-target')).status).toBe(200);
  });

  it('T10c admin 改 worker / operator 角色矩阵 → 200', async () => {
    h.scripted = [];
    expect((await call('PUT', '/accounts/roles/worker/permissions', { perms: ['ticket.manage'] })).status).toBe(200);
    expect((await call('PUT', '/accounts/roles/operator/permissions', { perms: ['ticket.manage'] })).status).toBe(200);
  });

  it('T10d admin 改 admin 角色矩阵 → 仍是既有的 400（恒全放行，比层级校验更硬，语义不变）', async () => {
    h.scripted = [];
    const r = await call('PUT', '/accounts/roles/admin/permissions', { perms: ['ticket.manage'] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('BAD_PARAM');
  });
});
