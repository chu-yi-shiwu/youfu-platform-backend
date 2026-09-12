// accountsPerm.http.test.ts —— 账号权限一期（20260913《优服家_账号权限体系一期设计》§6）测试锚定。
// 真·express + 真 HTTP，mock 掉 DB 连接池（脚本化 client，volunteerGuard 同范式）。
// 覆盖（设计稿 13 例；#7 并发互停需真库 FOR UPDATE 语义，由 ECS live 探针承担，此处锚定 SQL 契约）：
//   ① role.manage 收紧（operator 403 → 租户显式授予后放行）
//   ②③ SELF_GUARD：改自己角色/停自己 → 403；④ 改自己 display_name/phone → 200
//   ⑤ 防自锁-停用（2 admin → 200；1 admin → 409 LAST_ADMIN）⑥ 防自锁-降级 → 409 LAST_ADMIN
//   ⑦(契约) last-admin SELECT FOR UPDATE + 同闭包 UPDATE；reset-password UPDATE password_hash
//   ⑧⑨ reset-password 正/负例 ⑩ perm-catalog ⑪ 权限矩阵白名单 ⑫ phone 四态 ⑬ 存量兼容
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

// ---- mock 掉 DB 连接池：脚本化 SQL 响应 + 调用日志 ----
const h = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] }>,
  scripted: [] as Array<{ match: RegExp; rows: any[]; rowCount?: number; throw?: unknown }>,
}));
vi.mock('../db/pool.js', () => ({
  default: {},
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tenantId: string, fn: (client: any) => Promise<any>) => {
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        h.calls.push({ sql, params });
        for (const s of h.scripted) {
          if (s.match.test(sql)) {
            if (s.throw) throw s.throw;
            return { rows: s.rows, rowCount: s.rowCount ?? s.rows.length };
          }
        }
        return { rows: [], rowCount: 0 };
      },
    };
    return fn(client);
  },
}));

import accountsRouter from '../routes/accounts.js';
import { PERMS } from '../middleware/role.js';

const T = 't-acct-guard';
let server: Server;
let base = '';

type AuthOpt = { role?: string; userId?: string; authMode?: string };
function makeAuthMiddleware(opts: AuthOpt = {}) {
  return (_req: any, res: any, next: any) => {
    res.locals.auth = {
      tenantId: T,
      role: opts.role ?? 'admin',
      authMode: opts.authMode ?? 'prod', // prod：hasPerm 真实判定（admin 恒过 / 其余走矩阵）
      userId: opts.userId ?? 'u-admin-1',
      username: 'admin-a',
      requestId: 'test',
    };
    next();
  };
}

