// invite.http.test.ts —— 八件增量 BE-1：邀请码域 HTTP 测试。
// 真·express + 真 HTTP（对齐 transportGuard.http.test.ts 范式），mock 掉 DB 连接池（脚本化 client）。
// 覆盖：
//   ① admin 生成码成功：201、明文码格式 YF-xxxx-xxxx-xxxx、落库为 HMAC 哈希（非明文）
//   ② 生成码 username 与 account_user 重名 → 409 USER_EXISTS
//   ③ 重发语义：同 username 再生成 → 先 UPDATE revoked_at 作废旧码，再 INSERT 新码
//   ④ 列表不回明文码/哈希，状态派生（active/used/revoked/expired）
//   ⑤ 作废成功 + 不存在/已作废 → 404 INVITE_404
//   ⑥ redeem 成功：事务内建号（scrypt 哈希）+ 置 used_at + 签发 token（tid 正确）
//   ⑦ redeem 二次用同码 → 400 INVITE_INVALID（防枚举统一文案）
//   ⑧ redeem 过期码 → 400 INVITE_INVALID（文案与⑦一致）
//   ⑨ redeem 篡改/未知码 → 400 INVITE_INVALID（文案与⑦一致）
//   ⑩ redeem 弱密码 → 422
//   ⑪ 并发双花兜底：事务内 UPDATE used_at 守卫 0 行 → 400 INVITE_INVALID
//   ⑫ 非 admin 生成码 → 403
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

// ---- mock 掉 DB 连接池：脚本化 SQL 响应 + 调用日志（pool.query 与事务 client 同池脚本） ----
const h = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] }>,
  scripted: [] as Array<{ match: RegExp; rows: any[]; rowCount?: number }>,
  reset: () => {
    h.calls.length = 0;
    h.scripted.length = 0;
  },
  script: (match: RegExp, rows: any[], rowCount?: number) =>
    h.scripted.push({ match, rows, rowCount }),
}));

