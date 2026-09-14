// v3WorkflowLocks.test.ts —— V3 流程线三件套锚定（2026-09-14 设计稿 §D4/D5/D6 测试锚点）。
//
// D4 删态硬闸（六条锚点）：
//   ① 旧 def 含 processing 且有在途单 → 保存删 processing 的新 def → 409 INFLIGHT_STATE_LOSS
//   ② 同场景 + allowInflightLoss → 放行且 history 留痕（operator/reason 非空）
//   ③ 无在途单的态可删（count=0 → 放行）
//   ④ 新增态/改边（removed=[]）→ 不触发清点查询
//   ⑤ preflight 端点返回计数与实查一致（removed/inflight_total/by_state 透传）
//   ⑥ 清点函数实体表映射（work_order→work_orders / transport_task→transport_order / 其余→business_flow_tasks+entity_type）
// D5 审批绕过收敛（五条锚点）：
//   ① PUT /workflow/def 改产草稿：响应 draft:true/status:'draft'（无 version），live 表零写入
//   ② 草稿落 workflow_def_change（draft 行存在）
//   ③ saveWorkflowDef opts 必填：空 operator/reason → 运行期 422（编译期由 tsc 保证）
//   ④ 飞轮路径留痕：optimizer.ts 调用点带 operator='auto-tune'/reason='model-optimization'（源码锚定，编译期兜底）
//   ⑤ approve 主链路回归：workflowDefApproval.http.test.ts 全量照跑（不在本文件重复）
// D6 草稿乐观锁（六条锚点）：
//   ① A 带 base_rev 过期保存 → 409 DRAFT_REV_CONFLICT
//   ② A 带 base_rev 最新保存 → 成功且返回递增 rev
//   ③ 不带 base_rev → 无条件覆盖成功（兼容路径零破坏）
//   ④ 无在途草稿首次保存 → 建行 rev=1
//   ⑤ GET /draft 返回 rev（mapChange 透传）
//   ⑥ SQL 锚定：条件 upsert 单语句原子（INSERT..ON CONFLICT..WHERE rev=$7..RETURNING rev）
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ---- mock 掉 DB 连接池：default.query 服务 authMiddleware（tenant_registry），withTenantClient 交脚本化 client ----
const h = vi.hoisted(() => ({
  registry: [] as Array<{ match: RegExp; rows: any[] }>,
  wfClient: null as unknown,
  reset: () => {
    h.registry.length = 0;
    h.wfClient = null;
  },
  scriptRegistry: (rows: any[]) => h.registry.push({ match: /FROM tenant_registry/, rows }),
}));

