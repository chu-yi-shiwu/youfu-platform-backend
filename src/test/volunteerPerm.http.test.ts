// volunteerPerm.http.test.ts —— 志愿者模块 V1 权限矩阵真 HTTP 测试（**prod 鉴权模式**）。
//
// 【为什么必须 prod 模式】hasPerm() 在 authMode:'dev' 下恒返回 true（src/middleware/role.ts）——
// dev 模式永远走不到 403 分支，权限矩阵写错、requirePermission 漏调测试全绿。本文件固定
// authMode:'prod' + 脚本化 role_permission 查询（与 settlement.http.test.ts 同 harness 范式），
// 断言真实 HTTP 状态码。
//
// 覆盖（设计 §3.3 对照表 + T01 验收标准 1）：
//   ① service_desk 仅授 volunteer.audit → checkin 200；POST activities / PUT status / 读端点全 403；
//      GET /activities 保持仅登录 200；listPerms 口径 = 含 audit、不含 manage/view（FE 菜单依据）；
//   ② 仅授 volunteer.view → GET stats/people/records 200；全部写端点 403；
//   ③ 无 role_permission 覆盖行 → 回退默认矩阵：operator 全通过、worker 全 403（零回归）；
//   ④ dev 模式恒放行回归（记录现状：生产绝不能依赖该分支）。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';
import type { AuthLocals } from '../middleware/auth.js';
import { listPerms } from '../middleware/role.js';

// ---- mock 掉 DB 连接池：withTenantClient 直接把脚本化 client 交给回调（不连真库）----
const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(h.client),
  assertSafeTenantId: (t: string) => t,
  default: { connect: async () => { throw new Error('[volunteerPerm.http.test] 单测禁用真实 pool'); } },
}));

import volunteerRouter from '../routes/volunteer.js';

// ---- 脚本化 mock client：按 SQL 片段命中 handler；未命中走默认（rows: [], rowCount: 1）----
interface Handler {
  match: (text: string) => boolean;
  reply: (text: string, params: unknown[]) => { rows: unknown[]; rowCount?: number };
}

function makeClient(handlers: Handler[]) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      for (const hd of handlers) {
        if (hd.match(text)) return hd.reply(text, params ?? []);
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return { client, calls };
}

/** role_permission 覆盖行（租户自配权限集合）；rows 传 [] = 无覆盖行 → hasPerm 回退默认矩阵。 */
function permRows(perms: string[]): Handler {
  return {
    match: (t) => t.includes('SELECT perm FROM role_permission'),
    reply: () => ({ rows: perms.map((perm) => ({ perm })), rowCount: perms.length }),
  };
}

const T = 't-volunteer-perm';

// ---- 真实 express + 真 HTTP 服务器（prod 鉴权上下文，role/authMode 逐请求可变）----
let server: Server;
let baseUrl = '';
const auth: AuthLocals & { role: string } = {
  tenantId: T,
  requestId: 'req-vol-perm',
  idempotencyKey: undefined,
  userId: 'u-1',
  username: 'admin',
  role: 'admin',
  authMode: 'prod',
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // 替代 authMiddleware：直接注入 prod 模式鉴权上下文
  app.use((_req, res, next) => {
    res.locals.auth = auth;
    next();
  });
  app.use('/api/v1/volunteer', volunteerRouter); // 与生产 server.ts 挂载一致
  app.use((_req, res) => res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'not found' }));
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Res {
  status: number;
  body: Record<string, unknown>;
}

async function call(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  opts?: { body?: unknown; role?: string | null; authMode?: 'prod' | 'dev' },
): Promise<Res> {
  // role 显式传 null = 「请求里没有角色」；未传（undefined）才回落到 admin。
  auth.role = (opts?.role === undefined ? 'admin' : opts.role) as string;
  auth.username = auth.role;
  auth.authMode = opts?.authMode ?? 'prod';
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (opts?.body !== undefined) init.body = JSON.stringify(opts.body);
  const r = await fetch(`${baseUrl}${path}`, init);
  const text = await r.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: r.status, body };
}

