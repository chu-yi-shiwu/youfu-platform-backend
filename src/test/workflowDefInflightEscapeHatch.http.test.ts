// workflowDefInflightEscapeHatch.http.test.ts —— T1-A 第二批：把在途单防呆的「逃生口」钉在 HTTP 层。
//
// 【为什么补这份】
//   第一批（workflowDefInflightGuard.test.ts）在 PGlite 真库上证明了新闸「会拦」，
//   但那是**函数层**。运营真正走的两条 HTTP 通路是：
//     租户侧 POST /api/v1/workflow-defs/:entityType/approve                  （routes/workflowDef.ts:294）
//     平台侧 POST /api/v1/platform/tenants/:id/workflow-def/:entityType/approve（routes/platformWorkflow.ts:133）
//   逃生口 allowInflightLoss 只有在这两条路由把 confirm_inflight_loss 透传下去时才存在。
//   一旦漏透传，运营审批一份「删了边」的草稿就被永久 409 顶住、且没有任何放行按钮——
//   新闸从「防呆」退化成「卡死且无路可走」。这正是本批要封死的风险。
//
// 【核实结论（本批不改代码的依据）】三条写 live 的端点**都已透传**：
//   routes/workflowDef.ts:360（租户 approve）、routes/workflowDef.ts:617（租户 rollback）、
//   routes/platformWorkflow.ts:150（平台 approve）；schema 一律 z.literal(true).optional()
//   ⇒ 只接受显式 true，不存在「不传也放行」的静默开口。故本批**只补测试，不动生产代码**。
//
// harness 同 workflowDefApproval.http.test.ts：真 express + 真 JWT 验签（AUTH_MODE=prod），
// DB 池 mock 成有状态内存库。唯一新增的是**在途单清点查询的诚实仿真**：
//   按 tenant_id + status = ANY($n) 在真实行数组上过滤后 GROUP BY 计数，
//   绝不按 SQL 文本回一个写死的数字（那样 409/200 就是桩自己编的答案 ⇒ 断言恒绿）。
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const BOX = vi.hoisted(() => ({
  registryRows: [] as Array<Record<string, unknown>>,
  client: null as unknown,
}));

