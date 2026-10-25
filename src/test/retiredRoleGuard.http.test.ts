// retiredRoleGuard.http.test.ts —— 地基第二步补漏②：退场角色的**入口层**闸门。
//
// 【为什么有这个文件】2026-10-17 二轮审查实测发现：isRoleUsable（退场角色唯一闸门）全库
// 只有 4 个调用点（accounts.ts:178/424/469 + invite.ts:282），而两条**写角色**的 HTTP 入口
// 根本没装闸门：
//   - POST /invites    （invite.ts:95-125，只有 inviteCreateSchema.parse，role 仅过 ROLE_CODE_RE）
//   - POST /auth/users （auth.ts:177-190，只有 createUserSchema.parse，role 仅过 ROLE_CODE_RE）
// ⇒ 用户要求①「dispatcher / service_desk 拿掉」在系统入口层并未成立：任何 API 调用方仍能
//   建出退场角色账号（201 OK）。而既有的 retiredRoles.test.ts 全是**常量级断言**（清单对不对、
//   ASSIGNABLE_BUILTIN_ROLES 是否 4 个、模板边有无残边）——测的是"我们把常量改对了"，
//   不是"从 HTTP 入口还能不能建出来"。本文件把后者钉死。
//
// 【配套的真实危害（C1 静默扩权，本文件第 6 例守住不回归）】
//   邀请码带着 role='dispatcher' 建出来（201，页面显示「调度人员」）→ 受邀人兑换时
//   invite.ts:282 `isRoleUsable ? invite.role : 'operator'` 静默 fallback 成 operator。
//   dispatcher 5 个权限点 vs operator 11 个 → **意图是拿掉，实际是静默生成权限更多的账号**。
//
// 【设计决策：为什么不新增错误码】
//   accounts.ts:425/470 对同一类错误（角色不可用）已用 `BAD_PARAM` + `unknown role: ${role}`。
//   这里**沿用同一码**，只把 message 写清楚（"该岗位已退场…"），避免前端为同一类错误多处理一个码。
//
// 范式：真 express + 真 HTTP，mock 掉 DB 连接池（与 roleDefCrud.http.test.ts 同款脚本化 client）。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

const h = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] }>,
  scripted: [] as Array<{ match: RegExp; rows: any[]; rowCount?: number }>,
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

import inviteRouter from '../routes/invite.js';
import authRouter from '../routes/auth.js';

const T = 't-guard';
let server: Server;
let base = '';