// ---- 端点 SQL 脚本（ volunteer.ts 全部 SQL 的 mock 响应）----
function volunteerHandlers(permGranted: string[]): Handler[] {
  return [
    permRows(permGranted),
    // POST /activities：INSERT RETURNING *（成功建活动）
    { match: (t) => t.includes('INSERT INTO volunteer_activity'), reply: () => ({ rows: [{ id: 'act-new', title: '导诊志愿', status: 'open' }], rowCount: 1 }) },
    // PUT /activities/:id/status：UPDATE RETURNING
    { match: (t) => t.includes('UPDATE volunteer_activity SET status'), reply: () => ({ rows: [{ id: 'act-1', title: '导诊志愿', status: 'closed' }], rowCount: 1 }) },
    // GET /activities（仅登录，无权限点）：列表（含 V1 signup_count 子查询）
    {
      match: (t) => t.includes('FROM volunteer_activity a WHERE'),
      reply: () => ({ rows: [{ id: 'act-1', title: '导诊志愿', slots: 2, status: 'open', signup_count: 1 }], rowCount: 1 }),
    },
    // GET /activities/:id/records
    { match: (t) => t.includes('FROM volunteer_record WHERE tenant_id = $1 AND activity_id = $2 ORDER BY'), reply: () => ({ rows: [], rowCount: 0 }) },
    // checkin/checkout/approve：SELECT * FROM volunteer_record WHERE id = $1
    { match: (t) => t.includes('SELECT * FROM volunteer_record WHERE id = $1'), reply: () => ({ rows: [{ id: 'rec-1', status: 'registered', check_in_at: null }], rowCount: 1 }) },
    // checkin UPDATE
    { match: (t) => t.includes("SET status = 'checked_in'"), reply: () => ({ rows: [{ id: 'rec-1', status: 'checked_in' }], rowCount: 1 }) },
    // checkout UPDATE
    { match: (t) => t.includes("SET status = 'checked_out'"), reply: () => ({ rows: [{ id: 'rec-1', status: 'checked_out', duration_min: 60, points: 1 }], rowCount: 1 }) },
    // approve UPDATE
    { match: (t) => t.includes("SET status = 'approved'"), reply: () => ({ rows: [{ id: 'rec-1', status: 'approved' }], rowCount: 1 }) },
    // GET /people（GROUP BY user_name 聚合）
    { match: (t) => t.includes('GROUP BY user_name'), reply: () => ({ rows: [{ user_name: '张三', signup_count: 1 }], rowCount: 1 }) },
    // GET /stats（FILTER 聚合）
    { match: (t) => t.includes('FILTER (WHERE status IN'), reply: () => ({ rows: [{ registered_count: 1, served_count: 0 }], rowCount: 1 }) },
    // emitDomainEvent（domain_event 落库）
    { match: (t) => t.includes('INSERT INTO domain_event'), reply: () => ({ rows: [], rowCount: 1 }) },
  ];
}