vi.mock('../db/pool.js', () => ({
  default: {
    query: async (sql: string) => {
      if (/FROM tenant_registry/.test(sql)) return { rows: BOX.registryRows, rowCount: BOX.registryRows.length };
      if (/INSERT INTO platform_audit/.test(sql)) return { rows: [], rowCount: 1 };
      if (/FROM platform_admin/.test(sql)) return { rows: [{ id: 'p1', username: 'ops1', display_name: '运维一号' }], rowCount: 1 };
      if (/FROM platform_config/.test(sql)) return { rows: [{ value: 'tenant' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  },
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(BOX.client),
}));

import { errorMiddleware } from '../middleware/error.js';
import workflowDefRouter from '../routes/workflowDef.js';
import platformWorkflowRouter from '../routes/platformWorkflow.js';
import { authMiddleware, signJwt, __setAuthModeForTest, __clearTenantStatusCacheForTest } from '../middleware/auth.js';

const SECRET = 'test-inflight-escape-secret';
const T = 't-inflight';
const ENTITY = 'work_order'; // → work_orders（ENTITY_STATE_TABLE 映射）

// ==================== 有状态内存库 ====================

interface InflightRow {
  tenantId: string;
  entityType: string;
  status: string;
}
interface ChangeRow {
  id: number;
  tenant_id: string;
  entity_type: string;
  def: unknown;
  note: string | null;
  status: string;
  base_version: number;
  rev: number;
  created_by: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  reject_comment: string | null;
}

function makeDb() {
  return {
    defs: new Map<string, { version: number; def: unknown }>(),
    history: [] as Array<{ key: string; version: number; def: unknown; operator: string | null; reason: string | null }>,
    changes: new Map<string, ChangeRow>(),
    inflight: [] as InflightRow[],
    auditLog: [] as Array<{ actor: string; action: string; resource: string }>,
    permRows: [] as Array<{ perm: string }>,
    adminCount: 2,
  };
}
type Db = ReturnType<typeof makeDb>;
let db: Db;
let changeSeq = 0;

/** countInflightByStates 用到的表名 → entity_type 反查（与 engine/workflowDef.ts ENTITY_STATE_TABLE 同源）。 */
const TABLE_TO_ENTITY: Record<string, string> = {
  work_orders: 'work_order',
  inspection_task: 'inspection_task',
  transport_order: 'transport_task',
};

function makeClient(): { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> } {
  return {
    query: async (text: string, params: unknown[] = []) => {
      // ---- 在途单清点（T1-A 新闸的唯一数据来源；必须按真实行过滤计数）----
      if (/COUNT\(\*\)::int AS n/.test(text)) {
        const table = /FROM\s+([a-z_]+)/.exec(text)?.[1] ?? '';
        const isFallback = table === 'business_flow_tasks';
        const entity = isFallback ? String(params[1]) : TABLE_TO_ENTITY[table];
        const tenantId = String(params[0]);
        const states = (isFallback ? params[2] : params[1]) as string[];
        const groups = new Map<string, number>();
        for (const r of db.inflight) {
          if (r.tenantId !== tenantId) continue;
          if (entity !== undefined && r.entityType !== entity) continue;
          if (!states.includes(r.status)) continue;
          groups.set(r.status, (groups.get(r.status) ?? 0) + 1);
        }
        return {
          rows: [...groups.entries()].map(([status, n]) => ({ status, n })),
          rowCount: groups.size,
        };
      }
      if (/FROM role_permission/.test(text)) return { rows: db.permRows, rowCount: db.permRows.length };
      if (/FROM account_user/.test(text)) return { rows: [{ c: db.adminCount }], rowCount: 1 };
      if (/FROM role_def/.test(text)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO platform_audit/.test(text)) {
        db.auditLog.push({ actor: String(params[0]), action: String(params[1]), resource: String(params[2]) });
        return { rows: [], rowCount: 1 };
      }
      // ---- workflow_def_change（必须先于 workflow_def 判定，名字是前缀关系）----
      if (text.includes('workflow_def_change')) {
        const key = `${params[0]}|${params[1]}`;
        if (text.startsWith('INSERT INTO workflow_def_change')) return { rows: [{ rev: 1 }], rowCount: 1 };
        if (text.startsWith('SELECT * FROM workflow_def_change')) {
          const row = db.changes.get(key);
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        if (text.startsWith('DELETE FROM workflow_def_change')) {
          db.changes.delete(key);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO workflow_def_history/.test(text)) {
        db.history.push({
          key: `${params[0]}|${params[1]}`,
          version: Number(params[2]),
          def: params[3],
          operator: params[4] as string | null,
          reason: params[5] as string | null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (/^INSERT INTO workflow_def \(/.test(text)) {
        const key = `${params[0]}|${params[1]}`;
        const cur = db.defs.get(key);
        // 如实模拟单语句条件更新的 WHERE 段：expectVersion 不符 ⇒ 0 行 ⇒ 上层 409 DRAFT_STALE
        const guarded = /WHERE\s*\(\$5::int IS NULL OR workflow_def\.version = \$5\)/.test(text);
        const expected = params[4] as number | null;
        if (guarded && typeof expected === 'number' && cur && expected !== cur.version) {
          return { rows: [], rowCount: 0 };
        }
        db.defs.set(key, {
          version: cur ? cur.version + 1 : 1,
          def: typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2],
        });
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
      return { rows: [], rowCount: 0 };
    },
  };
}

// ==================== 夹具 ====================

const STATES = ['pending', 'assigned', 'processing', 'completed'];

/** live 侧旧 def：middle 边（assigned --start--> processing）是三场景唯一被改动的那条。 */
function oldLiveDef(middleExtra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    initial: 'pending',
    states: [...STATES],
    transitions: [
      { from: 'pending', to: 'assigned', event: 'assign' },
      { from: 'assigned', to: 'processing', event: 'start', ...middleExtra },
      { from: 'processing', to: 'completed', event: 'finish' },
    ],
    config: { name: '旧流程' },
  };
}

type Scenario = 'edge' | 'role' | 'field';

/** 按场景产出「会让在途单走不下去」的草稿 def（states 不变 ⇒ 删态硬闸不参与，只测新闸）。 */
function riskyDraft(scenario: Scenario, base: Record<string, unknown>): Record<string, unknown> {
  const ts = (base.transitions as Array<Record<string, unknown>>).map((t) => ({ ...t }));
  if (scenario === 'edge') {
    return { ...base, transitions: [ts[0], ts[2]], config: { name: '新流程' } };
  }
  if (scenario === 'role') {
    ts[1] = { ...ts[1], allowedRoles: ['admin'] }; // 旧为 ['admin','worker'] ⇒ 踢掉 worker
    return { ...base, transitions: ts, config: { name: '新流程' } };
  }
  ts[1] = { ...ts[1], requiredFields: ['photo'] };
  return { ...base, transitions: ts, config: { name: '新流程' } };
}

function seedLive(def: unknown, version = 1): void {
  db.defs.set(`${T}|${ENTITY}`, { version, def });
}

/** 直接把 change 行置成 submitted —— 本文件只验证 approve 的逃生口，草稿/提交语义由
 *  workflowDefApproval.http.test.ts 覆盖，此处不重复走一遍（减少无关耦合）。 */
function seedSubmittedChange(def: unknown, baseVersion = 1): void {
  db.changes.set(`${T}|${ENTITY}`, {
    id: ++changeSeq,
    tenant_id: T,
    entity_type: ENTITY,
    def,
    note: null,
    status: 'submitted',
    base_version: baseVersion,
    rev: 1,
    created_by: 'admin-a',
    submitted_by: 'admin-a',
    submitted_at: new Date().toISOString(),
    reject_comment: null,
  });
}

function seedInflight(status: string, n: number): void {
  for (let i = 0; i < n; i += 1) db.inflight.push({ tenantId: T, entityType: ENTITY, status });
}

function live(): { version: number; def: Record<string, unknown> } | undefined {
  return db.defs.get(`${T}|${ENTITY}`) as { version: number; def: Record<string, unknown> } | undefined;
}

function setup(scenario: Scenario, inflightAt: string | null, n = 2): void {
  const base = oldLiveDef(scenario === 'role' ? { allowedRoles: ['admin', 'worker'] } : {});
  seedLive(base);
  seedSubmittedChange(riskyDraft(scenario, base));
  if (inflightAt) seedInflight(inflightAt, n);
}

// ==================== HTTP ====================

let server: Server;
let base = '';

function tenantToken(username: string): string {
  return signJwt({ tid: T, sub: `u-${username}`, username, role: 'admin', exp: Math.floor(Date.now() / 1000) + 600 }, SECRET);
}
function platformToken(): string {
  return signJwt({ sub: 'p1', platform: true, role: 'platform_admin', exp: Math.floor(Date.now() / 1000) + 600 }, SECRET);
}

async function call(path: string, token: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { ok: false, code: 'NON_JSON', message: text.slice(0, 200) };
  }
  return { status: r.status, json };
}

const TENANT_APPROVE = `/api/v1/workflow-defs/${ENTITY}/approve`;
const PLATFORM_APPROVE = `/api/v1/platform/tenants/${T}/workflow-def/${ENTITY}/approve`;

/** 409 侧断言：错误码、场景 lead、真实清点数字都要在（清点数字证明数量来自真实行而非桩编的数）。 */
function expectBlocked(r: { status: number; json: Record<string, unknown> }, lead: string): void {
  expect(r.status, `期望 409，实际 ${r.status} / ${JSON.stringify(r.json)}`).toBe(409);
  expect(r.json.code).toBe('INFLIGHT_STATE_LOSS');
  expect(String(r.json.message)).toContain(lead);
  expect(String(r.json.message), '409 文案必须带真实清点数字（assigned:2）').toContain('assigned:2');
  expect(String(r.json.message)).toContain('allowInflightLoss');
  // live 与草稿均未被消费
  expect(live()?.version).toBe(1);
  expect((live()?.def?.transitions as unknown[])?.length).toBe(3);
  expect(db.changes.has(`${T}|${ENTITY}`), '409 时草稿必须保留（运营回去加确认再批）').toBe(true);
}

/** 200 侧断言：live 已落新 def、版本自增、草稿已消费。 */
function expectPassed(r: { status: number; json: Record<string, unknown> }, scenario: Scenario): void {
  expect(r.status, `期望 200，实际 ${r.status} / ${JSON.stringify(r.json)}`).toBe(200);
  expect(r.json.approved).toBe(true);
  expect(live()?.version).toBe(2);
  expect(db.changes.has(`${T}|${ENTITY}`), '200 时草稿必须已删除').toBe(false);
  const ts = (live()?.def?.transitions ?? []) as Array<Record<string, unknown>>;
  if (scenario === 'edge') {
    expect(ts.length, '删边后 live 应只剩两条边').toBe(2);
  } else if (scenario === 'role') {
    expect(ts.length).toBe(3);
    expect(ts[1].allowedRoles).toEqual(['admin']);
  } else {
    expect(ts.length).toBe(3);
    expect(ts[1].requiredFields).toEqual(['photo']);
  }
}

beforeAll(async () => {
  process.env.JWT_SECRET = SECRET;
  process.env.WORKFLOW_CONFIG_OWNER = 'tenant'; // 097：租户侧 approve 不被归属闸门 403
  const app = express();
  app.use(express.json());
  app.use('/api/v1/platform', platformWorkflowRouter); // 先挂：平台路由自带 platformAdminAuth，不走租户 authMiddleware
  app.use('/api', authMiddleware); // 与生产 server.ts 同序
  app.use('/api/v1/workflow-defs', workflowDefRouter);
  app.use(errorMiddleware);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  delete process.env.WORKFLOW_CONFIG_OWNER; // 097：环境隔离，避免污染同进程其它测试文件
  delete process.env.JWT_SECRET;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  __setAuthModeForTest('prod'); // dev 下权限门恒放行 ⇒ 必须 prod
  __clearTenantStatusCacheForTest();
  BOX.registryRows = [{ status: 'active' }];
  db = makeDb();
  BOX.client = makeClient();
});

afterEach(() => {
  __setAuthModeForTest('dev');
});

// ==================== ① 租户侧审批端点（routes/workflowDef.ts:294 → :360） ====================

describe('T1-A 第二批①：租户侧 approve 的逃生口透传（workflowDef.ts:360）', () => {
  it('删流转边：不带 confirm_inflight_loss ⇒ 409 INFLIGHT_STATE_LOSS，live 与草稿均不动', async () => {
    setup('edge', 'assigned');
    const r = await call(TENANT_APPROVE, tenantToken('admin-b'));
    expectBlocked(r, '删流转边');
  });

  it('删流转边：带 confirm_inflight_loss:true ⇒ 200 放行，live 落新 def 且版本自增', async () => {
    setup('edge', 'assigned');
    const r = await call(TENANT_APPROVE, tenantToken('admin-b'), { confirm_inflight_loss: true });
    expectPassed(r, 'edge');
  });

  it('收紧 allowedRoles：不带确认 ⇒ 409（文案含「收紧角色」）', async () => {
    setup('role', 'assigned');
    const r = await call(TENANT_APPROVE, tenantToken('admin-b'));
    expectBlocked(r, '收紧角色');
  });

  it('收紧 allowedRoles：带 confirm_inflight_loss:true ⇒ 200 放行', async () => {
    setup('role', 'assigned');
    const r = await call(TENANT_APPROVE, tenantToken('admin-b'), { confirm_inflight_loss: true });
    expectPassed(r, 'role');
  });

  it('新增 requiredFields：不带确认 ⇒ 409（文案含「新增必填」）', async () => {
    setup('field', 'assigned');
    const r = await call(TENANT_APPROVE, tenantToken('admin-b'));
    expectBlocked(r, '新增必填');
  });

  it('新增 requiredFields：带 confirm_inflight_loss:true ⇒ 200 放行', async () => {
    setup('field', 'assigned');
    const r = await call(TENANT_APPROVE, tenantToken('admin-b'), { confirm_inflight_loss: true });
    expectPassed(r, 'field');
  });

  it('逃生口只接受**显式** true：confirm_inflight_loss=false ⇒ 422 VALIDATION_001，绝不静默放行', async () => {
    setup('edge', 'assigned');
    const r = await call(TENANT_APPROVE, tenantToken('admin-b'), { confirm_inflight_loss: false });
    expect(r.status, `期望 422，实际 ${r.status} / ${JSON.stringify(r.json)}`).toBe(422);
    expect(r.json.code).toBe('VALIDATION_001');
    // 关键：绝不能因为传了假值就当确认放行
    expect(live()?.version).toBe(1);
    expect(db.changes.has(`${T}|${ENTITY}`)).toBe(true);
  });

  it('🟢 防误伤基线：同款删边改动，但受影响状态上无在途单 ⇒ 不加确认也 200', async () => {
    setup('edge', null); // assigned 上 0 张在途单
    const r = await call(TENANT_APPROVE, tenantToken('admin-b'));
    expectPassed(r, 'edge');
  });
});

// ==================== ② 平台侧审批端点（routes/platformWorkflow.ts:133 → :150） ====================

describe('T1-A 第二批②：平台侧 approve 的逃生口透传（platformWorkflow.ts:150）', () => {
  it('删流转边：不带 confirm_inflight_loss ⇒ 409 INFLIGHT_STATE_LOSS', async () => {
    setup('edge', 'assigned');
    const r = await call(PLATFORM_APPROVE, platformToken());
    expectBlocked(r, '删流转边');
  });

  it('删流转边：带 confirm_inflight_loss:true ⇒ 200 放行', async () => {
    setup('edge', 'assigned');
    const r = await call(PLATFORM_APPROVE, platformToken(), { confirm_inflight_loss: true });
    expectPassed(r, 'edge');
  });

  it('收紧 allowedRoles：不带确认 ⇒ 409', async () => {
    setup('role', 'assigned');
    const r = await call(PLATFORM_APPROVE, platformToken());
    expectBlocked(r, '收紧角色');
  });

  it('收紧 allowedRoles：带 confirm_inflight_loss:true ⇒ 200 放行', async () => {
    setup('role', 'assigned');
    const r = await call(PLATFORM_APPROVE, platformToken(), { confirm_inflight_loss: true });
    expectPassed(r, 'role');
  });

  it('新增 requiredFields：不带确认 ⇒ 409', async () => {
    setup('field', 'assigned');
    const r = await call(PLATFORM_APPROVE, platformToken());
    expectBlocked(r, '新增必填');
  });

  it('新增 requiredFields：带 confirm_inflight_loss:true ⇒ 200 放行', async () => {
    setup('field', 'assigned');
    const r = await call(PLATFORM_APPROVE, platformToken(), { confirm_inflight_loss: true });
    expectPassed(r, 'field');
  });

  it('平台侧逃生口同样只接受显式 true：false ⇒ 422，不静默放行', async () => {
    setup('field', 'assigned');
    const r = await call(PLATFORM_APPROVE, platformToken(), { confirm_inflight_loss: false });
    expect(r.status, `期望 422，实际 ${r.status} / ${JSON.stringify(r.json)}`).toBe(422);
    expect(r.json.code).toBe('VALIDATION_001');
    expect(live()?.version).toBe(1);
  });
});
