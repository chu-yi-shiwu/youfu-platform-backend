// tenantOnboarding.http.test.ts —— 八件增量 BE-2：机构搜索/试用申请/平台审批/pending 租户态/admin 贴码。
// 真·express + 真 HTTP，mock 掉 DB 连接池（脚本化 client）+ mock 微信小程序服务。
// 覆盖：
//   ① GET /public/tenants q<2 → 422；q 合法 → 仅 active + LIMIT 20 + 模糊参数
//   ② POST /public/trial-applications → 201 pending，ip 落参
//   ③ 同手机号 24h 内重复提交 → 429 RATE_TRIAL
//   ④ GET /platform/trial-applications?status=pending → WHERE status 条件下发
//   ⑤ review reject → status=rejected + 原因落参
//   ⑥ review approve → tenant_registry 以 pending 落库 + 申请置 approved + admin 密码明文一次
//   ⑦ review 重复审批 → 409 TRIAL_REVIEWED
//   ⑧ pending 租户登录 → 403 TENANT_PENDING；suspended 既有口径不动（TENANT_SUSPENDED）
//   ⑨ PUT /platform/tenants/:id/status 枚举扩 pending → 200
//   ⑩ POST /platform/tenants status=pending 向后兼容（缺省 active 口径由既有路径保证）
//   ⑪ GET /admin/mp-qrcode：worker → 403；缺 loc → 422；admin → 200 image/png
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

// ---- mock DB 连接池：脚本化 SQL 响应 + 调用日志（pool.query 与事务/租户 client 同池脚本） ----
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
    default: {
      query: scriptedQuery,
      // platform.ts 开租户/审批走 pool.connect() 单连接事务（mock：同一脚本池，release 即弃）
      connect: async () => ({ query: scriptedQuery, release: () => undefined }),
    },
    assertSafeTenantId: (t: string) => t,
    withTenantClient: async (_tenantId: string, fn: (client: any) => Promise<any>) =>
      fn({ query: scriptedQuery }),
  };
});

// ---- mock 微信小程序服务（贴码端点真验 HTTP 形态，不真打微信 API） ----
vi.mock('../services/wechatMp.js', () => ({
  mpConfigured: () => true,
  genMpCode: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG 魔数
  code2Session: async () => null,
  decryptPhoneCode: async () => null,
}));

import publicReportRouter from '../routes/publicReport.js';
import platformRouter from '../routes/platform.js';
import authRouter from '../routes/auth.js';
import adminQrcodeRouter from '../routes/adminQrcode.js';

const T = 't-verify-onboarding';
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
  const app = express();
  app.use(express.json());
  app.use('/api/v1', publicReportRouter); // 公开搜索/试用申请（生产挂 auth 之前，同口径）
  app.use('/api/v1', authRouter); // 登录守卫（pending/suspended）
  app.use('/api/v1', injectAuth('admin'), adminQrcodeRouter); // admin 贴码
  app.use('/api/v1/worker-sim', injectAuth('worker'), adminQrcodeRouter); // worker 越权探测
  app.use('/api/v1/platform', platformRouter); // platformAdminAuth dev 放行（与既有 platform 测试同口径）
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

describe('公开机构搜索 GET /public/tenants', () => {
  it('① q 少于 2 字符 → 422', async () => {
    const r = await fetch(`${base}/api/v1/public/tenants?q=%E5%8C%BB`);
    expect(r.status).toBe(422);
    const j = (await r.json()) as any;
    expect(j.code).toBe('VALIDATION_001');
  });

  it('② 模糊搜索：SQL 限定 active + LIMIT 20 + ILIKE 参数', async () => {
    h.reset();
    h.script(/WHERE status = 'active'/, [
      { tenant_id: 't-hosp-1', name: '市第一人民医院', category: 'hospital' },
    ]);
    const r = await fetch(`${base}/api/v1/public/tenants?q=${encodeURIComponent('人民医院')}`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.items.length).toBe(1);
    expect(Object.keys(j.items[0]).sort()).toEqual(['category', 'name', 'tenant_id']); // 不回 quota/status
    const q = h.calls.find((c) => /FROM tenant_registry/.test(c.sql))!;
    expect(q.sql).toContain("status = 'active'");
    expect(q.sql).toContain('LIMIT 20');
    expect(q.params[0]).toBe('%人民医院%');
  });
});