// ==================== 一、service_desk 仅授 volunteer.audit ====================
describe('service_desk 仅授 volunteer.audit（现场执行细分授权）', () => {
  it('① checkin → 200（audit 点放行现场执行）', async () => {
    h.client = makeClient(volunteerHandlers(['volunteer.audit'])).client;
    const r = await call('POST', '/volunteer/records/rec-1/checkin', { role: 'service_desk' });
    expect(r.status, `期望 200，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('② POST /activities → 403 permission denied: volunteer.manage，且无 INSERT', async () => {
    const mk = makeClient(volunteerHandlers(['volunteer.audit']));
    h.client = mk.client;
    const r = await call('POST', '/volunteer/activities', { role: 'service_desk', body: { title: '导诊志愿', slots: 2 } });
    expect(r.status, `期望 403，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(403);
    expect(r.body.ok).toBe(false);
    expect(String(r.body.message)).toContain('volunteer.manage');
    expect(mk.calls.some((c) => c.text.includes('INSERT INTO volunteer_activity'))).toBe(false);
  });

  it('③ PUT /activities/:id/status → 403（关闭/重开同属 manage）', async () => {
    h.client = makeClient(volunteerHandlers(['volunteer.audit'])).client;
    const r = await call('PUT', '/volunteer/activities/act-1/status', { role: 'service_desk', body: { status: 'closed' } });
    expect(r.status).toBe(403);
  });

  it('④ 读端点（stats/people/records）→ 403（audit 不含 view）', async () => {
    h.client = makeClient(volunteerHandlers(['volunteer.audit'])).client;
    for (const p of ['/volunteer/stats', '/volunteer/people', '/volunteer/activities/act-1/records']) {
      const r = await call('GET', p, { role: 'service_desk' });
      expect(r.status, `GET ${p} 期望 403，实际 ${r.status}`).toBe(403);
    }
  });

  it('⑤ GET /activities 保持仅登录 → 200（报名入口依赖，设计明确不收口）', async () => {
    h.client = makeClient(volunteerHandlers([])).client;
    const r = await call('GET', '/volunteer/activities', { role: 'service_desk' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it('⑥ FE 菜单口径：listPerms 含 volunteer.audit、不含 manage/view（消费 /auth/me permissions[]）', async () => {
    const mockClient = { query: async () => ({ rows: [{ perm: 'volunteer.audit' }], rowCount: 1 }) };
    const perms = await listPerms(
      { tenantId: T, role: 'service_desk', authMode: 'prod' } as AuthLocals,
      mockClient as never,
    );
    expect(perms).toContain('volunteer.audit');
    expect(perms).not.toContain('volunteer.manage');
    expect(perms).not.toContain('volunteer.view');
  });
});

// ==================== 二、仅授 volunteer.view（只读监督）====================
describe('仅授 volunteer.view（只读授权：reviewer 时长监督场景）', () => {
  it('① GET stats / people / records → 200', async () => {
    h.client = makeClient(volunteerHandlers(['volunteer.view'])).client;
    for (const p of ['/volunteer/stats', '/volunteer/people', '/volunteer/activities/act-1/records']) {
      const r = await call('GET', p, { role: 'reviewer' });
      expect(r.status, `GET ${p} 期望 200，实际 ${r.status}`).toBe(200);
      expect(r.body.ok).toBe(true);
    }
  });

  it('② 全部写端点 → 403（POST activities / PUT status / checkin / checkout / approve）', async () => {
    const mk = makeClient(volunteerHandlers(['volunteer.view']));
    h.client = mk.client;
    const r1 = await call('POST', '/volunteer/activities', { role: 'reviewer', body: { title: '导诊志愿', slots: 2 } });
    expect(r1.status).toBe(403);
    const r2 = await call('PUT', '/volunteer/activities/act-1/status', { role: 'reviewer', body: { status: 'closed' } });
    expect(r2.status).toBe(403);
    for (const p of ['checkin', 'checkout', 'approve']) {
      const r = await call('POST', `/volunteer/records/rec-1/${p}`, { role: 'reviewer' });
      expect(r.status, `POST ${p} 期望 403，实际 ${r.status}`).toBe(403);
    }
    // view-only 绝不能产生任何写 SQL
    expect(mk.calls.some((c) => c.text.includes('INSERT INTO volunteer_activity'))).toBe(false);
    expect(mk.calls.some((c) => c.text.includes('SET status ='))).toBe(false);
    expect(mk.calls.some((c) => c.text.includes('UPDATE volunteer_activity'))).toBe(false);
  });
});

// ==================== 三、无覆盖行 → 回退默认矩阵（存量租户零回归）====================
describe('无 role_permission 覆盖行 → 默认矩阵（存量租户零回归）', () => {
  it('① operator：读/写/现场执行全通过（默认矩阵含 volunteer.view/manage/audit）', async () => {
    h.client = makeClient(volunteerHandlers([])).client;
    const g1 = await call('GET', '/volunteer/stats', { role: 'operator' });
    expect(g1.status).toBe(200);
    const w1 = await call('POST', '/volunteer/activities', { role: 'operator', body: { title: '导诊志愿', slots: 2 } });
    expect(w1.status, `期望 201，实际 ${w1.status} ${JSON.stringify(w1.body)}`).toBe(201);
    const w2 = await call('PUT', '/volunteer/activities/act-1/status', { role: 'operator', body: { status: 'closed' } });
    expect(w2.status).toBe(200);
    const w3 = await call('POST', '/volunteer/records/rec-1/checkin', { role: 'operator' });
    expect(w3.status).toBe(200);
  });

  it('② worker：全部管理/读守卫端点 → 403（默认矩阵无 volunteer.*）', async () => {
    h.client = makeClient(volunteerHandlers([])).client;
    const r1 = await call('POST', '/volunteer/activities', { role: 'worker', body: { title: '导诊志愿', slots: 2 } });
    expect(r1.status).toBe(403);
    const r2 = await call('GET', '/volunteer/stats', { role: 'worker' });
    expect(r2.status).toBe(403);
    const r3 = await call('POST', '/volunteer/records/rec-1/checkin', { role: 'worker' });
    expect(r3.status).toBe(403);
  });

  it('③ 角色缺失（role 为空）→ 403（防「无角色即放行」）', async () => {
    h.client = makeClient(volunteerHandlers([])).client;
    const r = await call('GET', '/volunteer/stats', { role: null });
    expect(r.status).toBe(403);
  });
});

// ==================== 四、dev 模式恒放行回归（记录现状）====================
describe('dev 模式恒放行（既有约定回归）', () => {
  it('worker 在 dev 模式也能过守卫（hasPerm 短路放行——生产绝不能落到该分支）', async () => {
    h.client = makeClient(volunteerHandlers([])).client;
    const r = await call('POST', '/volunteer/activities', { role: 'worker', authMode: 'dev', body: { title: '导诊志愿', slots: 2 } });
    expect(r.status).toBe(201);
  });
});