vi.mock('../db/pool.js', () => {
  const scriptedQuery = async (sql: string, params: unknown[] = []) => {
    h.calls.push({ sql, params });
    for (const s of h.scripted) {
      if (s.match.test(sql)) return { rows: s.rows, rowCount: s.rowCount ?? s.rows.length };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    default: { query: scriptedQuery },
    assertSafeTenantId: (t: string) => t,
    withTenantClient: async (_tenantId: string, fn: (client: any) => Promise<any>) =>
      fn({ query: scriptedQuery }),
  };
});

import inviteRouter, { hmacInviteCode } from '../routes/invite.js';

const T = 't-invite-test';
let server: Server;
let base = '';

function injectAuth(role: string) {
  return (_req: any, res: any, next: any) => {
    res.locals.auth = {
      tenantId: T, role, authMode: 'prod', userId: 'u-1', username: 'root', requestId: 'test',
    };
    next();
  };
}

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-invite-secret';
  const app = express();
  app.use(express.json());
  app.use('/api/v1', injectAuth('admin'), inviteRouter);
  app.use(errorMiddleware);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('邀请码 admin 端点（生成/列表/作废）', () => {
  it('① admin 生成码 → 201，明文码格式正确且落库为 HMAC 哈希（非明文）', async () => {
    h.reset();
    h.script(/FROM account_user/, []); // 用户名不重名
    h.script(/INSERT INTO invite_codes/, [{ id: 'inv-1', username: 'wangwu', display_name: null, role: 'operator', expires_at: new Date(Date.now() + 3600e3).toISOString(), created_at: new Date().toISOString() }]);
    const r = await fetch(`${base}/api/v1/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'wangwu', display_name: '王五' }),
    });
    expect(r.status).toBe(201);
    const j = (await r.json()) as any;
    expect(j.invite.code).toMatch(/^YF-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(j.invite.username).toBe('wangwu');
    const ins = h.calls.find((c) => /INSERT INTO invite_codes/.test(c.sql))!;
    expect(ins.params[1]).toBe(hmacInviteCode(j.invite.code)); // 落库 = HMAC(code)
    expect(ins.params[1]).not.toContain(j.invite.code); // 绝不存明文
    expect(j.invite.expires_at).toBeTruthy();
  });

  it('② username 与 account_user 重名 → 409 USER_EXISTS', async () => {
    h.reset();
    h.script(/FROM account_user/, [{ id: 'u-9' }]);
    const r = await fetch(`${base}/api/v1/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'zhangsan' }),
    });
    expect(r.status).toBe(409);
    const j = (await r.json()) as any;
    expect(j.code).toBe('USER_EXISTS');
  });

  it('③ 重发语义：同 username 再生成 → 先作废旧码（UPDATE revoked_at）再 INSERT', async () => {
    h.reset();
    h.script(/FROM account_user/, []);
    h.script(/UPDATE invite_codes SET revoked_at/, []);
    h.script(/INSERT INTO invite_codes/, [{ id: 'inv-2', username: 'lisi', role: 'operator', expires_at: new Date(Date.now() + 3600e3).toISOString(), created_at: new Date().toISOString() }]);
    const r = await fetch(`${base}/api/v1/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'lisi' }),
    });
    expect(r.status).toBe(201);
    const revokeIdx = h.calls.findIndex((c) => /UPDATE invite_codes SET revoked_at/.test(c.sql));
    const insertIdx = h.calls.findIndex((c) => /INSERT INTO invite_codes/.test(c.sql));
    expect(revokeIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(revokeIdx); // 作废先于新建
    const revoke = h.calls[revokeIdx];
    expect(revoke.params).toContain(T);
    expect(revoke.params).toContain('lisi');
  });

  it('④ 列表不回明文码/哈希，状态派生正确', async () => {
    h.reset();
    const now = Date.now();
    h.script(/FROM invite_codes/, [
      { id: 'a', username: 'u1', role: 'operator', created_by: 'root', expires_at: new Date(now + 3600e3).toISOString(), used_at: null, revoked_at: null, created_at: new Date(now).toISOString() },
      { id: 'b', username: 'u2', role: 'operator', created_by: 'root', expires_at: new Date(now + 3600e3).toISOString(), used_at: new Date(now).toISOString(), revoked_at: null, created_at: new Date(now).toISOString() },
      { id: 'c', username: 'u3', role: 'operator', created_by: 'root', expires_at: new Date(now + 3600e3).toISOString(), used_at: null, revoked_at: new Date(now).toISOString(), created_at: new Date(now).toISOString() },
      { id: 'd', username: 'u4', role: 'operator', created_by: 'root', expires_at: new Date(now - 3600e3).toISOString(), used_at: null, revoked_at: null, created_at: new Date(now).toISOString() },
    ]);
    const r = await fetch(`${base}/api/v1/invites`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.items.map((x: any) => x.status)).toEqual(['active', 'used', 'revoked', 'expired']);
    for (const item of j.items) {
      expect(item.code).toBeUndefined();
      expect(item.code_hash).toBeUndefined();
    }
  });

  it('⑤ 作废：成功返回 item；不存在/已作废 → 404 INVITE_404', async () => {
    h.reset();
    h.script(/UPDATE invite_codes SET revoked_at/, [{ id: 'inv-5', username: 'u5' }]);
    const ok = await fetch(`${base}/api/v1/invites/11111111-1111-1111-1111-111111111111`, { method: 'DELETE' });
    expect(ok.status).toBe(200);
    h.reset();
    // UPDATE 0 行（脚本不命中 → 空）→ 404
    const miss = await fetch(`${base}/api/v1/invites/22222222-2222-2222-2222-222222222222`, { method: 'DELETE' });
    expect(miss.status).toBe(404);
    const j = (await miss.json()) as any;
    expect(j.code).toBe('INVITE_404');
    // 非法 uuid 也按 404（不冒 22P02）
    h.reset();
    const bad = await fetch(`${base}/api/v1/invites/not-a-uuid`, { method: 'DELETE' });
    expect(bad.status).toBe(404);
  });

  it('⑫ 非 admin 生成码 → 403', async () => {
    h.reset();
    const workerApp = express();
    workerApp.use(express.json());
    workerApp.use('/api/v1', injectAuth('worker'), inviteRouter);
    workerApp.use(errorMiddleware);
    await new Promise<void>((resolve) => {
      const s2 = workerApp.listen(0, () => {
        const b2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`;
        fetch(`${b2}/api/v1/invites`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'anyone' }),
        }).then(async (r) => {
          expect(r.status).toBe(403);
          s2.close(() => resolve());
        });
      });
    });
  });
});