describe('公开试用申请 POST /public/trial-applications', () => {
  const body = {
    org_name: '康宁物业',
    contact_name: '李明',
    phone: '13800001111',
    category: 'property',
    note: '想试用报修功能',
  };

  it('② 提交成功 → 201 pending，ip 落参', async () => {
    h.reset();
    h.script(/INSERT INTO trial_applications/, [{ id: 'ta-1', org_name: body.org_name, status: 'pending', created_at: new Date().toISOString() }]);
    const r = await fetch(`${base}/api/v1/public/trial-applications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(r.status).toBe(201);
    const j = (await r.json()) as any;
    expect(j.item.status).toBe('pending');
    const ins = h.calls.find((c) => /INSERT INTO trial_applications/.test(c.sql))!;
    expect(ins.params).toContain(body.phone);
    expect(ins.params).toContain(body.org_name);
  });

  it('③ 同手机号 24h 内重复提交 → 429 RATE_TRIAL', async () => {
    h.reset();
    h.script(/SELECT 1 FROM trial_applications WHERE phone/, [{}]); // 24h 内已有
    const r = await fetch(`${base}/api/v1/public/trial-applications`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(r.status).toBe(429);
    const j = (await r.json()) as any;
    expect(j.code).toBe('RATE_TRIAL');
  });
});

describe('平台试用审批 /platform/trial-applications', () => {
  const PENDING_ROW = {
    id: 'ta-9',
    org_name: '康宁物业',
    contact_name: '李明',
    phone: '13800001111',
    category: 'property',
    note: null,
    status: 'pending',
    tenant_id: null,
    reviewed_by: null,
    reviewed_at: null,
    reject_reason: null,
    created_at: new Date().toISOString(),
  };

  it('④ 列表 status 过滤条件下发', async () => {
    h.reset();
    h.script(/count\(\*\)::int AS c FROM trial_applications/, [{ c: 1 }]);
    h.script(/FROM trial_applications/, [PENDING_ROW]);
    const r = await fetch(`${base}/api/v1/platform/trial-applications?status=pending`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.items.length).toBe(1);
    const list = h.calls.find((c) => /FROM trial_applications/.test(c.sql) && !/count/.test(c.sql))!;
    expect(list.params).toContain('pending');
  });

  it('⑤ reject → status=rejected + 原因落参', async () => {
    h.reset();
    h.script(/SELECT \* FROM trial_applications WHERE id/, [PENDING_ROW]);
    h.script(/UPDATE trial_applications/, [{ id: 'ta-9', status: 'rejected', reject_reason: '资料不全' }]);
    const r = await fetch(`${base}/api/v1/platform/trial-applications/ta-9/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reject', reason: '资料不全' }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.item.status).toBe('rejected');
    const upd = h.calls.find((c) => /UPDATE trial_applications/.test(c.sql))!;
    expect(upd.params).toContain('资料不全');
  });

  it('⑥ approve → 租户以 pending 落库 + 申请置 approved + admin 密码明文一次', async () => {
    h.reset();
    h.script(/SELECT \* FROM trial_applications WHERE id/, [PENDING_ROW]);
    h.script(/FOR UPDATE/, [{ status: 'pending' }]); // 事务内行锁预检命中 pending
    h.script(/INSERT INTO tenant_registry/, [{ tenant_id: 't-kangning' }]);
    h.script(/UPDATE trial_applications/, [{ id: 'ta-9', status: 'approved', tenant_id: 't-kangning' }]);
    const r = await fetch(`${base}/api/v1/platform/trial-applications/ta-9/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve', tenant_id: 't-kangning', admin_username: 'knadmin' }),
    });
    expect(r.status).toBe(201);
    const j = (await r.json()) as any;
    expect(j.item.status).toBe('approved');
    expect(j.item.tenant_id).toBe('t-kangning');
    expect(j.admin.username).toBe('knadmin');
    expect(typeof j.admin.password).toBe('string'); // 明文仅本次
    const insTenant = h.calls.find((c) => /INSERT INTO tenant_registry/.test(c.sql))!;
    expect(insTenant.sql).toContain('status');
    expect(insTenant.params).toContain('pending'); // 以 pending 态落库
    const insAcct = h.calls.find((c) => /INSERT INTO account_user/.test(c.sql))!;
    expect(insAcct.params).toContain('knadmin');
    const updApp = h.calls.find((c) => /UPDATE trial_applications/.test(c.sql))!;
    expect(updApp.params).toContain('t-kangning');
  });

  it('⑦ 重复审批（非 pending）→ 409 TRIAL_REVIEWED', async () => {
    h.reset();
    h.script(/SELECT \* FROM trial_applications WHERE id/, [{ ...PENDING_ROW, status: 'approved' }]);
    const r = await fetch(`${base}/api/v1/platform/trial-applications/ta-9/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reject' }),
    });
    expect(r.status).toBe(409);
    const j = (await r.json()) as any;
    expect(j.code).toBe('TRIAL_REVIEWED');
  });

  it('⑦b 并发守卫：approve 事务内行锁预检读到 approved → 409（不撞 PK 冒 500）', async () => {
    h.reset();
    h.script(/SELECT \* FROM trial_applications WHERE id/, [PENDING_ROW]); // 事务外预检仍是 pending（模拟并发穿透）
    // FOR UPDATE 不命中脚本 → rowCount 0（另一事务已置 approved 并提交）
    const r = await fetch(`${base}/api/v1/platform/trial-applications/ta-9/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve', tenant_id: 't-kangning', admin_username: 'knadmin' }),
    });
    expect(r.status).toBe(409);
    const j = (await r.json()) as any;
    expect(j.code).toBe('TRIAL_REVIEWED');
    // 不得触碰 tenant_registry（未进入开通写入段）
    expect(h.calls.some((c) => /INSERT INTO tenant_registry/.test(c.sql))).toBe(false);
  });

  it('⑦c reject 原子守卫：UPDATE 0 行（已被并发审批）→ 409', async () => {
    h.reset();
    h.script(/SELECT \* FROM trial_applications WHERE id/, [PENDING_ROW]);
    h.script(/UPDATE trial_applications/, [], 0); // 带 status='pending' 条件的 UPDATE 落空
    const r = await fetch(`${base}/api/v1/platform/trial-applications/ta-9/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reject', reason: '晚了一步' }),
    });
    expect(r.status).toBe(409);
    const j = (await r.json()) as any;
    expect(j.code).toBe('TRIAL_REVIEWED');
  });
});

