// workflowDefApproval.http.test.ts —— 流程配置「提交→审核」一期 8 例（设计 §8 锚定清单）。
//
// harness 同 statsPerm.http.test.ts：真 authMiddleware + 真 JWT 验签（prod 模式），
// DB 连接池 mock 为「有状态内存库」——对 workflow_def / workflow_def_history / workflow_def_change
// 三张表做最小 SQL 语义仿真（INSERT/UPDATE/SELECT/DELETE + RETURNING 行为），
// 断言真实 HTTP 状态码、业务错误码与状态机不变量。
//
// 覆盖（设计 §8）：
//   ① 双权限分离：operator（租户覆盖授 workflow.edit、无 approve）可存草稿/提交，approve/reject/pending 均 403
//   ② 自审自批 403（SELF_APPROVAL）：同一账号提交后自己 approve 被拒，admin 也不例外
//   ③ 通过后：live version 自增、GET /:entityType 立即可见新 def、history 出现 reason='approve'、change 行已删
//   ④ 驳回后：live def 与 version 均不变，草稿保留且带 reject_comment，可改再提
//   ⑤ DRAFT_STALE：提交后 live 被另一路径（rollback）推进版本，approve 返回 409
//   ⑥ 存量兼容：无 change 行的实体，GET /:entityType 与 GET /（列表）照常（零断链）
//   ⑦ rollback：有 workflow.edit 无 approve 的账号回滚 403；有 approve 的直接生效
//   ⑧ generate-from-theme/import 落草稿不落 live；enable-acceptance added=0 幂等直通
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';
import { ensureAcceptanceEdges } from '../engine/acceptanceEdges.js';
import { DEFAULT_WORK_ORDER_DEF } from '../engine/stateMachine.js';

// ---- mock 掉 DB 连接池：default.query 服务 authMiddleware（tenant_registry），withTenantClient 交有状态 fake client ----
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

const T = 't-wf-approval';
let server: Server;
let base = '';

function makeToken(role: string, username = `${role}-user`): string {
  return signJwt(
    { tid: T, sub: 'u-' + username, username, role, exp: Math.floor(Date.now() / 1000) + 600 },
    'test-wf-approval-secret',
  );
}

// ================= 有状态内存库（三张表最小 SQL 仿真） =================

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
  created_by: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  reject_comment: string | null;
}

function makeWfDb() {
  return {
    defs: new Map<string, WfRow>(), // key: `${tenant}|${entityType}`
    history: [] as Array<{ key: string; version: number; def: any; operator: string | null; reason: string | null }>,
    changes: new Map<string, ChangeRow>(), // key: `${tenant}|${entityType}`（UNIQUE(tenant_id, entity_type)）
    permRows: [] as Array<{ perm: string }>, // requirePermission 租户覆盖行
  };
}
type WfDb = ReturnType<typeof makeWfDb>;
let changeSeq = 0;

