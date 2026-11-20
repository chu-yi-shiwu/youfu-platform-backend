// 模块授权契约：租户/部门开关、部门成员角色分配、管理面门禁与个人任务豁免。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';
import type { AuthLocals } from '../middleware/auth.js';

const h = vi.hoisted(() => ({
  client: null as unknown,
  tenant: new Map<string, boolean>(),
  dept: new Map<string, boolean>(),
  deptExists: true,
  workerDeptId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as string | null,
  members: [
    { account_id: '11111111-1111-4111-8111-111111111111', username: 'member', display_name: '成员', role: 'worker', active: true, worker_id: 'w1', worker_name: '成员' },
  ] as Array<Record<string, unknown>>,
  rolePerms: new Map<string, string[]>(),
  calls: [] as Array<{ text: string; params?: unknown[] }>,
}));

vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(h.client),
  default: { connect: async () => { throw new Error('[module.test] 不得使用真实 pool'); } },
}));

h.client = {
  query: async (text: string, params?: unknown[]) => {
    h.calls.push({ text, params });
    if (text.includes('FROM tenant_module')) {
      return { rows: [...h.tenant].map(([module_key, enabled]) => ({ module_key, enabled })), rowCount: h.tenant.size };
    }
    if (text.includes('INSERT INTO tenant_module')) {
      h.tenant.set(String(params![1]), Boolean(params![2]));
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('FROM department_module')) {
      return { rows: [...h.dept].map(([module_key, enabled]) => ({ module_key, enabled })), rowCount: h.dept.size };
    }
    if (text.includes('INSERT INTO department_module')) {
      h.dept.set(String(params![2]), Boolean(params![3]));
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('FROM dept')) {
      return { rows: h.deptExists ? [{ ok: 1 }] : [], rowCount: h.deptExists ? 1 : 0 };
    }
    if (text.includes('SELECT department_id FROM worker')) {
      const ok = !!h.workerDeptId && params![1] === OP;
      return { rows: ok ? [{ department_id: h.workerDeptId }] : [], rowCount: ok ? 1 : 0 };
    }
    if (text.includes('SELECT 1 FROM worker')) {
      const ok = !!h.workerDeptId && h.workerDeptId === params![1] && params![2] === OP;
      return { rows: ok ? [{ ok: 1 }] : [], rowCount: ok ? 1 : 0 };
    }
    if (text.includes('FROM worker w') && text.includes('JOIN account_user')) {
      const isTarget = text.includes('a.id=$3');
      if (isTarget) {
        const found = h.members.find((m) => m.account_id === params![2]);
        return { rows: found ? [{ account_id: found.account_id, role: found.role }] : [], rowCount: found ? 1 : 0 };
      }
      return { rows: h.members, rowCount: h.members.length };
    }
    if (text.includes('FROM role_permission')) {
      const perms = h.rolePerms.get(String(params![1]));
      return { rows: (perms ?? []).map((perm) => ({ perm })), rowCount: perms?.length ?? 0 };
    }
    if (text.includes('FROM role_def')) return { rows: [], rowCount: 0 };
    if (text.includes('UPDATE account_user')) {
      const m = h.members.find((x) => x.account_id === params![1]);
      if (m) m.role = String(params![0]);
      return { rows: [], rowCount: m ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  },
};

import moduleAuthRouter from '../routes/moduleAuth.js';
import { requireModule, requireModuleWrites } from '../middleware/moduleGuard.js';
import { userModuleKeys } from '../modules/service.js';

const DEPT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MEMBER = '11111111-1111-4111-8111-111111111111';
const OP = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';

let auth: AuthLocals = {
  tenantId: 't-mod', role: 'admin', authMode: 'dev', userId: ADMIN, username: 'admin', requestId: 'r-1',
};

let server: Server;
let base = '';

function appFor(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = auth;
    next();
  });
  app.use('/api/v1', moduleAuthRouter);
  app.use(errorMiddleware);
  return app;
}

async function start(app: express.Express): Promise<{ server: Server; base: string }> {
  const s = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => s.once('listening', () => r()));
  return { server: s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}