vi.mock('../db/pool.js', () => ({
  default: {
    query: async (sql: string, params: unknown[] = []) => {
      for (const s of h.registry) {
        if (s.match.test(sql)) return { rows: s.rows, rowCount: s.rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  },
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(h.wfClient),
}));

import { authMiddleware, signJwt, __setAuthModeForTest, __clearTenantStatusCacheForTest } from '../middleware/auth.js';
import workflowDefRouter from '../routes/workflowDef.js';
import optimizeRouter from '../routes/optimize.js';
import { saveWorkflowDef, countInflightByStates } from '../engine/workflowDef.js';
import { upsertWorkflowDefDraft, getWorkflowDefChange } from '../engine/workflowDefChange.js';
import type { WorkflowDef } from '../engine/stateMachine.js';

const T = 't-v3-locks';

// ================= 引擎层：脚本化 mock client（SQL 子串分流 + 查询日志） =================

type Handler = { match: RegExp; handle: (text: string, params: any[]) => { rows: any[]; rowCount: number } };

function makeScriptedClient(handlers: Handler[] = []) {
  const log: Array<{ text: string; params: any[] }> = [];
  return {
    log,
    query: async (text: string, params: any[] = []) => {
      log.push({ text, params });
      for (const hd of handlers) {
        if (hd.match.test(text)) return hd.handle(text, params);
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const OLD_DEF: WorkflowDef = {
  initial: 'draft',
  states: ['draft', 'assigned', 'processing', 'completed'],
  transitions: [{ from: 'draft', to: 'assigned', event: 'dispatch' }],
  config: {},
};

const NEW_DEF_DROP_PROCESSING: WorkflowDef = {
  initial: 'draft',
  states: ['draft', 'assigned', 'completed'],
  transitions: [{ from: 'draft', to: 'assigned', event: 'dispatch' }],
  config: {},
};

function seedLiveHandler(def: unknown, version = 3): Handler {
  return {
    match: /SELECT version, def FROM workflow_def/,
    handle: () => ({ rows: [{ version, def }], rowCount: 1 }),
  };
}

function inflightHandler(rows: any[]): Handler {
  return {
    match: /GROUP BY status/,
    handle: () => ({ rows, rowCount: rows.length }),
  };
}

// ================= D4：saveWorkflowDef 删态硬闸 =================

describe('D4 删态硬闸（saveWorkflowDef + countInflightByStates）', () => {
  it('① 旧 def 含 processing 且 4 单在途 → 删 processing 的新 def → 409 INFLIGHT_STATE_LOSS，live/history 零写入', async () => {
    const c = makeScriptedClient([
      seedLiveHandler(OLD_DEF),
      inflightHandler([{ status: 'processing', n: 4 }]),
    ]);
    await expect(
      saveWorkflowDef(c as any, T, 'work_order', NEW_DEF_DROP_PROCESSING, { operator: 'op', reason: 'test' }),
    ).rejects.toMatchObject({ code: 'INFLIGHT_STATE_LOSS', status: 409 });
    // 硬闸在写库之前：history 快照与 workflow_def upsert 均未执行
    expect(c.log.some((q) => q.text.includes('INSERT INTO workflow_def_history'))).toBe(false);
    expect(c.log.some((q) => q.text.includes('INSERT INTO workflow_def '))).toBe(false);
    // 错误信息带计数明细（管理员可读）
    await expect(
      saveWorkflowDef(c as any, T, 'work_order', NEW_DEF_DROP_PROCESSING, { operator: 'op', reason: 'test' }),
    ).rejects.toThrow(/4 张在途单失联/);
  });

  it('② 同场景 + allowInflightLoss → 放行：history 快照 + workflow_def upsert 照常执行', async () => {
    const c = makeScriptedClient([
      seedLiveHandler(OLD_DEF),
      inflightHandler([{ status: 'processing', n: 4 }]),
    ]);
    await expect(
      saveWorkflowDef(c as any, T, 'work_order', NEW_DEF_DROP_PROCESSING, {
        operator: 'gatekeeper',
        reason: 'approve',
        allowInflightLoss: true,
      }),
    ).resolves.toBeUndefined();
    const hist = c.log.find((q) => q.text.includes('INSERT INTO workflow_def_history'));
    expect(hist).toBeTruthy();
    expect(hist!.params[4]).toBe('gatekeeper'); // operator 留痕
    expect(hist!.params[5]).toBe('approve'); // reason 留痕
    expect(c.log.some((q) => q.text.includes('INSERT INTO workflow_def '))).toBe(true);
  });

  it('③ 无在途单的态可删：count=0 → 放行（不抛 409）', async () => {
    const c = makeScriptedClient([seedLiveHandler(OLD_DEF), inflightHandler([])]);
    await expect(
      saveWorkflowDef(c as any, T, 'work_order', NEW_DEF_DROP_PROCESSING, { operator: 'op', reason: 'test' }),
    ).resolves.toBeUndefined();
  });

  it('④ 新增态/改边（removed=[]）→ 不发在途清点查询', async () => {
    const bigger: WorkflowDef = {
      ...OLD_DEF,
      states: [...OLD_DEF.states, 'escalated'],
      transitions: [...OLD_DEF.transitions, { from: 'processing', to: 'escalated', event: 'auto_escalate' }],
    };
    const c = makeScriptedClient([seedLiveHandler(OLD_DEF)]);
    await expect(
      saveWorkflowDef(c as any, T, 'work_order', bigger, { operator: 'op', reason: 'test' }),
    ).resolves.toBeUndefined();
    expect(c.log.some((q) => q.text.includes('GROUP BY status'))).toBe(false);
  });

  it('⑥ 清点函数实体表映射：work_order→work_orders / transport_task→transport_order / 未知→business_flow_tasks+entity_type', async () => {
    const c1 = makeScriptedClient([inflightHandler([{ status: 'processing', n: 2 }])]);
    const r1 = await countInflightByStates(c1 as any, T, 'work_order', ['processing']);
    expect(c1.log[0].text).toContain('FROM work_orders');
    expect(c1.log[0].params[1]).toEqual(['processing']);
    expect(r1).toEqual({ total: 2, byState: { processing: 2 } });

    const c2 = makeScriptedClient([inflightHandler([])]);
    await countInflightByStates(c2 as any, T, 'transport_task', ['en_route']);
    expect(c2.log[0].text).toContain('FROM transport_order');

    const c3 = makeScriptedClient([inflightHandler([{ status: 'pending', n: 1 }, { status: 'running', n: 3 }])]);
    const r3 = await countInflightByStates(c3 as any, T, 'cycle_check', ['pending', 'running']);
    expect(c3.log[0].text).toContain('FROM business_flow_tasks');
    expect(c3.log[0].text).toContain('entity_type = $2');
    expect(c3.log[0].params[1]).toBe('cycle_check');
    expect(r3).toEqual({ total: 4, byState: { pending: 1, running: 3 } });
  });

  it('D5③ saveWorkflowDef 空 operator/reason → 运行期 422（opts 必填的运行期兜底）', async () => {
    const c = makeScriptedClient([]);
    await expect(
      saveWorkflowDef(c as any, T, 'work_order', OLD_DEF, { operator: '', reason: 'x' }),
    ).rejects.toMatchObject({ status: 422, code: 'BAD_REQUEST' });
    await expect(
      saveWorkflowDef(c as any, T, 'work_order', OLD_DEF, { operator: 'x', reason: '  ' }),
    ).rejects.toMatchObject({ status: 422 });
    // 留痕校验先于任何查询（不发 SQL）
    expect(c.log.length).toBe(0);
  });
});

// ================= D6：upsertWorkflowDefDraft 乐观锁（引擎层 SQL 锚定） =================

describe('D6 草稿乐观锁（upsertWorkflowDefDraft 条件 upsert）', () => {
  const DEF: WorkflowDef = { initial: 'draft', states: ['draft', 'done'], transitions: [], config: {} };

  it('③ 不带 baseRev → SQL 无 WHERE 比对段（无条件覆盖，兼容路径零破坏）', async () => {
    const c = makeScriptedClient([
      { match: /SELECT version FROM workflow_def/, handle: () => ({ rows: [{ version: 2 }], rowCount: 1 }) },
      { match: /INSERT INTO workflow_def_change/, handle: () => ({ rows: [{ rev: 3 }], rowCount: 1 }) },
    ]);
    const r = await upsertWorkflowDefDraft(c as any, T, 'work_order', DEF, { operator: 'u1' });
    expect(r).toEqual({ rev: 3 });
    const up = c.log.find((q) => q.text.includes('INSERT INTO workflow_def_change'))!;
    expect(up.text).not.toMatch(/WHERE workflow_def_change\.rev/);
    expect(up.params.length).toBe(6);
    expect(up.params[4]).toBe(2); // base_version 锚 = live version（submit 时刻为准覆写，语义不变）
  });

  it('① baseRev 过期 → 0 行返回 → 409 DRAFT_REV_CONFLICT', async () => {
    const c = makeScriptedClient([
      { match: /SELECT version FROM workflow_def/, handle: () => ({ rows: [{ version: 2 }], rowCount: 1 }) },
      { match: /INSERT INTO workflow_def_change/, handle: () => ({ rows: [], rowCount: 0 }) },
    ]);
    await expect(
      upsertWorkflowDefDraft(c as any, T, 'work_order', DEF, { operator: 'u1', baseRev: 3 }),
    ).rejects.toMatchObject({ code: 'DRAFT_REV_CONFLICT', status: 409 });
  });

  it('②⑥ baseRev 最新 → params 带 $7=baseRev、RETURNING rev，单语句原子（无读-比-写 TOCTOU）', async () => {
    const c = makeScriptedClient([
      { match: /SELECT version FROM workflow_def/, handle: () => ({ rows: [{ version: 2 }], rowCount: 1 }) },
      { match: /INSERT INTO workflow_def_change/, handle: () => ({ rows: [{ rev: 4 }], rowCount: 1 }) },
    ]);
    const r = await upsertWorkflowDefDraft(c as any, T, 'work_order', DEF, { operator: 'u1', note: 'n', baseRev: 3 });
    expect(r).toEqual({ rev: 4 });
    const up = c.log.find((q) => q.text.includes('INSERT INTO workflow_def_change'))!;
    expect(up.text).toMatch(/WHERE workflow_def_change\.rev = \$7/);
    expect(up.text).toMatch(/RETURNING rev/);
    expect(up.text).toMatch(/rev = workflow_def_change\.rev \+ 1/); // 修订号随内容保存递增
    expect(up.params.length).toBe(7);
    expect(up.params[6]).toBe(3);
  });

  it('④ 首次保存（无在途行）→ INSERT 分支 rev=1（mock 模拟 PG INSERT..RETURNING 语义）', async () => {
    const c = makeScriptedClient([
      { match: /SELECT version FROM workflow_def/, handle: () => ({ rows: [], rowCount: 0 }) },
      {
        match: /INSERT INTO workflow_def_change/,
        handle: () => ({ rows: [{ rev: 1 }], rowCount: 1 }), // 真实 PG：无冲突走 INSERT 分支，RETURNING rev=1
      },
    ]);
    const r = await upsertWorkflowDefDraft(c as any, T, 'work_order', DEF, { operator: 'u1' });
    expect(r).toEqual({ rev: 1 });
  });

  it('⑤ mapChange 透传 rev：GET /draft 数据源 row.rev=7 → change.rev=7；存量行无 rev → 兜底 1', async () => {
    const row = {
      id: 1,
      entity_type: 'work_order',
      def: JSON.stringify(DEF),
      note: null,
      status: 'draft',
      base_version: 2,
      rev: 7,
      created_by: 'u1',
      submitted_by: null,
      submitted_at: null,
      reject_comment: null,
      updated_at: new Date().toISOString(),
    };
    const c = makeScriptedClient([
      { match: /SELECT \* FROM workflow_def_change/, handle: () => ({ rows: [row], rowCount: 1 }) },
    ]);
    const change = await getWorkflowDefChange(c as any, T, 'work_order');
    expect(change?.rev).toBe(7);

    const c2 = makeScriptedClient([
      { match: /SELECT \* FROM workflow_def_change/, handle: () => ({ rows: [{ ...row, rev: undefined }], rowCount: 1 }) },
    ]);
    const change2 = await getWorkflowDefChange(c2 as any, T, 'work_order');
    expect(change2?.rev).toBe(1); // 088 加列 DEFAULT 1，存量行自动获得（防御性兜底）
  });
});

// ================= 路由层：状态内存库（workflow_def / change 最小仿真 + rev 语义） =================

interface WfRow {
  version: number;
  def: any;
}
interface ChangeRow {
  id: number;
  tenant_id: string;
  entity_type: string;
  def: any;
  note: string | null;
  status: string;
  base_version: number;
  rev: number;
  created_by: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  reject_comment: string | null;
}

function makeWfDb() {
  return {
    defs: new Map<string, WfRow>(),
    history: [] as Array<{ key: string; version: number; def: any; operator: string | null; reason: string | null }>,
    changes: new Map<string, ChangeRow>(),
    permRows: [] as Array<{ perm: string }>,
  };
}
type WfDb = ReturnType<typeof makeWfDb>;
let changeSeq = 0;

function makeClient(db: WfDb, _tenant: string) {
  return {
    query: async (text: string, params: any[] = []) => {
      if (text.includes('FROM role_permission')) {
        return { rows: db.permRows, rowCount: db.permRows.length };
      }
      if (text.includes('workflow_def_change')) {
        const key = `${params[0]}|${params[1]}`;
        if (text.startsWith('INSERT INTO workflow_def_change')) {
          // V3-D6 条件 upsert：带 WHERE rev=$7 → 原子比对；未命中 0 行（仓储层抛 409）
          const prev = db.changes.get(key);
          const lockRev = /WHERE workflow_def_change\.rev = \$7/.test(text) ? Number(params[6]) : null;
          if (lockRev !== null && (prev?.rev ?? 1) !== lockRev) {
            return { rows: [], rowCount: 0 };
          }
          const newRev = prev ? prev.rev + 1 : 1;
          db.changes.set(key, {
            id: prev?.id ?? ++changeSeq,
            tenant_id: params[0],
            entity_type: params[1],
            def: params[2],
            note: params[3],
            status: 'draft',
            base_version: params[4],
            rev: newRev,
            created_by: params[5],
            submitted_by: prev?.submitted_by ?? null,
            submitted_at: prev?.submitted_at ?? null,
            reject_comment: prev?.reject_comment ?? null,
          });
          return { rows: [{ rev: newRev }], rowCount: 1 };
        }
        if (text.startsWith('SELECT * FROM workflow_def_change')) {
          const row = db.changes.get(key);
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        if (/SET status\s*=\s*'submitted'/.test(text)) {
          // 提交（draft→submitted）：params = [tenant, entity, submittedBy, baseVersion]；仅 draft 行
          const row = db.changes.get(key);
          if (!row || row.status !== 'draft') return { rows: [], rowCount: 0 };
          row.status = 'submitted';
          row.submitted_by = params[2];
          row.base_version = params[3];
          row.submitted_at = new Date().toISOString();
          return { rows: [row], rowCount: 1 };
        }
      }
      if (text.includes('INSERT INTO workflow_def_history')) {
        db.history.push({
          key: `${params[0]}|${params[1]}`,
          version: params[2],
          def: JSON.parse(params[3]),
          operator: params[4],
          reason: params[5],
        });
        return { rows: [], rowCount: 1 };
      }
      if (/^INSERT INTO workflow_def \(/.test(text)) {
        const key = `${params[0]}|${params[1]}`;
        const cur = db.defs.get(key);
        const defObj = typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2];
        db.defs.set(key, { version: cur ? cur.version + 1 : 1, def: defObj });
        return { rows: [], rowCount: 1 };
      }
      if (/^SELECT version, def FROM workflow_def /.test(text)) {
        const cur = db.defs.get(`${params[0]}|${params[1]}`);
        return { rows: cur ? [{ version: cur.version, def: cur.def }] : [], rowCount: cur ? 1 : 0 };
      }
      if (/^SELECT def FROM workflow_def /.test(text)) {
        const cur = db.defs.get(`${params[0]}|${params[1]}`);
        return { rows: cur ? [{ def: cur.def }] : [], rowCount: cur ? 1 : 0 };
      }
      if (/^SELECT version FROM workflow_def /.test(text)) {
        const cur = db.defs.get(`${params[0]}|${params[1]}`);
        return { rows: cur ? [{ version: cur.version }] : [], rowCount: cur ? 1 : 0 };
      }
      if (/SELECT status, COUNT\(\*\)::int AS n FROM business_flow_tasks/.test(text)) {
        return { rows: [], rowCount: 0 }; // 路由层默认无在途单
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// ================= 请求工具 =================

let server: Server;
let base = '';
let db: WfDb;

function makeToken(role: string, username = `${role}-user`): string {
  return signJwt(
    { tid: T, sub: 'u-' + username, username, role, exp: Math.floor(Date.now() / 1000) + 600 },
    'test-v3-locks-secret',
  );
}

async function api(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, code: 'NON_JSON', message: `non-json: ${text.slice(0, 200)}` };
  }
  return { status: r.status, json };
}

const goodDef = { initial: 'draft', states: ['draft', 'assigned', 'completed'], transitions: [] as any[] };

let app: express.Express;

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-v3-locks-secret';
  app = express();
  app.use(express.json());
  app.use('/api', authMiddleware); // 与生产 server.ts 同序
  app.use('/api/v1', optimizeRouter); // server.ts:192（PUT /api/v1/workflow/def）
  app.use('/api/v1/workflow-defs', workflowDefRouter); // server.ts:201
  app.use(errorMiddleware);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  __setAuthModeForTest('prod');
  __clearTenantStatusCacheForTest();
  h.reset();
  h.scriptRegistry([{ status: 'active' }]);
  db = makeWfDb();
  h.wfClient = makeClient(db, T);
});

afterEach(() => {
  __setAuthModeForTest('dev');
});

describe('D4/D6 路由层（workflow-defs）', () => {
  it('D6④ 无在途草稿首次保存 → 建行 rev=1，响应带 rev', async () => {
    const admin = makeToken('admin', 'admin-a');
    const r = await api('PUT', '/api/v1/workflow-defs/lockcase/draft', admin, { name: 'x', def: goodDef });
    expect(r.status).toBe(200);
    expect(r.json.draft).toBe(true);
    expect(r.json.rev).toBe(1);
  });

  it('D6②③ 不带 base_rev 覆盖成功 rev 递增；带过期 base_rev → 409 DRAFT_REV_CONFLICT；带最新 → 成功', async () => {
    const adminA = makeToken('admin', 'admin-a');
    const adminB = makeToken('admin', 'admin-b');
    // A 首存 rev=1
    const r1 = await api('PUT', '/api/v1/workflow-defs/lockcase/draft', adminA, { name: 'x', def: goodDef });
    expect(r1.json.rev).toBe(1);
    // B 无 base_rev 覆盖 → rev=2（兼容路径零破坏）
    const r2 = await api('PUT', '/api/v1/workflow-defs/lockcase/draft', adminB, { name: 'y', def: goodDef });
    expect(r2.status).toBe(200);
    expect(r2.json.rev).toBe(2);
    // A 用过期 base_rev=1 保存 → 409（他人已推进）
    const stale = await api('PUT', '/api/v1/workflow-defs/lockcase/draft', adminA, {
      name: 'a-stale', def: goodDef, base_rev: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('DRAFT_REV_CONFLICT');
    // A 用最新 base_rev=2 保存 → 成功 rev=3
    const fresh = await api('PUT', '/api/v1/workflow-defs/lockcase/draft', adminA, {
      name: 'a-fresh', def: goodDef, base_rev: 2,
    });
    expect(fresh.status).toBe(200);
    expect(fresh.json.rev).toBe(3);
  });

  it('D6⑤ GET /draft 返回 rev（mapChange 透传）', async () => {
    const admin = makeToken('admin', 'admin-a');
    await api('PUT', '/api/v1/workflow-defs/lockcase/draft', admin, { name: 'x', def: goodDef });
    await api('PUT', '/api/v1/workflow-defs/lockcase/draft', admin, { name: 'y', def: goodDef });
    const g = await api('GET', '/api/v1/workflow-defs/lockcase/draft', admin);
    expect(g.status).toBe(200);
    expect(g.json.change.rev).toBe(2);
  });

  it('D4⑤ preflight 预演端点：removed 计数透传（无在途单 → inflight_total=0）', async () => {
    const admin = makeToken('admin', 'admin-a');
    db.defs.set(`${T}|lockcase`, { version: 1, def: OLD_DEF });
    const r = await api('POST', '/api/v1/workflow-defs/lockcase/preflight', admin, { def: NEW_DEF_DROP_PROCESSING });
    expect(r.status).toBe(200);
    expect(r.json.removed).toEqual(['processing']);
    expect(r.json.inflight_total).toBe(0); // mock business_flow_tasks/work_orders 恒空
    expect(r.json.by_state).toEqual({});
    // 新增态不触发 removed
    const r2 = await api('POST', '/api/v1/workflow-defs/lockcase/preflight', admin, {
      def: { ...OLD_DEF, states: [...OLD_DEF.states, 'escalated'] },
    });
    expect(r2.json.removed).toEqual([]);
  });

  it('D4①⑥ 路由层硬闸：approve 携带删态草稿 + 在途单 → 409 INFLIGHT_STATE_LOSS（confirm_inflight_loss 后放行）', async () => {
    // live：4 态含 processing；模拟 work_orders 有 4 单在途
    db.defs.set(`${T}|work_order`, { version: 1, def: OLD_DEF });
    const adminA = makeToken('admin', 'admin-a');
    const adminB = makeToken('admin', 'admin-b');
    // 草稿删 processing → 提交 → approve
    const drop: WorkflowDef = JSON.parse(JSON.stringify(NEW_DEF_DROP_PROCESSING));
    await api('PUT', '/api/v1/workflow-defs/work_order/draft', adminA, { name: '删态稿', def: drop });
    await api('POST', '/api/v1/workflow-defs/work_order/submit', adminA);
    // 该 client 的 countInflightByStates 查询命中 work_orders SQL → 默认空。这里临时注入在途行：
    const rich = h.wfClient as any;
    const origQuery = rich.query.bind(rich);
    rich.query = async (text: string, params: any[] = []) => {
      if (/SELECT status, COUNT\(\*\)::int AS n FROM work_orders/.test(text)) {
        return { rows: [{ status: 'processing', n: 4 }], rowCount: 1 };
      }
      return origQuery(text, params);
    };
    const denied = await api('POST', '/api/v1/workflow-defs/work_order/approve', adminB);
    expect(denied.status).toBe(409);
    expect(denied.json.code).toBe('INFLIGHT_STATE_LOSS');
    // live 未被触碰
    expect(db.defs.get(`${T}|work_order`)?.version).toBe(1);
    // 显式二次确认 → 放行且 history 留痕
    const okd = await api('POST', '/api/v1/workflow-defs/work_order/approve', adminB, { confirm_inflight_loss: true });
    expect(okd.status).toBe(200);
    expect(okd.json.approved).toBe(true);
    const hist = db.history.find((x) => x.key === `${T}|work_order` && x.reason === 'approve');
    expect(hist).toBeTruthy();
    expect(hist!.operator).toBe('admin-b');
    // live 推进
    expect(db.defs.get(`${T}|work_order`)?.version).toBe(2);
  });
});

describe('D5 审批绕过收敛（PUT /workflow/def → 草稿）', () => {
  it('D5①② 响应 draft:true/status:draft（无 version）；live 表零写入；草稿落 change 行', async () => {
    const admin = makeToken('admin', 'admin-a');
    db.defs.set(`${T}|work_order`, { version: 7, def: OLD_DEF });
    const r = await api('PUT', '/api/v1/workflow/def', admin, {
      entity: 'work_order',
      def: { initial: 'draft', states: ['draft', 'assigned', 'completed'], transitions: [] },
    });
    expect(r.status).toBe(200);
    expect(r.json.draft).toBe(true);
    expect(r.json.status).toBe('draft');
    expect(r.json.entity_type).toBe('work_order');
    expect(r.json.version).toBeUndefined(); // 语义变化：不再返回 live version
    // live 零写入：version 不变
    expect(db.defs.get(`${T}|work_order`)?.version).toBe(7);
    // 草稿落 change 行
    expect(db.changes.get(`${T}|work_order`)?.status).toBe('draft');
  });

  it('D5④ 飞轮调用点留痕（源码锚定）：optimizer.ts saveWorkflowDef 带 operator=auto-tune/reason=model-optimization', () => {
    // 编译期强制（opts 必填）已由 tsc 保证；此处源码锚定具体留痕值，防后续回退。
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'services', 'optimizer.ts'), 'utf-8');
    expect(src).toMatch(/operator:\s*'auto-tune'/);
    expect(src).toMatch(/reason:\s*'model-optimization'/);
    // optimize.ts 不再直写 live（saveWorkflowDef 调用已移除，改产草稿）
    const optSrc = readFileSync(join(here, '..', 'routes', 'optimize.ts'), 'utf-8');
    expect(optSrc).not.toMatch(/saveWorkflowDef/);
    expect(optSrc).toMatch(/upsertWorkflowDefDraft/);
  });
});
