// accountRoleEscalation.http.test.ts —— P0-5 账号提权门禁（HTTP 入口级）。
//
// 【为什么必须有这个文件】
//   `POST /auth/users` 与 `POST /invites` 此前只校验 `role.manage` + 角色 code 形状：
//   一旦租户把 `role.manage` 授予 operator（或任一非 admin 角色），
//   该角色就能直接创建 admin 账号 / 开出 admin 邀请码，绕过 accounts.ts 里
//   `canAssignRole` 的「不可越级、不可铸造 admin」门禁。
//   这两个端点 = 建号前置动作，等于把提权旁路开在账号域最上游。
//
// 本文件钉死：
//   ① operator 即使拿到 role.manage，也不能建 admin / 开 admin 邀请码；
//   ② operator 可以建同层（operator）与更低层（worker）账号；
//   ③ worker 即使拿到 role.manage，也不能越级建 operator；
//   ④ admin 不受影响（可建 admin）；
//   ⑤ 被拒时不得产生任何 INSERT（门禁必须在写库前）。
//
// 范式：真 express + 真 HTTP，mock 掉 DB 连接池（与 retiredRoleGuard.http.test.ts 同款）。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] }>,
  scripted: [] as Array<{ match: RegExp; rows: any[]; rowCount?: number }>,
  caller: { role: 'admin', authMode: 'prod' as 'dev' | 'prod', userId: 'u-caller' },
}));

vi.mock('../db/pool.js', () => ({
  default: {},
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tenantId: string, fn: (client: any) => Promise<any>) => {
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        h.calls.push({ sql, params });
        for (const s of h.scripted) {
          if (s.match.test(sql)) return { rows: s.rows, rowCount: s.rowCount ?? s.rows.length };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    return fn(client);
  },
}));

import authRouter from '../routes/auth.js';
import inviteRouter from '../routes/invite.js';
import accountsRouter from '../routes/accounts.js';

const T = 't-role-escalation';
let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((_req: any, res: any, next: any) => {
    res.locals.auth = {
      tenantId: T,
      role: h.caller.role,
      authMode: h.caller.authMode,
      userId: h.caller.userId,
      username: 'caller',
    };
    next();
  });
  app.use(authRouter);
  app.use(inviteRouter);
  app.use(accountsRouter);
  app.use(errorMiddleware);
  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  h.calls.length = 0;
  h.scripted.length = 0;
  // 调用者持 role.manage（否则所有用例会先被 requirePermission 拦成 403，测不到 canAssignRole）
  h.scripted.push({ match: /role_permission/i, rows: [{ perm: 'role.manage' }], rowCount: 1 });
  // 不重名 → 放行到 INSERT
  h.scripted.push({ match: /SELECT 1 FROM account_user WHERE tenant_id=\$1 AND username=\$2/i, rows: [], rowCount: 0 });
  h.scripted.push({
    match: /INSERT INTO invite_codes/i,
    rows: [{ id: 'i-1', username: 'u1', display_name: null, role: 'worker', expires_at: '2999-01-01', created_at: 'now' }],
    rowCount: 1,
  });
  h.scripted.push({
    match: /INSERT INTO account_user/i,
    rows: [{ id: 'u-1', tenant_id: T, username: 'u1', display_name: null, role: 'worker', active: true, created_at: 'now' }],
    rowCount: 1,
  });
});

async function post(path: string, body: unknown) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}

const userBody = (role?: string) => ({ username: 'u1', password: 'abcd1234', ...(role ? { role } : {}) });
const inviteBody = (role?: string) => ({ username: 'u1', display_name: '某人', ...(role ? { role } : {}) });
const sqlAll = () => h.calls.map((c) => c.sql).join('\n');