beforeEach(() => {
  h.tenant.clear();
  h.dept.clear();
  h.deptExists = true;
  h.workerDeptId = DEPT;
  h.members = [
    { account_id: MEMBER, username: 'member', display_name: '成员', role: 'worker', active: true, worker_id: 'w1', worker_name: '成员' },
  ];
  h.rolePerms.clear();
  h.calls = [];
  auth = { tenantId: 't-mod', role: 'admin', authMode: 'dev', userId: ADMIN, username: 'admin', requestId: 'r-1' };
});

beforeAll(async () => {
  const s = await start(appFor());
  server = s.server;
  base = s.base;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('模块授权', () => {
  it('租户默认全开；admin 可读', async () => {
    const r = await fetch(`${base}/api/v1/tenant/modules`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { items: Array<{ key: string; enabled: boolean }> };
    expect(j.items.length).toBeGreaterThan(10);
    expect(j.items.every((m) => m.enabled)).toBe(true);
  });

  it('非 admin 不能读/改租户模块', async () => {
    auth = { ...auth, role: 'operator', userId: OP, username: 'op' };
    const get = await fetch(`${base}/api/v1/tenant/modules`);
    expect(get.status).toBe(403);
    const put = await fetch(`${base}/api/v1/tenant/modules`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modules: [{ key: 'asset', enabled: false }] }),
    });
    expect(put.status).toBe(403);
  });

  it('admin 关闭租户模块并落库', async () => {
    const put = await fetch(`${base}/api/v1/tenant/modules`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modules: [{ key: 'asset', enabled: false }] }),
    });
    expect(put.status).toBe(200);
    const j = (await put.json()) as { items: Array<{ key: string; enabled: boolean }> };
    expect(j.items.find((m) => m.key === 'asset')?.enabled).toBe(false);
    expect(h.tenant.get('asset')).toBe(false);
    expect(h.calls.some((c) => c.text.includes('INSERT INTO domain_event'))).toBe(true);
  });

  it('未知模块 → 400，不落库', async () => {
    const r = await fetch(`${base}/api/v1/tenant/modules`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modules: [{ key: 'not_a_module', enabled: false }] }),
    });
    expect(r.status).toBe(400);
    expect(h.tenant.size).toBe(0);
  });

  it('部门模块继承租户；租户关闭后部门显示不可用', async () => {
    h.tenant.set('asset', false);
    const r = await fetch(`${base}/api/v1/departments/${DEPT}/modules`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { items: Array<{ key: string; tenant_enabled: boolean; effective: boolean; override: boolean | null }> };
    const asset = j.items.find((m) => m.key === 'asset')!;
    expect(asset.tenant_enabled).toBe(false);
    expect(asset.effective).toBe(false);
    expect(asset.override).toBe(null);
  });

  it('部门不能启用租户已关闭的模块（422）', async () => {
    h.tenant.set('asset', false);
    const r = await fetch(`${base}/api/v1/departments/${DEPT}/modules`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modules: [{ key: 'asset', enabled: true }] }),
    });
    expect(r.status).toBe(422);
    expect(h.dept.size).toBe(0);
  });

  it('部门可在租户范围内收紧模块', async () => {
    const r = await fetch(`${base}/api/v1/departments/${DEPT}/modules`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modules: [{ key: 'material', enabled: false }] }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { items: Array<{ key: string; effective: boolean; override: boolean | null }> };
    const material = j.items.find((m) => m.key === 'material')!;
    expect(material.effective).toBe(false);
    expect(material.override).toBe(false);
  });

  it('部门管理员只能管理本部门', async () => {
    auth = { ...auth, role: 'operator', userId: OP, username: 'op' };
    h.workerDeptId = null;
    const r = await fetch(`${base}/api/v1/departments/${DEPT}/modules`);
    expect(r.status).toBe(403);
  });

  it('部门成员列表 + 可分配角色：排除 admin，按权限子集收敛', async () => {
    auth = { ...auth, role: 'operator', userId: OP, username: 'op' };
    const r = await fetch(`${base}/api/v1/departments/${DEPT}/members`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { items: Array<{ account_id: string }>; roles: string[] };
    expect(j.items.map((m) => m.account_id)).toContain(MEMBER);
    expect(j.roles).toContain('worker');
    expect(j.roles).toContain('operator');
    expect(j.roles).not.toContain('admin');
  });

  it('部门管理员分配已有低权角色成功，并递增 token_version', async () => {
    auth = { ...auth, role: 'operator', userId: OP, username: 'op' };
    const r = await fetch(`${base}/api/v1/departments/${DEPT}/members/${MEMBER}/role`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'worker' }),
    });
    expect(r.status).toBe(200);
    const upd = h.calls.find((c) => c.text.includes('UPDATE account_user'));
    expect(upd?.text).toContain('token_version=token_version+1');
    expect(upd?.params?.[0]).toBe('worker');
  });

  it('不能分配 admin / 高权角色', async () => {
    auth = { ...auth, role: 'operator', userId: OP, username: 'op' };
    const admin = await fetch(`${base}/api/v1/departments/${DEPT}/members/${MEMBER}/role`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(admin.status).toBe(403);
    // 给 worker 角色加一个调用人没有的权限点 → 权限子集校验必须拒绝。
    h.rolePerms.set('worker', ['dashboard.view', 'role.manage']);
    const escalated = await fetch(`${base}/api/v1/departments/${DEPT}/members/${MEMBER}/role`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'worker' }),
    });
    expect(escalated.status).toBe(403);
  });

  it('不能改自己角色', async () => {
    auth = { ...auth, role: 'operator', userId: OP, username: 'op' };
    h.members = [
      { account_id: OP, username: 'op', display_name: '管理员', role: 'operator', active: true, worker_id: 'w2', worker_name: '管理员' },
    ];
    const r = await fetch(`${base}/api/v1/departments/${DEPT}/members/${OP}/role`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'worker' }),
    });
    expect(r.status).toBe(403);
  });

  it('非本部门成员返回 404', async () => {
    auth = { ...auth, role: 'operator', userId: OP, username: 'op' };
    const r = await fetch(`${base}/api/v1/departments/${DEPT}/members/${OTHER}/role`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'worker' }),
    });
    expect(r.status).toBe(404);
  });
});

