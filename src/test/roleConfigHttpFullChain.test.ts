/**
 * 「非代码级可配置」HTTP 全链路 —— 真 express + 真路由 + 真 SQL + 真库（PGlite）
 *
 * 【与 roleDefCrud.http.test.ts 的区别】
 *   那份用**脚本化 mock client**（每个 SQL 预设返回值），只能证明"路由按预期调了某条 SQL"，
 *   证明不了"这条 SQL 在真库上真的把数据写进去了、下一步真能读出来"。
 *   本文件把 DB 层换成 **PGlite 真库**（真 DDL、真 INSERT/SELECT、真主键冲突、真回滚），
 *   只把连接池换掉；于是「建岗 → 配权 → 建号 → 停用后不可再分」是一条**真跑通的链**，
 *   而不是四段各自 mock 的片段。
 *
 * 【诚实边界】
 *   - PGlite 是单用户嵌入式 PG，**没有 youfu_app 角色，也没有 RLS policy**。
 *     故 withTenantClient 里的 `SET LOCAL ROLE youfu_app` / `SET LOCAL app.tenant_id`
 *     被拦截忽略；表结构除 RLS / GRANT 外与 007/046/090 真 DDL 逐字一致。
 *     ⇒ 本文件**不能**证明租户隔离（那条归 roleDefContract.test.ts 的 RLS 扫描），
 *       租户隔离由本套件的另一条用例（跨租户 SQL 断言）覆盖。
 *   - audit 写 platform_audit 失败只 warn 不阻断，故 audit 不在断言范围内。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

const T = 't-fullchain';
const CUSTOM = 'repair_lead';

// ---- PGlite 真库：vi.mock 内不能直接引用外部变量，用 hoisted 容器搬运 ----
const box = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('@electric-sql/pglite', async () => {
  const actual = (await vi.importActual('@electric-sql/pglite')) as { PGlite: new () => unknown };
  return { ...actual, PGlite: class extends (actual.PGlite as any) {} };
});

vi.mock('../db/pool.js', () => ({
  default: {
    // audit() 走 pool.query；本文件不断言审计，给个安全的空实现即可
    query: async () => ({ rows: [], rowCount: 0 }),
  },
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tenantId: string, fn: (client: unknown) => Promise<unknown>) => {
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        const s = String(sql);
        // PGlite 单用户：无 youfu_app 角色，SET LOCAL ROLE 会报错；
        // app.tenant_id 在 PGlite 里没有 RLS 消费方，一并忽略（不影响被测语义）。
        if (/^\s*SET\s+LOCAL\s+(ROLE|app\.)/i.test(s)) return { rows: [], rowCount: 0 };
        return (box.db as { query: (a: string, b: unknown[]) => Promise<unknown> }).query(s, params);
      },
    };
    return fn(client);
  },
}));

import { PGlite } from '@electric-sql/pglite';
import accountsRouter from '../routes/accounts.js';

let server: Server;
let base = '';

/** 与 007 / 046 / 090 真 DDL 逐字一致，仅剔除 RLS / GRANT / 依赖 youfu_app 的部分。 */
const DDL = `
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
-- 046 的 role IN (...) 枚举 CHECK 已被 095 撤销（自定义岗位要能配权限），故此处不带 CHECK
CREATE TABLE role_permission (
  tenant_id  text NOT NULL,
  role       text NOT NULL,
  perm       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, role, perm)
);
-- 007 的 role IN ('admin','operator') 已被 090 放宽，故此处不带 CHECK
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
  phone          text,                       -- 082_account_phone.sql:9 追加
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
  box.db = new PGlite();
  await (box.db as unknown as { exec: (s: string) => Promise<void> }).exec(DDL);

  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = {
      tenantId: T,
      role: 'admin',
      authMode: 'prod',
      userId: 'u-admin',
      username: 'admin-a',
      requestId: 'test',
    };
    next();
  });
  app.use('/api/v1', accountsRouter);
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
  // PGlite 的 query() 走 prepared statement，不支持多语句；逐条清空
  for (const t of ['account_user', 'role_permission', 'role_def']) {
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

describe('非代码级可配置 —— HTTP 全链路（真路由 + 真库）', () => {
  it('① 建岗：POST /accounts/roles → role_def 真落一行', async () => {
    const r = await call('POST', '/accounts/roles', { code: CUSTOM, name: '维修组长' });
    expect(r.status).toBe(200);
    const got = await rows(`SELECT tenant_id, code, name, enabled FROM role_def`);
    expect(got).toEqual([{ tenant_id: T, code: CUSTOM, name: '维修组长', enabled: true }]);
  });

  it('② 配权：PUT /accounts/roles/:role/permissions → role_permission 真落一行', async () => {
    await call('POST', '/accounts/roles', { code: CUSTOM, name: '维修组长' });
    const r = await call('PUT', `/accounts/roles/${CUSTOM}/permissions`, {
      perms: ['workflow.approve'],
    });
    expect(r.status).toBe(200);
    const got = await rows(`SELECT role, perm FROM role_permission WHERE tenant_id=$1`, [T]);
    expect(got).toEqual([{ role: CUSTOM, perm: 'workflow.approve' }]);
  });

  it('③ 建号：POST /accounts 用自定义岗位 → account_user.role 真的是自定义岗位', async () => {
    await call('POST', '/accounts/roles', { code: CUSTOM, name: '维修组长' });
    const r = await call('POST', '/accounts', {
      username: 'laowang',
      password: 'abc123456',
      display_name: '老王',
      role: CUSTOM,
    });
    expect(r.status).toBe(201);
    const got = await rows(
      `SELECT username, role, display_name, active FROM account_user WHERE tenant_id=$1`,
      [T],
    );
    expect(got).toEqual([
      { username: 'laowang', role: CUSTOM, display_name: '老王', active: true },
    ]);
    // 密码必须落哈希，绝不落明文
    const ph = await rows(`SELECT password_hash FROM account_user WHERE username='laowang'`);
    expect(String((ph[0] as { password_hash: string }).password_hash)).not.toContain('abc123456');
  });

  it('④ 下拉：GET /accounts/roles 之后新建的岗位出现在可选项里', async () => {
    await call('POST', '/accounts/roles', { code: CUSTOM, name: '维修组长' });
    const r = await call('GET', '/accounts/roles');
    expect(r.status).toBe(200);
    const items = (r.body as { items?: { code: string }[] }).items ?? [];
    expect(items.some((x) => x.code === CUSTOM)).toBe(true);
  });

  it('⑤ 反向护栏：用不存在的岗位建号 → 400 unknown role（防凭空造岗）', async () => {
    const r = await call('POST', '/accounts', {
      username: 'zhangsan',
      password: 'abc123456',
      role: 'ghost_role',
    });
    expect(r.status).toBe(400);
    expect(String((r.body as { message?: string }).message)).toMatch(/unknown role/);
    const n = await rows(`SELECT count(*)::int AS n FROM account_user`);
    expect((n[0] as { n: number }).n).toBe(0);
  });

  it('⑥ 停用后不可再分配：PATCH enabled=false → 建号 400，但存量账号不动', async () => {
    await call('POST', '/accounts/roles', { code: CUSTOM, name: '维修组长' });
    await call('POST', '/accounts', {
      username: 'laowang',
      password: 'abc123456',
      role: CUSTOM,
    });

    const p = await call('PATCH', `/accounts/roles/${CUSTOM}`, { enabled: false });
    expect(p.status).toBe(200);

    const r = await call('POST', '/accounts', {
      username: 'lisi',
      password: 'abc123456',
      role: CUSTOM,
    });
    expect(r.status).toBe(400);
    expect(String((r.body as { message?: string }).message)).toMatch(/unknown role/);

    // 存量账号一个不动（下拉不可见 ≠ 存量被清理）
    const got = await rows(`SELECT username, role, active FROM account_user WHERE tenant_id=$1`, [
      T,
    ]);
    expect(got).toEqual([{ username: 'laowang', role: CUSTOM, active: true }]);
  });

  it('🔴 全链路：建岗 → 配权 → 建号 → 停用 → 新号被拒（存量不动）', async () => {
    // 1) 建岗
    expect((await call('POST', '/accounts/roles', { code: CUSTOM, name: '维修组长' })).status).toBe(
      200,
    );
    // 2) 配权
    expect(
      (await call('PUT', `/accounts/roles/${CUSTOM}/permissions`, { perms: ['workflow.approve'] }))
        .status,
    ).toBe(200);
    // 3) 建号
    expect(
      (
        await call('POST', '/accounts', {
          username: 'laowang',
          password: 'abc123456',
          role: CUSTOM,
        })
      ).status,
    ).toBe(201);
    // 4) 停用
    expect((await call('PATCH', `/accounts/roles/${CUSTOM}`, { enabled: false })).status).toBe(200);
    // 5) 新号被拒
    expect(
      (await call('POST', '/accounts', { username: 'lisi', password: 'abc123456', role: CUSTOM }))
        .status,
    ).toBe(400);
    // 6) 存量与权限行都还在
    const acc = await rows(`SELECT count(*)::int AS n FROM account_user WHERE role=$1`, [CUSTOM]);
    expect((acc[0] as { n: number }).n).toBe(1);
    const perm = await rows(`SELECT count(*)::int AS n FROM role_permission WHERE role=$1`, [
      CUSTOM,
    ]);
    expect((perm[0] as { n: number }).n).toBe(1);
  });
});
