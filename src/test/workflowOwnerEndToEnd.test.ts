// 097 端到端闭环（真 HTTP，租户侧 + 平台侧同进程、共享同一份内存库）：
//   客户想改 → 改不了 → 找运维 → 运维代客改 → 客户看得见新流程 → 客户**仍然改不了**。
//
// 【为什么补这份】
//   前面几份都是单侧断言（租户侧 403 / 平台侧 200），从没人证过**两侧串起来**仍然成立：
//     · 运维存的草稿会不会误写 live（客户流程被偷偷改掉）？
//     · 运维批完之后，客户能不能真的读到新流程（改了却看不见 = 白改）？
//     · 流程一旦被运维改过，客户端的闸门会不会失效（改完就能自己改了）？
//   这三条任一断裂，097 都是「锁上了但没用」。
//
// 【为什么 AUTH_MODE=dev】本文件验的是闭环而不是登录：dev 下权限点恒放行，
//   于是「客户能不能改」只由归属闸门决定，不会被权限矩阵干扰（与 workflowConfigOwner 同口径）。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const OLD_DEF = { initial: 'new', states: ['new', 'processing', 'done'], transitions: [], config: {} };
const NEW_DEF = { initial: 'new', states: ['new', 'processing', 'checking', 'done'], transitions: [], config: {} };

const box = vi.hoisted(() => ({
  owner: 'platform' as string,
  // 注意：vi.hoisted 的工厂在模块顶部之前执行，此处不能引用外层常量（会 TDZ），
  // 初始值给空壳，真实值在 beforeEach 里灌。
  live: { version: 0, def: {} as Record<string, unknown> },
  change: null as null | { status: 'draft' | 'submitted'; def: Record<string, unknown>; baseVersion: number },
  auditActions: [] as string[],
  insertedLiveDefs: [] as Record<string, unknown>[],
}));

/** 从 SQL 参数里认出 def（对象或 JSON 串），认不出返回 null。 */
function findDef(params: unknown[]): Record<string, unknown> | null {
  const hit = params.find((p) => {
    if (p && typeof p === 'object') return Array.isArray((p as Record<string, unknown>).states);
    if (typeof p === 'string') return p.includes('"states"');
    return false;
  });
  if (!hit) return null;
  return typeof hit === 'string' ? (JSON.parse(hit) as Record<string, unknown>) : hit as Record<string, unknown>;
}