describe('有效模块与执行豁免', () => {
  it('普通成员受部门收紧；admin 忽略部门收紧但仍受租户上限', async () => {
    h.tenant.set('asset', false);
    h.dept.set('material', false);
    const member = await userModuleKeys(h.client as never, 't-mod', OP, 'operator');
    expect(member).not.toContain('asset');
    expect(member).not.toContain('material');
    const admin = await userModuleKeys(h.client as never, 't-mod', ADMIN, 'admin');
    expect(admin).not.toContain('asset');
    expect(admin).toContain('material');
  });

  it('管理面门禁：模块关闭 → 403 MODULE_DISABLED', async () => {
    const app = express();
    auth = { ...auth, authMode: 'prod' };
    app.use((_req, res, next) => { res.locals.auth = auth; next(); });
    app.use('/api/v1/equipment', requireModule('equipment'), (_req, res) => res.json({ ok: true }));
    app.use(errorMiddleware);
    const s = await start(app);
    try {
      h.tenant.set('equipment', false);
      const r = await fetch(`${s.base}/api/v1/equipment/list`);
      expect(r.status).toBe(403);
      const j = (await r.json()) as { code: string };
      expect(j.code).toBe('MODULE_DISABLED');
    } finally {
      await new Promise<void>((r) => s.server.close(() => r()));
    }
  });

  it('个人执行豁免：模块关闭时领料仍放行，仓库管理写入仍拦截', async () => {
    auth = { ...auth, authMode: 'prod' };
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => { res.locals.auth = auth; next(); });
    const r = express.Router();
    r.use(requireModuleWrites('material', { allow: [/^\/inventory\/consume$/] }));
    r.post('/inventory/consume', (_req, res) => res.json({ ok: true, path: 'consume' }));
    r.post('/inventory/in', (_req, res) => res.json({ ok: true, path: 'in' }));
    app.use('/api/v1', r);
    app.use(errorMiddleware);
    const s = await start(app);
    try {
      h.tenant.set('material', false);
      const consume = await fetch(`${s.base}/api/v1/inventory/consume`, { method: 'POST' });
      expect(consume.status).toBe(200);
      const inRes = await fetch(`${s.base}/api/v1/inventory/in`, { method: 'POST' });
      expect(inRes.status).toBe(403);
    } finally {
      await new Promise<void>((r) => s.server.close(() => r()));
    }
  });
});