describe('P0-5 · operator（已授 role.manage）不得铸造 admin', () => {
  beforeEach(() => {
    h.caller.role = 'operator';
    h.caller.authMode = 'prod';
  });

  it('POST /auth/users role=admin → 403，且不产生 INSERT', async () => {
    const r = await post('/auth/users', userBody('admin'));
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('FORBIDDEN');
    expect(sqlAll()).not.toMatch(/INSERT INTO account_user/i);
  });

  it('POST /invites role=admin → 403，且不产生 INSERT', async () => {
    const r = await post('/invites', inviteBody('admin'));
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('FORBIDDEN');
    expect(sqlAll()).not.toMatch(/INSERT INTO invite_codes/i);
  });

  it('POST /auth/users role=operator → 201（同层可分配，不误伤）', async () => {
    const r = await post('/auth/users', userBody('operator'));
    expect(r.status).toBe(201);
    expect(r.json.ok).toBe(true);
  });

  it('POST /invites role=worker → 201（低层可分配，不误伤）', async () => {
    const r = await post('/invites', inviteBody('worker'));
    expect(r.status).toBe(201);
    expect(r.json.ok).toBe(true);
  });

  it('POST /auth/users 缺省 role → 视为 operator，operator 可建（201）', async () => {
    const r = await post('/auth/users', userBody());
    expect(r.status).toBe(201);
  });
});

describe('P0-5 · worker（已授 role.manage）不得越级', () => {
  beforeEach(() => {
    h.caller.role = 'worker';
    h.caller.authMode = 'prod';
  });

  it('POST /auth/users role=operator → 403', async () => {
    const r = await post('/auth/users', userBody('operator'));
    expect(r.status).toBe(403);
    expect(sqlAll()).not.toMatch(/INSERT INTO account_user/i);
  });

  it('POST /invites role=operator → 403', async () => {
    const r = await post('/invites', inviteBody('operator'));
    expect(r.status).toBe(403);
    expect(sqlAll()).not.toMatch(/INSERT INTO invite_codes/i);
  });

  it('POST /auth/users 缺省 role（operator）→ 403（默认值不能成为越级后门）', async () => {
    const r = await post('/auth/users', userBody());
    expect(r.status).toBe(403);
  });

  it('POST /auth/users role=worker → 201（同层放行）', async () => {
    const r = await post('/auth/users', userBody('worker'));
    expect(r.status).toBe(201);
  });
});

describe('P0-5 · admin 不受影响', () => {
  beforeEach(() => {
    h.caller.role = 'admin';
    h.caller.authMode = 'prod';
  });

  it('POST /auth/users role=admin → 201', async () => {
    const r = await post('/auth/users', userBody('admin'));
    expect(r.status).toBe(201);
  });

  it('POST /invites role=admin → 201', async () => {
    const r = await post('/invites', inviteBody('admin'));
    expect(r.status).toBe(201);
  });
});

describe('P0-5 · dev 模式保持既有联调语义（按 admin 处理）', () => {
  beforeEach(() => {
    h.caller.role = 'operator';
    h.caller.authMode = 'dev';
  });

  it('dev 下 operator 建 admin → 201（与 dev 恒放行约定一致）', async () => {
    const r = await post('/auth/users', userBody('admin'));
    expect(r.status).toBe(201);
  });
});

describe('P0-2 · POST /accounts 省略 role 必须按落库默认值判定', () => {
  beforeEach(() => {
    h.caller.authMode = 'prod';
  });

  it('worker 持 role.manage，省略 role → 403，且不产生 INSERT', async () => {
    h.caller.role = 'worker';
    const r = await post('/accounts', { username: 'u1', password: 'abcd1234' });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe('FORBIDDEN');
    expect(h.calls.some((c) => /INSERT INTO account_user/i.test(c.sql))).toBe(false);
  });

  it('operator 省略 role → 201，落库值为 operator', async () => {
    h.caller.role = 'operator';
    const r = await post('/accounts', { username: 'u1', password: 'abcd1234' });
    expect(r.status).toBe(201);
    const ins = h.calls.find((c) => /INSERT INTO account_user/i.test(c.sql));
    expect(ins?.params[4]).toBe('operator');
  });
});