function makeClient(db: WfDb, _tenant: string) {
  return {
    query: async (text: string, params: any[] = []) => {
      // requirePermission / requireAnyPermission 的租户级权限查询
      if (text.includes('FROM role_permission')) {
        return { rows: db.permRows, rowCount: db.permRows.length };
      }
      // ---- workflow_def_change（change 仓储 SQL 全集，必须先于 workflow_def 判定）----
      if (text.includes('workflow_def_change')) {
        const key = `${params[0]}|${params[1]}`;
        if (text.startsWith('INSERT INTO workflow_def_change')) {
          // upsert 草稿：params = [tenant, entity, def, note, baseVersion, createdBy]
          const prev = db.changes.get(key);
          db.changes.set(key, {
            id: prev?.id ?? ++changeSeq,
            tenant_id: params[0],
            entity_type: params[1],
            def: params[2],
            note: params[3],
            status: 'draft',
            base_version: params[4],
            created_by: params[5],
            submitted_by: prev?.submitted_by ?? null,
            submitted_at: prev?.submitted_at ?? null,
            reject_comment: prev?.reject_comment ?? null,
          });
          return { rows: [], rowCount: 1 };
        }
        if (text.includes("SET status = 'submitted'") || /SET status\s*=\s*'submitted'/.test(text)) {
          // 提交：params = [tenant, entity, submittedBy, baseVersion]；仅 draft 行
          const row = db.changes.get(key);
          if (!row || row.status !== 'draft') return { rows: [], rowCount: 0 };
          row.status = 'submitted';
          row.submitted_by = params[2];
          row.base_version = params[3];
          row.submitted_at = new Date().toISOString();
          return { rows: [row], rowCount: 1 };
        }
        if (/reject_comment\s*=\s*\$3/.test(text)) {
          // 驳回：params = [tenant, entity, comment]；仅 submitted 行
          const row = db.changes.get(key);
          if (!row || row.status !== 'submitted') return { rows: [], rowCount: 0 };
          row.status = 'draft';
          row.reject_comment = params[2];
          return { rows: [row], rowCount: 1 };
        }
        if (/status\s*=\s*'submitted'\s+ORDER BY/.test(text)) {
          // 在审清单
          const rows = [...db.changes.values()].filter((r) => r.tenant_id === params[0] && r.status === 'submitted');
          return { rows, rowCount: rows.length };
        }
        if (text.startsWith('SELECT * FROM workflow_def_change')) {
          const row = db.changes.get(key);
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        if (text.startsWith('DELETE FROM workflow_def_change')) {
          db.changes.delete(key);
          return { rows: [], rowCount: 1 };
        }
      }
      // ---- workflow_def_history ----
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
      if (text.includes('FROM workflow_def_history')) {
        const key = `${params[0]}|${params[1]}`;
        let rows = db.history
          .filter((x) => x.key === key)
          .map((x) => ({ version: x.version, def: x.def, operator: x.operator, reason: x.reason, created_at: new Date().toISOString() }));
        if (text.includes('AND version = $3')) rows = rows.filter((x) => x.version === params[2]);
        return { rows, rowCount: rows.length };
      }
      // ---- workflow_def ----
      if (/^INSERT INTO workflow_def \(/.test(text)) {
        // saveWorkflowDef upsert / ensureWorkflowDef 首插：版本自增语义（首插=1）
        const key = `${params[0]}|${params[1]}`;
        const cur = db.defs.get(key);
        const defObj = typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2];
        db.defs.set(key, { version: cur ? cur.version + 1 : 1, def: defObj });
        return { rows: [], rowCount: 1 };
      }
      if (/^SELECT entity_type, version, def(, updated_at)? FROM workflow_def/.test(text)) {
        // GET / 列表：返回该租户全部 def 行
        const rows = [...db.defs.entries()]
          .filter(([k]) => k.startsWith(`${params[0]}|`))
          .map(([k, v]) => ({
            entity_type: k.split('|')[1],
            version: v.version,
            def: v.def,
            updated_at: new Date().toISOString(),
          }));
        return { rows, rowCount: rows.length };
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
      return { rows: [], rowCount: 0 };
    },
  };
}

let db: WfDb;

function seedLive(entityType: string, def: any, version = 1): void {
  db.defs.set(`${T}|${entityType}`, { version, def });
}
function seedHistory(entityType: string, version: number, def: any): void {
  db.history.push({ key: `${T}|${entityType}`, version, def, operator: 'seed', reason: 'seed' });
}

// ================= 请求工具 =================

const goodDef = {
  initial: 'draft',
  states: ['draft', 'assigned', 'processing', 'completed'],
  transitions: [] as any[],
};

function draftBody(name: string, note = '测试变更') {
  return { name, note, def: JSON.parse(JSON.stringify(goodDef)) };
}

async function api(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${base}/api/v1/workflow-defs${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, code: 'NON_JSON', message: `non-json response: ${text.slice(0, 200)}` };
  }
  return { status: r.status, json };
}

let app: express.Express;

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-wf-approval-secret';
  app = express();
  app.use(express.json());
  app.use('/api', authMiddleware); // 与生产 server.ts 同序
  app.use('/api/v1/workflow-defs', workflowDefRouter); // 与生产 server.ts:201 挂载一致
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

describe('流程配置「提交→审核」一期（设计 §8 八例）', () => {
  it('① 双权限分离：operator（租户覆盖授 workflow.edit、无 approve）可存草稿/提交，approve/reject/pending 均 403', async () => {
    db.permRows = [{ perm: 'workflow.edit' }]; // 租户级覆盖：该角色仅 edit
    const op = makeToken('operator');
    const put = await api('PUT', '/repair/draft', op, draftBody('维修流程'));
    expect(put.status).toBe(200);
    expect(put.json.draft).toBe(true);

    const submit = await api('POST', '/repair/submit', op);
    expect(submit.status).toBe(200);
    expect(submit.json.status).toBe('submitted');

    const approve = await api('POST', '/repair/approve', op);
    expect(approve.status, `期望 403，实际 ${approve.status}`).toBe(403);
    expect(approve.json.code).toBe('FORBIDDEN');
    expect(String(approve.json.message)).toContain('workflow.approve');

    const reject = await api('POST', '/repair/reject', op, { comment: 'x' });
    expect(reject.status).toBe(403);

    const pending = await api('GET', '/pending', op);
    expect(pending.status).toBe(403);
  });

  it('② 自审自批 403（SELF_APPROVAL）：admin 提交后自己 approve 被拒，admin 不豁免', async () => {
    const adminA = makeToken('admin', 'admin-a');
    await api('PUT', '/repair/draft', adminA, draftBody('维修流程'));
    await api('POST', '/repair/submit', adminA);
    const approve = await api('POST', '/repair/approve', adminA);
    expect(approve.status, `期望 403，实际 ${approve.status}`).toBe(403);
    expect(approve.json.code).toBe('SELF_APPROVAL');
    // live 不被自批触碰：无 change 行被消费（approve 前置校验先于 saveWorkflowDef）
    expect(db.defs.has(`${T}|repair`)).toBe(false);
  });

  it('③ 通过后：live version 自增、新 def 立即可见、history 出现 reason=approve 快照、change 行已删', async () => {
    seedLive('repair', { initial: 'draft', states: ['draft'], transitions: [], config: { name: '旧名' } });
    const adminA = makeToken('admin', 'admin-a');
    const adminB = makeToken('admin', 'admin-b');
    await api('PUT', '/repair/draft', adminA, draftBody('新名'));
    await api('POST', '/repair/submit', adminA);
    const approve = await api('POST', '/repair/approve', adminB);
    expect(approve.status).toBe(200);
    expect(approve.json.approved).toBe(true);
    expect(approve.json.version).toBe('incremented');

    const live = await api('GET', '/repair', adminB);
    expect(live.status).toBe(200);
    expect(live.json.def.config.name).toBe('新名');

    const versions = await api('GET', '/repair/versions', adminB);
    expect(versions.json.currentVersion).toBe(2);
    expect(versions.json.history[0].reason).toBe('approve');
    expect(versions.json.history[0].version).toBe(1);

    const draft = await api('GET', '/repair/draft', adminB);
    expect(draft.status, 'approve 后 change 行必须已删').toBe(404);
    expect(draft.json.code).toBe('NO_DRAFT');
  });

  it('④ 驳回后：live def 与 version 均不变，草稿保留且带 reject_comment，可改再提', async () => {
    seedLive('repair', { initial: 'draft', states: ['draft'], transitions: [], config: { name: '旧名' } });
    const adminA = makeToken('admin', 'admin-a');
    const adminB = makeToken('admin', 'admin-b');
    await api('PUT', '/repair/draft', adminA, draftBody('改法一'));
    await api('POST', '/repair/submit', adminA);
    const reject = await api('POST', '/repair/reject', adminB, { comment: '缺少回退边，退回改' });
    expect(reject.status).toBe(200);
    expect(reject.json.rejected).toBe(true);
    expect(reject.json.status).toBe('draft');

    // live 不动
    const live = await api('GET', '/repair', adminB);
    expect(live.json.def.config.name).toBe('旧名');
    const versions = await api('GET', '/repair/versions', adminB);
    expect(versions.json.currentVersion).toBe(1);

    // 草稿保留 + 驳回意见可见
    const draft = await api('GET', '/repair/draft', adminA);
    expect(draft.status).toBe(200);
    expect(draft.json.change.status).toBe('draft');
    expect(draft.json.change.rejectComment).toBe('缺少回退边，退回改');

    // 可改再提
    await api('PUT', '/repair/draft', adminA, draftBody('改法二'));
    const resubmit = await api('POST', '/repair/submit', adminA);
    expect(resubmit.status).toBe(200);
    expect(resubmit.json.baseVersion).toBe(1);
  });

  it('⑤ DRAFT_STALE：提交后 live 被 rollback 推进版本，approve 返回 409', async () => {
    const oldDef = { initial: 'draft', states: ['draft'], transitions: [], config: { name: '旧名' } };
    seedLive('repair', oldDef);
    seedHistory('repair', 1, oldDef);
    const adminA = makeToken('admin', 'admin-a');
    const adminB = makeToken('admin', 'admin-b');
    await api('PUT', '/repair/draft', adminA, draftBody('改法一'));
    const submit = await api('POST', '/repair/submit', adminA);
    expect(submit.json.baseVersion).toBe(1);

    // 另一路径（rollback）推进 live：1 → 2
    const rollback = await api('POST', '/repair/versions/1/rollback', adminB);
    expect(rollback.status).toBe(200);

    const approve = await api('POST', '/repair/approve', adminB);
    expect(approve.status, `期望 409，实际 ${approve.status}`).toBe(409);
    expect(approve.json.code).toBe('DRAFT_STALE');
    // live 仍是 rollback 后的版本 2，未被脏写
    const versions = await api('GET', '/repair/versions', adminB);
    expect(versions.json.currentVersion).toBe(2);
  });

  it('⑥ 存量兼容：无 change 行的实体，GET /:entityType 与 GET /（列表）照常（零断链）', async () => {
    seedLive('repair', { initial: 'draft', states: ['draft'], transitions: [], config: { name: '旧名' } });
    const admin = makeToken('admin');
    const one = await api('GET', '/repair', admin);
    expect(one.status).toBe(200);
    expect(one.json.def.config.name).toBe('旧名');
    const list = await api('GET', '/', admin);
    expect(list.status).toBe(200);
    expect(list.json.items.length).toBe(1);
    expect(list.json.items[0].entityType).toBe('repair');
  });

  it('⑦ rollback：有 workflow.edit 无 approve 的账号回滚 403；有 approve 的直接生效', async () => {
    const oldDef = { initial: 'draft', states: ['draft'], transitions: [], config: { name: '旧名' } };
    seedLive('repair', oldDef);
    seedHistory('repair', 1, oldDef);
    db.permRows = [{ perm: 'workflow.edit' }];
    const op = makeToken('operator');
    const denied = await api('POST', '/repair/versions/1/rollback', op);
    expect(denied.status, `期望 403，实际 ${denied.status}`).toBe(403);
    expect(String(denied.json.message)).toContain('workflow.approve');

    db.permRows = []; // admin 恒全放行
    const admin = makeToken('admin');
    const ok = await api('POST', '/repair/versions/1/rollback', admin);
    expect(ok.status).toBe(200);
    expect(ok.json.rolledBackTo).toBe(1);
    const live = await api('GET', '/repair', admin);
    expect(live.json.def.config.name).toBe('旧名');
    const versions = await api('GET', '/repair/versions', admin);
    expect(versions.json.currentVersion).toBe(2);
  });

  it('⑧ generate/import 落草稿不落 live；enable-acceptance added=0 幂等直通', async () => {
    const admin = makeToken('admin');
    // generate-from-theme：只落草稿，live 版本仍为 0
    const gen = await api('POST', '/generate-from-theme', admin, { entityType: 'inspection_task' });
    expect(gen.status).toBe(200);
    expect(gen.json.draft).toBe(true);
    const genVersions = await api('GET', '/inspection_task/versions', admin);
    expect(genVersions.json.currentVersion).toBe(0);
    const genDraft = await api('GET', '/inspection_task/draft', admin);
    expect(genDraft.status).toBe(200);
    expect(genDraft.json.change.def.config.name).toBe('巡检');

    // import：落草稿，live 不动
    seedLive('repair', { initial: 'draft', states: ['draft'], transitions: [], config: { name: '旧名' } });
    const imp = await api('POST', '/repair/import', admin, draftBody('导入名'));
    expect(imp.status).toBe(200);
    expect(imp.json.draft).toBe(true);
    const live = await api('GET', '/repair', admin);
    expect(live.json.def.config.name).toBe('旧名');

    // enable-acceptance added=0：live def 已含验收边 → 幂等直通，不产生草稿
    seedLive('work_order', ensureAcceptanceEdges(DEFAULT_WORK_ORDER_DEF).def);
    const ea = await api('POST', '/work_order/enable-acceptance', admin);
    expect(ea.status).toBe(200);
    expect(ea.json.added_count).toBe(0);
    const eaDraft = await api('GET', '/work_order/draft', admin);
    expect(eaDraft.status, 'added=0 不得产生草稿').toBe(404);
  });
});