function makeClient() {
  return {
    query: async (sql: string, params: unknown[] = []) => {
      const s = String(sql);
      if (s.includes('INSERT INTO platform_audit')) {
        box.auditActions.push(String(params[1]));
        return { rows: [], rowCount: 1 };
      }
      if (s.includes('FROM platform_config')) return { rows: [{ value: box.owner }], rowCount: 1 };
      if (s.includes('workflow_def_change') && s.includes('SELECT')) {
        return box.change
          ? { rows: [{ tenant_id: params[0], entity_type: params[1], status: box.change.status, base_version: box.change.baseVersion, def: box.change.def, rev: 1 }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (s.includes('INSERT INTO workflow_def_change')) {
        // def 的参数下标随调用点变化（不能写死 params[3]），按内容认：找带 states 的那个
        box.change = { status: 'draft', def: findDef(params) ?? {}, baseVersion: box.live.version };
        return { rows: [{ rev: 1 }], rowCount: 1 };
      }
      if (s.includes('UPDATE workflow_def_change')) {
        const setTo = /SET\s+status\s*=\s*'(\w+)'/.exec(s)?.[1] ?? null;
        if (box.change && setTo) box.change.status = setTo as 'draft' | 'submitted';
        return { rows: box.change ? [{ tenant_id: params[0], entity_type: params[1], status: box.change.status, base_version: box.change.baseVersion, def: box.change.def, rev: 1 }] : [], rowCount: box.change ? 1 : 0 };
      }
      if (s.includes('DELETE FROM workflow_def_change')) { box.change = null; return { rows: [], rowCount: 1 }; }
      // 落 live：def 参数位置不固定（不同调用点 INSERT 列顺序不同），按内容认——找带 states 的那个
      if (/INSERT INTO workflow_def\b/.test(s) && !s.includes('workflow_def_change') && !s.includes('workflow_def_history')) {
        const def = findDef(params);
        if (def) {
          box.insertedLiveDefs.push(typeof def === 'string' ? JSON.parse(def) : def);
          box.live = { version: box.live.version + 1, def: box.insertedLiveDefs[box.insertedLiveDefs.length - 1] };
        }
        return { rows: [], rowCount: 1 };
      }
      if (s.includes('FROM workflow_def')) {
        return { rows: [{ version: box.live.version, def: box.live.def }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

vi.mock('../db/pool.js', () => ({
  default: {
    query: async (sql: string, params: unknown[] = []) => {
      // audit() 是 pool 直连（动态 import），不走 withTenantClient —— 留痕记录必须在这里也接住
      if (String(sql).includes('INSERT INTO platform_audit')) {
        box.auditActions.push(String(params[1]));
        return { rows: [], rowCount: 1 };
      }
      if (String(sql).includes('FROM platform_config')) return { rows: [{ value: box.owner }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  },
  withTenantClient: async (_t: string, fn: (c: unknown) => unknown) => fn(makeClient()),
  assertSafeTenantId: (t: string) => t,
}));

import { errorMiddleware } from '../middleware/error.js';
import workflowDefRouter from '../routes/workflowDef.js';
import platformWorkflowRouter from '../routes/platformWorkflow.js';
import { refreshAuthMode } from '../middleware/auth.js';

const T = 't-e2e';
let server: Server;
let base = '';

beforeAll(async () => {
  process.env.AUTH_MODE = 'dev'; // 平台身份自动注入；权限点恒放行
  refreshAuthMode();
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = { tenantId: T, requestId: 'r1', userId: 'u1', username: 'admin', role: 'admin', authMode: 'dev' };
    next();
  });
  app.use('/api/v1/workflow-defs', workflowDefRouter);
  app.use('/api/v1/platform', platformWorkflowRouter);
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  delete process.env.AUTH_MODE;
  refreshAuthMode();
});

beforeEach(() => {
  box.owner = 'platform';
  box.live = { version: 1, def: OLD_DEF };
  box.change = null;
  box.auditActions = [];
  box.insertedLiveDefs = [];
});

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: Record<string, unknown> = {};
  const text = await r.text();
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
}

describe('097 端到端：客户改不了 → 运维代改 → 客户看得见 → 客户仍改不了', () => {
  it('① 客户 admin 想改流程 → 403（起点）', async () => {
    const r = await call('PUT', '/workflow-defs/work_order', { def: NEW_DEF });
    expect(r.status).toBe(403);
  });

  it('② 平台运维代客存草稿 → 200，且草稿落在**该租户**名下', async () => {
    const r = await call('PUT', `/platform/tenants/${T}/workflow-def/work_order`, { def: NEW_DEF });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.tenantId).toBe(T);
    expect(box.change?.status).toBe('draft');
  });

  // 注意：GET 返回的是**引擎机制注入后**的形态（会比原始 def 多出内置状态），
  // 所以只能断言「包含旧的、不含新增的那个」，不能断言数组全等。
  it('③ 草稿期间客户的 live 流程不含新状态（运维存草稿 ≠ 偷偷生效）', async () => {
    await call('PUT', `/platform/tenants/${T}/workflow-def/work_order`, { def: NEW_DEF });
    const g = await call('GET', '/workflow-defs/work_order');
    expect(g.status).toBe(200);
    const def = (g.body.def ?? g.body) as Record<string, unknown>;
    const states = (def.states as string[]) ?? [];
    for (const s of OLD_DEF.states) expect(states).toContain(s);
    expect(states).not.toContain('checking'); // 新草稿独有的状态还没生效
    expect(box.insertedLiveDefs.length).toBe(0); // 一次都没落 live
  });

  it('④ 运维提交 → 200（不需租户双人复核，否则单运维场景死锁）', async () => {
    await call('PUT', `/platform/tenants/${T}/workflow-def/work_order`, { def: NEW_DEF });
    const r = await call('POST', `/platform/tenants/${T}/workflow-def/work_order/submit`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(box.change?.status).toBe('submitted');
  });

  it('⑤ 运维审批 → 200，live def 真的换成新流程（不是只改了个状态字段）', async () => {
    await call('PUT', `/platform/tenants/${T}/workflow-def/work_order`, { def: NEW_DEF });
    await call('POST', `/platform/tenants/${T}/workflow-def/work_order/submit`);
    const r = await call('POST', `/platform/tenants/${T}/workflow-def/work_order/approve`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(box.insertedLiveDefs.length).toBe(1);
    expect((box.insertedLiveDefs[0].states as string[]) ?? []).toContain('checking');
    expect(box.live.version).toBe(2); // 版本自增
  });

  it('⑥ 生效后客户 GET 读到的就是新流程（改了看得见，不是白改）', async () => {
    await call('PUT', `/platform/tenants/${T}/workflow-def/work_order`, { def: NEW_DEF });
    await call('POST', `/platform/tenants/${T}/workflow-def/work_order/submit`);
    await call('POST', `/platform/tenants/${T}/workflow-def/work_order/approve`);
    const g = await call('GET', '/workflow-defs/work_order');
    const def = (g.body.def ?? g.body) as Record<string, unknown>;
    expect(((def.states as string[]) ?? [])).toContain('checking'); // 新流程里独有的状态能被客户读到
  });

  it('⑦ 被运维改过之后，客户**仍然**改不了（闸门不会因流程被改过而失效）', async () => {
    await call('PUT', `/platform/tenants/${T}/workflow-def/work_order`, { def: NEW_DEF });
    await call('POST', `/platform/tenants/${T}/workflow-def/work_order/submit`);
    await call('POST', `/platform/tenants/${T}/workflow-def/work_order/approve`);
    const r = await call('PUT', '/workflow-defs/work_order', { def: OLD_DEF });
    expect(r.status).toBe(403);
  });

  it('⑧ 全过程 audit 动作链完整可还原（draft_save → submit → approve）', async () => {
    await call('PUT', `/platform/tenants/${T}/workflow-def/work_order`, { def: NEW_DEF });
    await call('POST', `/platform/tenants/${T}/workflow-def/work_order/submit`);
    await call('POST', `/platform/tenants/${T}/workflow-def/work_order/approve`);
    expect(box.auditActions).toEqual([
      'workflow_def.draft_save',
      'workflow_def.submit',
      'workflow_def.approve',
    ]);
  });
});