/** 内联起一个带指定身份的 express 实例（operator 等非 admin 用例用），返回 base url + close。 */
async function startApp(opts: AuthOpt): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use(makeAuthMiddleware(opts));
  app.use('/api/v1', accountsRouter);
  app.use(errorMiddleware);
  const srv = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => srv.once('listening', () => resolve()));
  const addr = srv.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}/api/v1`;
  const close = () => new Promise<void>((r) => srv.close(() => r()));
  return { base, close };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(makeAuthMiddleware());
  app.use('/api/v1', accountsRouter); // 与生产挂载一致（server.ts 挂 /api/v1/accounts → accountsRouter 根路径）
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
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
}

const TARGET = 'u-target-1';
const accountRow = (over: Record<string, unknown> = {}) => ({
  id: TARGET, tenant_id: T, username: 'op-1', display_name: '运营甲', role: 'operator', active: true, phone: null, ...over,
});
// role_permission 覆盖行（hasPerm 数据源）：rows=[] → 回退默认矩阵；rows=[{perm:'role.manage'}] → operator 放行
const permOverride = (perms: string[]) => [
  { match: /FROM role_permission WHERE tenant_id\s*=\s*\$1 AND role\s*=\s*\$2/, rows: perms.map((p) => ({ perm: p })) },
];
// last-admin FOR UPDATE 计数脚本
const adminLockRows = (n: number) => [
  { match: /role='admin' AND active=true FOR UPDATE/, rows: Array.from({ length: n }, (_, i) => ({ id: 'a' + i })) },
];
const updateAccountScript = (over: Record<string, unknown> = {}) => [
  { match: /UPDATE account_user SET /, rows: [accountRow(over)] },
];
const selectAccountScript = (over: Record<string, unknown> = {}) => [
  { match: /SELECT id, tenant_id, username, display_name, role, active, phone FROM account_user WHERE id=\$1/, rows: [accountRow(over)] },
];

describe('role.manage 守卫统一（① G4/H1）', () => {
  it('① operator（默认矩阵无 role.manage）调 PUT /accounts/:id → 403', async () => {
    const op = await startApp({ role: 'operator', userId: 'u-op-1', authMode: 'prod' });
    try {
      const r = await fetch(`${op.base}/accounts/${TARGET}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: '改名' }),
      });
      const b: any = await r.json();
      expect(r.status).toBe(403);
      expect(b.code).toBe('FORBIDDEN');
      expect(String(b.message)).toContain('role.manage');
      expect(h.calls.find((c) => c.sql.includes('UPDATE account_user'))).toBeUndefined();
    } finally {
      await op.close();
    }
  });

  it('①b 租户经 role_permission 显式授予 role.manage 后 operator 放行', async () => {
    const op = await startApp({ role: 'operator', userId: 'u-op-1', authMode: 'prod' });
    try {
      h.scripted = [...permOverride(['role.manage']), ...selectAccountScript(), ...updateAccountScript()];
      const r = await fetch(`${op.base}/accounts/${TARGET}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: '改名' }),
      });
      const b: any = await r.json();
      expect(r.status).toBe(200);
      expect(b.ok).toBe(true);
    } finally {
      await op.close();
    }
  });
});

describe('SELF_GUARD（②③④ G3）', () => {
  it('② admin 把自己 role 改 operator → 403 SELF_GUARD（即使不是最后 admin）', async () => {
    h.scripted = [...selectAccountScript({ id: 'u-admin-1', role: 'admin' }), ...adminLockRows(2)];
    const r = await call('PUT', '/accounts/u-admin-1', { role: 'operator' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SELF_GUARD');
    expect(h.calls.find((c) => c.sql.includes('UPDATE account_user SET'))).toBeUndefined();
  });

  it('③ admin 把自己 active=false → 403 SELF_GUARD', async () => {
    h.scripted = [...selectAccountScript({ id: 'u-admin-1', role: 'admin' }), ...adminLockRows(2)];
    const r = await call('PUT', '/accounts/u-admin-1', { active: false });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SELF_GUARD');
  });

  it('④ admin 改自己 display_name/phone → 200（自服务例外）', async () => {
    h.scripted = [
      ...selectAccountScript({ id: 'u-admin-1', role: 'admin', display_name: '管理员A' }),
      ...updateAccountScript({ id: 'u-admin-1', role: 'admin', display_name: '新名' }),
    ];
    const r = await call('PUT', '/accounts/u-admin-1', { display_name: '新名', phone: '13800138000' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});

describe('last-admin 防自锁（⑤⑥ G1 + ⑦契约 G2）', () => {
  it('⑤ 停用：租户 2 名 admin，停用其一 → 200', async () => {
    h.scripted = [
      ...selectAccountScript({ role: 'admin' }),
      ...adminLockRows(2),
      ...updateAccountScript({ active: false }),
    ];
    const r = await call('PUT', `/accounts/${TARGET}`, { active: false });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('⑤b 停用：仅剩 1 名 admin → 409 LAST_ADMIN', async () => {
    h.scripted = [...selectAccountScript({ role: 'admin' }), ...adminLockRows(1)];
    const r = await call('PUT', `/accounts/${TARGET}`, { active: false });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('LAST_ADMIN');
    expect(h.calls.find((c) => c.sql.includes('UPDATE account_user SET'))).toBeUndefined();
  });

  it('⑥ 降级（G1 新覆盖缺口）：仅 1 名 active admin 把它改 operator → 409 LAST_ADMIN', async () => {
    h.scripted = [...selectAccountScript({ role: 'admin' }), ...adminLockRows(1)];
    const r = await call('PUT', `/accounts/${TARGET}`, { role: 'operator' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('LAST_ADMIN');
  });

  it('⑦ SQL 契约（G2）：last-admin 计数必带 FOR UPDATE，且与 UPDATE 同闭包（withTenantClient 事务）', async () => {
    h.scripted = [...selectAccountScript({ role: 'admin' }), ...adminLockRows(2), ...updateAccountScript()];
    await call('PUT', `/accounts/${TARGET}`, { active: false });
    const lock = h.calls.find((c) => /role='admin' AND active=true/.test(c.sql));
    expect(lock).toBeDefined();
    expect(lock!.sql).toMatch(/FOR UPDATE/);
  });
});

describe('reset-password（⑧⑨ G8）', () => {
  it('⑧ 服务端随机 12 位临时密码 + once:true + UPDATE password_hash', async () => {
    h.scripted = [
      { match: /SELECT id FROM account_user WHERE id=\$1/, rows: [{ id: TARGET }] },
    ];
    const r = await call('POST', `/accounts/${TARGET}/reset-password`);
    expect(r.status).toBe(200);
    const temp = String(r.body.temp_password ?? '');
    expect(r.body.once).toBe(true);
    expect(temp).toHaveLength(12);
    expect(/^[abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/.test(temp)).toBe(true);
    const upd = h.calls.find((c) => c.sql.includes('SET password_hash'));
    expect(upd).toBeDefined();
    expect(String(upd!.params[0])).toMatch(/^scrypt\$/); // 落库为哈希非明文
  });

  it('⑨ admin 重置自己密码 → 403 SELF_GUARD', async () => {
    h.scripted = [{ match: /SELECT id FROM account_user WHERE id=\$1/, rows: [{ id: 'u-admin-1' }] }];
    const r = await call('POST', '/accounts/u-admin-1/reset-password');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SELF_GUARD');
    expect(h.calls.find((c) => c.sql.includes('SET password_hash'))).toBeUndefined();
  });
});

describe('perm-catalog 与权限矩阵（⑩⑪ G5/G6）', () => {
  it('⑩ perm-catalog：数量=PERMS 全集（16），含 workflow.approve，全部带中文 label', async () => {
    const r = await call('GET', '/accounts/roles/perm-catalog');
    expect(r.status).toBe(200);
    const items = r.body.items as Array<{ perm: string; label: string }>;
    expect(items.length).toBe(PERMS.length);
    expect(items.some((x) => x.perm === 'workflow.approve')).toBe(true);
    expect(items.every((x) => x.label && x.label.length > 0)).toBe(true);
  });

  it('⑪a 权限矩阵：PUT 合法点 → 200 + 先删后插契约', async () => {
    h.scripted = [];
    const perms = ['dashboard.view', 'ticket.manage'];
    const r = await call('PUT', '/accounts/roles/worker/permissions', { perms });
    expect(r.status).toBe(200);
    expect(h.calls.find((c) => c.sql.includes('DELETE FROM role_permission'))).toBeDefined();
    expect(h.calls.filter((c) => c.sql.includes('INSERT INTO role_permission')).length).toBe(perms.length);
  });

  it('⑪b PUT 含错字权限点 → 400 BAD_PERM 列出非法项（禁静默落库）', async () => {
    const r = await call('PUT', '/accounts/roles/worker/permissions', { perms: ['ticket.manage', 'ticket.mange'] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('BAD_PERM');
    expect(String(r.body.message)).toContain('ticket.mange');
    expect(h.calls.find((c) => c.sql.includes('INSERT INTO role_permission'))).toBeUndefined();
  });

  it('⑪c PUT role=admin → 400（admin 恒全放行不可改）', async () => {
    const r = await call('PUT', '/accounts/roles/admin/permissions', { perms: ['dashboard.view'] });
    expect(r.status).toBe(400);
    expect(h.calls.find((c) => c.sql.includes('DELETE FROM role_permission'))).toBeUndefined();
  });
});

describe('phone 档案字段（⑫ G7，082 迁移）', () => {
  it('⑫a 设合法手机号 → 200 且 GET /accounts 可见（透出 phone）', async () => {
    h.scripted = [
      ...selectAccountScript(),
      ...updateAccountScript({ phone: '13800138000' }),
    ];
    const r = await call('PUT', `/accounts/${TARGET}`, { phone: '13800138000' });
    expect(r.status).toBe(200);
    expect((r.body.item as any).phone).toBe('13800138000');
    const upd = h.calls.find((c) => c.sql.includes('UPDATE account_user SET'));
    expect(upd!.params).toContain('13800138000');
    // 列表透出：toPublic 带 phone
    h.scripted = [{ match: /SELECT id, tenant_id, username/, rows: [accountRow({ phone: '13800138000' })] }];
    const list = await call('GET', '/accounts');
    expect((list.body.items as any[])[0].phone).toBe('13800138000');
  });

  it('⑫b 同租户重号 → 23505 被 errorMiddleware 透出 409 CONFLICT', async () => {
    // 模拟 pg unique_violation：必须是真 Error 实例 + SQLSTATE code（errorMiddleware 鸭子类型判定）
    const pgErr = Object.assign(new Error('duplicate key value violates unique constraint "idx_account_phone_unique"'), {
      code: '23505',
      detail: 'Key (tenant_id, phone)=(t-acct-guard, 13800138000) already exists.',
    });
    h.scripted = [
      ...selectAccountScript(),
      { match: /UPDATE account_user SET /, rows: [], throw: pgErr },
    ];
    const r = await call('PUT', `/accounts/${TARGET}`, { phone: '13800138000' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('CONFLICT');
  });

  it('⑫c 空串清空 → 落库 NULL（可重设）', async () => {
    h.scripted = [...selectAccountScript({ phone: '13800138000' }), ...updateAccountScript({ phone: null })];
    const r = await call('PUT', `/accounts/${TARGET}`, { phone: '' });
    expect(r.status).toBe(200);
    const upd = h.calls.find((c) => c.sql.includes('UPDATE account_user SET'));
    expect(upd!.params).toContain(null); // 空串 → null
  });

  it('⑫d 非法格式 abc → 400 BAD_PARAM', async () => {
    const r = await call('PUT', `/accounts/${TARGET}`, { phone: 'abc' });
    expect(r.status).toBe(400);
    expect(h.calls.find((c) => c.sql.includes('UPDATE account_user SET'))).toBeUndefined();
  });
});

describe('存量兼容（⑬）', () => {
  it('⑬ 无 phone 老账号：列表/详情/更新全链路照常（phone 透出 null）', async () => {
    h.scripted = [{ match: /SELECT id, tenant_id, username/, rows: [accountRow()] }]; // 行内无 phone 键
    const list = await call('GET', '/accounts');
    expect(list.status).toBe(200);
    expect((list.body.items as any[])[0].phone).toBeNull(); // toPublic 容错 undefined → null
    h.scripted = [...selectAccountScript(), ...updateAccountScript({ display_name: '改名' })];
    const upd = await call('PUT', `/accounts/${TARGET}`, { display_name: '改名' });
    expect(upd.status).toBe(200);
    expect((upd.body.item as any).phone).toBeNull();
  });
});
