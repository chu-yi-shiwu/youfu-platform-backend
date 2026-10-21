/**
 * 登录 fail-closed（2026-10-19）：tenant_registry 查不到登记行 → 拒绝登录
 *
 * 【修什么】
 *   routes/auth.ts 登录守卫原口径：`if (reg.rowCount && reg.rowCount > 0)` 才查状态——
 *   registry 查不到行时**整段跳过**（fail-open）。后果（生产实证）：账号在 account_user、
 *   登记行被人工删除的租户（2026-09-05 probe 清理漏尾 2 个）可绕过平台封禁登录，
 *   且平台侧统计/封禁/对账全看不见。
 *   今日生产已补登记（孤儿差集=0），本改动对在册租户零影响；对未登记租户由
 *   "静默放行"改"明确拒绝"（403 TENANT_NOT_REGISTERED，前端 errText 直接显示中文 message）。
 *
 * 【既有口径不动】
 *   suspended → TENANT_SUSPENDED；pending → TENANT_PENDING；账号/密码错 → 401（不暴露存在性）。
 *
 * 【诚实边界】
 *   PGlite 无 youfu_app 角色/RLS（withTenantClient 的 SET LOCAL 被拦截忽略，同既有约定）。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

const T_ACTIVE = 't-login-active';
const T_ORPHAN = 't-login-orphan';
const T_SUSPENDED = 't-login-suspended';
const T_PENDING = 't-login-pending';

const box = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@electric-sql/pglite', async () => {
  const actual = (await vi.importActual('@electric-sql/pglite')) as { PGlite: new () => unknown };
  return { ...actual, PGlite: class extends (actual.PGlite as any) {} };
});

vi.mock('../db/pool.js', () => ({
  default: {
    // routes/auth.ts 的 listPerms 经 withTenantClient；platform_audit 不涉及本路由
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
import { hashPassword } from '../account.js';
import authRouter from '../routes/auth.js';

let server: Server;
let base = '';

const DDL = `
CREATE TABLE tenant_registry (
  tenant_id  text PRIMARY KEY,
  name       text NOT NULL,
  category   text NOT NULL DEFAULT 'hospital',
  status     text NOT NULL DEFAULT 'active',
  quota      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
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
  wx_openid      text,
  UNIQUE (tenant_id, username)
);
CREATE TABLE role_permission (
  tenant_id  text NOT NULL,
  role       text NOT NULL,
  perm       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, role, perm)
);
`;

const db = () => box.db as unknown as { query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }> };

beforeAll(async () => {
  // F7 配套（2026-10-19）：AUTH_MODE 缺省改为 prod 后，登录签发走 fail-closed 分支
  // （prod 缺 JWT_SECRET → 500 AUTH_CFG，不再回退不安全默认密钥）。
  // 本用例锁的是「登记行 fail-closed」这条闸，与鉴权模式无关，但跑在 prod 口径下更贴近生产
  // ——故显式补齐测试环境密钥，而不是把 AUTH_MODE 调回 dev。
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-fail-closed';
  box.db = new PGlite();
  await (box.db as unknown as { exec: (s: string) => Promise<void> }).exec(DDL);

  const app = express();
  app.use(express.json());
  app.use('/api/v1', authRouter);
  app.use(errorMiddleware);

  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await (box.db as unknown as { close: () => Promise<void> }).close();
});

beforeEach(async () => {
  for (const t of ['account_user', 'role_permission', 'tenant_registry']) {
    await db().query(`DELETE FROM ${t}`);
  }
  // 每个租户建一个 active 账号（孤儿租户也有账号——这正是洞所在）
  for (const tid of [T_ACTIVE, T_ORPHAN, T_SUSPENDED, T_PENDING]) {
    await db().query(
      `INSERT INTO account_user (tenant_id, username, password_hash, role, active)
       VALUES ($1, 'zhangsan', $2, 'admin', true)`,
      [tid, hashPassword('Passw0rd2026')],
    );
  }
  await db().query(
    `INSERT INTO tenant_registry (tenant_id, name, status) VALUES
     ($1, '在册机构', 'active'),
     ($2, '封禁机构', 'suspended'),
     ($3, '待激活机构', 'pending')`,
    [T_ACTIVE, T_SUSPENDED, T_PENDING],
  );
  // 注意：T_ORPHAN 故意不建登记行（账号在、登记行不在 = 生产漏尾形态）
});

async function login(tenant: string, password = 'Passw0rd2026') {
  const r = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'zhangsan', password, tenant }),
  });
  const text = await r.text();
  let j: Record<string, unknown> = {};
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    j = { raw: text };
  }
  return { status: r.status, body: j };
}

describe('登录 fail-closed —— 登记行是登录的前置条件', () => {
  it('① 在册 active 租户正常登录不回归：200 + token + user', async () => {
    const r = await login(T_ACTIVE);
    expect(r.status).toBe(200);
    expect((r.body as { ok?: boolean }).ok).toBe(true);
    expect(String((r.body as { token?: string }).token ?? '').length).toBeGreaterThan(10);
    const user = (r.body as { user?: { username?: string } }).user ?? {};
    expect(user.username).toBe('zhangsan');
  });

  it('② 孤儿租户（账号在、登记行不在）→ 403 TENANT_NOT_REGISTERED，不再静默放行', async () => {
    const r = await login(T_ORPHAN);
    expect(r.status).toBe(403);
    expect((r.body as { code?: string }).code).toBe('TENANT_NOT_REGISTERED');
    expect(String((r.body as { message?: string }).message)).toContain('平台登记');
    // 且不发 token
    expect((r.body as { token?: string }).token).toBeUndefined();
  });

  it('③ suspended 既有口径不动：403 TENANT_SUSPENDED', async () => {
    const r = await login(T_SUSPENDED);
    expect(r.status).toBe(403);
    expect((r.body as { code?: string }).code).toBe('TENANT_SUSPENDED');
  });

  it('④ pending 既有口径不动：403 TENANT_PENDING', async () => {
    const r = await login(T_PENDING);
    expect(r.status).toBe(403);
    expect((r.body as { code?: string }).code).toBe('TENANT_PENDING');
  });

  it('⑤ 在册租户 + 错误密码 → 401（不暴露账号存在性，回归）', async () => {
    const r = await login(T_ACTIVE, 'wrong-password');
    expect(r.status).toBe(401);
    expect((r.body as { code?: string }).code).toBe('AUTH_003');
  });
});