describe('租户 pending 态（零 DDL）', () => {
  function scriptRegistryStatus(status: string) {
    h.reset();
    h.script(/SELECT status FROM tenant_registry/, [{ status }]);
  }

  it('⑧ pending 租户登录 → 403 TENANT_PENDING', async () => {
    scriptRegistryStatus('pending');
    const r = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'a', password: 'b', tenant: T }),
    });
    expect(r.status).toBe(403);
    const j = (await r.json()) as any;
    expect(j.code).toBe('TENANT_PENDING');
  });

  it('⑧b suspended 租户登录既有口径不动 → 403 TENANT_SUSPENDED', async () => {
    scriptRegistryStatus('suspended');
    const r = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'a', password: 'b', tenant: T }),
    });
    expect(r.status).toBe(403);
    const j = (await r.json()) as any;
    expect(j.code).toBe('TENANT_SUSPENDED');
  });

  it('⑨ PUT /platform/tenants/:id/status 枚举扩 pending → 200', async () => {
    h.reset();
    h.script(/UPDATE tenant_registry SET status/, [{ tenant_id: T, name: '康宁物业', status: 'pending' }]);
    const r = await fetch(`${base}/api/v1/platform/tenants/${T}/status`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'pending' }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.item.status).toBe('pending');
  });

  it('⑩ POST /platform/tenants status=pending 落库；缺省 active 兼容', async () => {
    h.reset();
    h.script(/INSERT INTO tenant_registry/, [{ tenant_id: 't-pending-new' }]);
    const r = await fetch(`${base}/api/v1/platform/tenants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenant_id: 't-pending-new', name: '待激活机构', category: 'school', status: 'pending' }),
    });
    expect(r.status).toBe(201);
    const j = (await r.json()) as any;
    expect(j.item.status).toBe('pending');
    const ins = h.calls.find((c) => /INSERT INTO tenant_registry/.test(c.sql))!;
    expect(ins.params).toContain('pending');
  });
});

describe('admin 贴码端点 GET /admin/mp-qrcode', () => {
  it('⑪a worker 角色 → 403', async () => {
    const r = await fetch(`${base}/api/v1/worker-sim/admin/mp-qrcode?loc=3F-A01`);
    expect(r.status).toBe(403);
  });

  it('⑪b 缺 loc → 422', async () => {
    const r = await fetch(`${base}/api/v1/admin/mp-qrcode`);
    expect(r.status).toBe(422);
  });

  it('⑪c admin → 200 image/png，path 携带本租户 org 与 loc', async () => {
    h.reset();
    const r = await fetch(`${base}/api/v1/admin/mp-qrcode?loc=3F-A01`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    const buf = Buffer.from(await r.arrayBuffer());
    expect(buf.subarray(0, 4).toString('hex')).toBe('89504e47'); // PNG 魔数
  });
});