describe('redeem 公开激活（防枚举 + 建号 + 双花兜底）', () => {
  const VALID_CODE = 'YF-AAAA-BBBB-CCCC';

  function scriptValidInvite(overrides: Partial<Record<string, any>> = {}) {
    h.reset();
    h.script(/FROM invite_codes WHERE code_hash/, [{
      id: 'inv-r1',
      tenant_id: 't-redeem',
      username: 'newbie',
      display_name: '新人',
      role: 'operator',
      expires_at: new Date(Date.now() + 3600e3).toISOString(),
      used_at: null,
      revoked_at: null,
      ...overrides,
    }]);
  }

  it('⑥ redeem 成功 → 201：建号 scrypt 哈希 + 置 used_at + token 载荷 tid 正确', async () => {
    scriptValidInvite();
    h.script(/FROM account_user/, []); // 不重名
    h.script(/UPDATE invite_codes SET used_at/, [{ id: 'inv-r1' }]); // 一次性守卫命中
    h.script(/INSERT INTO account_user/, [{ id: 'u-new', tenant_id: 't-redeem', username: 'newbie', display_name: '新人', role: 'operator', active: true }]);
    h.script(/role_permission/, []); // listPerms 无覆盖行
    const r = await fetch(`${base}/api/v1/invites/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: VALID_CODE, password: 'secret66' }),
    });
    expect(r.status).toBe(201);
    const j = (await r.json()) as any;
    expect(j.ok).toBe(true);
    expect(j.token.split('.').length).toBe(3);
    // JWT payload（HS256 三段 base64url）：tid 必须来自邀请码归属租户
    const payload = JSON.parse(Buffer.from(j.token.split('.')[1], 'base64url').toString('utf8'));
    expect(payload.tid).toBe('t-redeem');
    expect(payload.username).toBe('newbie');
    expect(j.user.password_hash).toBeUndefined();
    const ins = h.calls.find((c) => /INSERT INTO account_user/.test(c.sql))!;
    expect(ins.params[0]).toBe('t-redeem');
    expect(String(ins.params[2])).toMatch(/^scrypt\$/); // hashPassword scrypt 同款
    const claim = h.calls.find((c) => /UPDATE invite_codes SET used_at/.test(c.sql))!;
    expect(claim.params[0]).toBe('inv-r1');
  });

  it('⑦ redeem 二次用同码（used_at 非空）→ 400 INVITE_INVALID 统一文案', async () => {
    scriptValidInvite({ used_at: new Date().toISOString() });
    const r = await fetch(`${base}/api/v1/invites/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: VALID_CODE, password: 'secret66' }),
    });
    expect(r.status).toBe(400);
    const j = (await r.json()) as any;
    expect(j.code).toBe('INVITE_INVALID');
    expect(j.message).toBe('邀请码已失效，请联系管理员重新生成');
  });

  it('⑧ redeem 过期码 → 400 INVITE_INVALID（文案与⑦一致）', async () => {
    scriptValidInvite({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const r = await fetch(`${base}/api/v1/invites/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: VALID_CODE, password: 'secret66' }),
    });
    expect(r.status).toBe(400);
    const j = (await r.json()) as any;
    expect(j.code).toBe('INVITE_INVALID');
    expect(j.message).toBe('邀请码已失效，请联系管理员重新生成');
  });

  it('⑨ redeem 篡改/未知码 → 400 INVITE_INVALID（文案与⑦一致，防枚举）', async () => {
    h.reset(); // pool.query 查不到任何码
    const r = await fetch(`${base}/api/v1/invites/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'YF-ZZZZ-ZZZZ-ZZZZ', password: 'secret66' }),
    });
    expect(r.status).toBe(400);
    const j = (await r.json()) as any;
    expect(j.code).toBe('INVITE_INVALID');
    expect(j.message).toBe('邀请码已失效，请联系管理员重新生成');
  });

  it('⑩ redeem 弱密码（<6 位）→ 422', async () => {
    h.reset();
    const r = await fetch(`${base}/api/v1/invites/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: VALID_CODE, password: '123' }),
    });
    expect(r.status).toBe(422);
  });

  it('⑪ 并发双花兜底：事务内 used_at 守卫 0 行 → 400 INVITE_INVALID', async () => {
    scriptValidInvite();
    h.script(/FROM account_user/, []);
    // UPDATE used_at 不命中脚本 → rowCount 0（另一并发请求已消费）
    const r = await fetch(`${base}/api/v1/invites/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: VALID_CODE, password: 'secret66' }),
    });
    expect(r.status).toBe(400);
    const j = (await r.json()) as any;
    expect(j.code).toBe('INVITE_INVALID');
  });
});