/** 注入管理员身份：两条路由都从 res.locals.auth 取调用者（invite.ts:80 / auth.ts:178）。 */
function makeAuthMiddleware(role = 'admin') {
  return (_req: any, res: any, next: any) => {
    res.locals.auth = {
      tenantId: T,
      role,
      authMode: 'prod',
      userId: 'u-caller',
      username: 'admin',
    };
    next();
  };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(makeAuthMiddleware());
  // 两个 router 内部自带完整前缀（invite.ts:93 `/invites`、auth.ts:177 `/auth/users`），故挂到根。
  app.use(inviteRouter);
  app.use(authRouter);
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
  // 不重名（findUserByUsername 返回空）→ 放行到 INSERT
  h.scripted.push({ match: /SELECT 1 FROM account_user WHERE tenant_id=\$1 AND username=\$2/i, rows: [], rowCount: 0 });
  // 邀请码 INSERT 成功
  h.scripted.push({
    match: /INSERT INTO invite_codes/i,
    rows: [{ id: 'i-1', username: 'u1', display_name: null, role: 'worker', expires_at: '2999-01-01', created_at: 'now' }],
    rowCount: 1,
  });
  // 建账号 INSERT 成功
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

const inviteBody = (role: string) => ({ username: 'u1', display_name: '某人', role });
const userBody = (role: string) => ({ username: 'u1', password: 'abcd1234', role });

describe('退场角色的入口层闸门（POST /invites、POST /auth/users）', () => {
  it('甲·dispatcher 邀请码必须被拒（此前 201 放行 → 入口没关门）', async () => {
    const r = await post('/invites', inviteBody('dispatcher'));
    expect(r.status).toBe(400);
    expect(r.json.ok).toBe(false);
    // 与 accounts.ts:425/470 同码，前端无需新增分支
    expect(r.json.code).toBe('BAD_PARAM');
    expect(String(r.json.message)).toContain('dispatcher');
  });

  it('甲·service_desk 邀请码必须被拒', async () => {
    const r = await post('/invites', inviteBody('service_desk'));
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('BAD_PARAM');
  });

  it('甲·dispatcher 直建账号必须被拒（POST /auth/users）', async () => {
    const r = await post('/auth/users', userBody('dispatcher'));
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('BAD_PARAM');
    expect(String(r.json.message)).toContain('dispatcher');
  });

  it('甲·service_desk 直建账号必须被拒（POST /auth/users）', async () => {
    const r = await post('/auth/users', userBody('service_desk'));
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('BAD_PARAM');
  });

  it('乙·对照组：未退场内置角色照常放行（不能误伤）', async () => {
    const a = await post('/invites', inviteBody('worker'));
    expect(a.status).toBe(201);
    expect(a.json.ok).toBe(true);

    const b = await post('/auth/users', userBody('reviewer'));
    expect(b.status).toBe(201);
    expect(b.json.ok).toBe(true);
  });

  it('乙·对照组：不带 role 走默认 operator，照常放行', async () => {
    const a = await post('/invites', { username: 'u1' });
    expect(a.status).toBe(201);
    const b = await post('/auth/users', { username: 'u1', password: 'abcd1234' });
    expect(b.status).toBe(201);
  });

  it('丙·闸门装在写入前：退场角色不得产生任何 INSERT（静默落库的根因）', async () => {
    h.calls.length = 0;
    await post('/invites', inviteBody('dispatcher'));
    const sqlAll = h.calls.map((c) => c.sql).join('\n');
    expect(sqlAll).not.toMatch(/INSERT INTO invite_codes/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T8 第十六批：账号与邀请端点守卫收敛（requireRole 硬编码 admin ⇒ role.manage）
//
// 借本文件的理由：它**同时挂了 inviteRouter 与 authRouter**，且已有脚本化 client、
// `makeAuthMiddleware(role)` 可注入任意角色、`authMode:'prod'`（requirePermission 在 dev
// 恒放行 ⇒ dev 下 403 断言是恒绿的假绿）。
// ═══════════════════════════════════════════════════════════════════════════
describe('T8 第十六批 · 账号端点权限可配置（B 组：改前必红，改后转绿）', () => {
  /** 用指定角色 + 指定授权另起一个 app（本文件主 app 固定是 admin）。 */
  async function withRole(role: string, permRows: any[], fn: (post: (p: string, b: unknown) => Promise<any>) => Promise<void>) {
    const app = express();
    app.use(express.json());
    app.use(makeAuthMiddleware(role));
    app.use(inviteRouter);
    app.use(authRouter);
    app.use(errorMiddleware);
    const s = app.listen(0);
    await new Promise<void>((r) => s.once('listening', () => r()));
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    h.calls.length = 0;
    // 🔴 **不要清空 h.scripted**：beforeEach 已注入「不重名 / INSERT 成功」三条基础脚本，
    //    清掉会让建账号走到空结果 ⇒ 500（我第一版就是这么写的，得到 expected 500 to be 201）。
    if (permRows.length) h.scripted.push({ match: /role_permission/i, rows: permRows, rowCount: permRows.length });
    try {
      await fn(async (path, body) => {
        const r = await fetch(`${b}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
      });
    } finally {
      await new Promise<void>((r) => s.close(() => r()));
    }
  }

  it('授 role.manage 给 reviewer ⇒ POST /auth/users 201（改前必红）', async () => {
    await withRole('reviewer', [{ perm: 'role.manage' }], async (post) => {
      // 改前：requireRole(auth,'admin') 只读角色、**不查权限表** ⇒ 授了也 403（RED）。改后转绿。
      const r = await post('/auth/users', userBody('worker'));
      expect(r.status).toBe(201);
    });
  });

  it('授 role.manage 给 reviewer ⇒ POST /invites 201（改前必红）', async () => {
    await withRole('reviewer', [{ perm: 'role.manage' }], async (post) => {
      const r = await post('/invites', inviteBody('worker'));
      expect(r.status).toBe(201);
    });
  });

  it('反例锚：不授 role.manage ⇒ reviewer 建账号/邀请仍 403（等价性不破坏）', async () => {
    await withRole('reviewer', [], async (post) => {
      const a = await post('/auth/users', userBody('worker'));
      expect(a.status).toBe(403);
      const b = await post('/invites', inviteBody('worker'));
      expect(b.status).toBe(403);
    });
  });

  it('等价性锚：worker 未授权 ⇒ 403；admin 未授权也放行（role.manage 仅 admin 默认）', async () => {
    await withRole('worker', [], async (post) => {
      expect((await post('/auth/users', userBody('worker'))).status).toBe(403);
    });
    await withRole('admin', [], async (post) => {
      expect((await post('/auth/users', userBody('worker'))).status).toBe(201);
    });
  });
});
