// 097 平台运维代客配置流程通道 —— 真 HTTP 层行为锚。
//
// 【为什么补这份】
//   workflowConfigOwner.test.ts 只证明「客户改不了」和「happy path 上运维改得了」，
//   但这条通道是**权限比租户 admin 还高**的后门，下面这些从没被测过：
//     ① 鉴权底线：prod 下无 token / 非平台 token / 停用管理员 —— 全仓 PLATFORM_AUTH 零命中；
//     ② 异常分支：无草稿提交、重复提交、未提交就审批、版本漂移 —— 全是 404/409 语义；
//     ③ 留痕：每次写操作是否真往 platform_audit 落了一行；写失败时是否**静默吞掉**（E3）。
//   ③尤其关键：audit 的 catch 只 console.warn 不抛，一旦表结构对不上，运维操作就零留痕且不报错。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const box = vi.hoisted(() => ({
  owner: 'platform' as string,
  /** workflow_def_change 当前行的状态；null = 无在途变更。 */
  changeStatus: null as null | 'draft' | 'submitted',
  changeBaseVersion: 1 as number,
  liveVersion: 1 as number,
  auditFail: false as boolean,
  sqls: [] as string[],
  allParams: [] as unknown[][],
  platformAdminRows: [{ id: 'p1', username: 'ops1', display_name: '运维一号' }] as unknown[],
}));

const DEF = { initial: 'draft', states: ['draft', 'done'], transitions: [], config: {} };

function makeClient() {
  const query = async (sql: string, params: unknown[] = []) => {
    const s = String(sql);
    box.sqls.push(s);
    box.allParams.push(params);
    if (s.includes('INSERT INTO platform_audit')) {
      if (box.auditFail) throw new Error('relation "platform_audit" does not exist');
      return { rows: [], rowCount: 1 };
    }
    if (s.includes('FROM platform_config')) return { rows: [{ value: box.owner }], rowCount: 1 };
    // T0 后 saveWorkflowDef 自己会先 SELECT version, def（判断是否有当前行 + 取版本做历史快照），
    // 桩必须一并应答；只认 'SELECT version FROM workflow_def' 会导致 cur 为空 ⇒ 条件更新判定
    // "期望某版本但该流程不存在" ⇒ 抛 DRAFT_STALE ⇒ 审批全线 409（桩落后于生产 SQL 的假红）。
    if (s.includes('SELECT version FROM workflow_def') || s.includes('SELECT version, def FROM workflow_def')) {
      return { rows: [{ version: box.liveVersion, def: DEF }], rowCount: 1 };
    }
    if (s.includes('FROM workflow_def_change') && s.trim().startsWith('SELECT')) {
      // getWorkflowDefChange：无在途 → 空行
      return box.changeStatus
        ? { rows: [{ tenant_id: params[0], entity_type: params[1], status: box.changeStatus, base_version: box.changeBaseVersion, def: DEF, rev: 1 }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (s.includes('UPDATE workflow_def_change')) {
      // 按 SET 子句判定方向（两条 SQL 的 WHERE 里都含 status='submitted'，不能靠 includes 判）
      const setTo = /SET\s+status\s*=\s*'(\w+)'/.exec(s)?.[1] ?? null;
      const want = setTo === 'submitted' ? 'draft' : 'submitted';
      if (box.changeStatus === want && setTo) {
        box.changeStatus = setTo as 'draft' | 'submitted';
        return { rows: [{ tenant_id: params[0], entity_type: params[1], status: box.changeStatus, base_version: box.changeBaseVersion, def: DEF, rev: 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (s.includes('INSERT INTO workflow_def_change')) return { rows: [{ rev: 1 }], rowCount: 1 };
    if (s.includes('DELETE FROM workflow_def_change')) return { rows: [], rowCount: 1 };
    // T0：saveWorkflowDef 的 live 写入现在是单语句条件更新
    //   INSERT ... ON CONFLICT DO UPDATE ... WHERE ($5::int IS NULL OR workflow_def.version = $5)
    //   桩必须**如实模拟**这个 WHERE：传了 expectVersion 且 ≠ liveVersion ⇒ 0 行（上层抛 409 DRAFT_STALE）。
    //   不模拟 ⇒ 桩永远返回 0 行 ⇒ 所有审批都变 409，本文件就失去意义了。
    if (s.includes('INSERT INTO workflow_def (')) {
      const expected = params[4] as number | null;
      if (typeof expected === 'number' && expected !== box.liveVersion) return { rows: [], rowCount: 0 };
      box.liveVersion += 1; // 版本自增（saveWorkflowDef 的语义）
      return { rows: [], rowCount: 1 };
    }
    if (s.includes('FROM platform_admin')) {
      return { rows: box.platformAdminRows, rowCount: box.platformAdminRows.length };
    }
    return { rows: [], rowCount: 0 };
  };
  return { query };
}

vi.mock('../db/pool.js', () => ({
  default: { query: async (sql: string, params: unknown[] = []) => makeClient().query(sql, params) },
  withTenantClient: async (_t: string, fn: (c: unknown) => unknown) => fn(makeClient()),
  assertSafeTenantId: (t: string) => t,
}));

import { errorMiddleware } from '../middleware/error.js';
import platformWorkflowRouter from '../routes/platformWorkflow.js';
import { signJwt } from '../middleware/auth.js';
import { refreshAuthMode } from '../middleware/auth.js';

const SECRET = 'test-secret-platform';
const T = 't-target';

let server: Server;
let base = '';

beforeAll(async () => {
  process.env.JWT_SECRET = SECRET;
  process.env.AUTH_MODE = 'prod'; // 本文件重点就是 prod 下的鉴权底线
  refreshAuthMode();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/platform', platformWorkflowRouter);
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/platform`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  delete process.env.AUTH_MODE;
  delete process.env.JWT_SECRET;
  refreshAuthMode();
});

beforeEach(() => {
  box.owner = 'platform';
  box.changeStatus = null;
  box.changeBaseVersion = 1;
  box.liveVersion = 1;
  box.auditFail = false;
  box.sqls = [];
  box.allParams = [];
  box.platformAdminRows = [{ id: 'p1', username: 'ops1', display_name: '运维一号' }];
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: Record<string, unknown> = {};
  const text = await r.text();
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
}

function platformToken(over: Record<string, unknown> = {}) {
  return signJwt({ sub: 'p1', platform: true, role: 'platform_admin', ...over }, SECRET);
}
const AUTH = () => ({ Authorization: `Bearer ${platformToken()}` });

// ==================== 一、鉴权底线（prod） ====================
describe('097-A 平台通道鉴权底线（prod，全仓此前零覆盖）', () => {
  it('无 token → 401 PLATFORM_AUTH_001', async () => {
    const r = await call('GET', '/config/workflow-config-owner');
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('PLATFORM_AUTH_001');
  });

  it('租户 token（platform 不为 true）→ 401 PLATFORM_AUTH_002（租户身份绝不能进平台通道）', async () => {
    const t = signJwt({ sub: 'u1', tid: T, role: 'admin' }, SECRET); // 租户 admin 的 token
    const r = await call('GET', '/config/workflow-config-owner', undefined, { Authorization: `Bearer ${t}` });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('PLATFORM_AUTH_002');
  });

  it('role 不是 platform_admin → 401 PLATFORM_AUTH_002', async () => {
    const r = await call('GET', '/config/workflow-config-owner', undefined,
      { Authorization: `Bearer ${platformToken({ role: 'platform_viewer' })}` });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('PLATFORM_AUTH_002');
  });

  it('平台管理员停用/不存在 → 401 PLATFORM_AUTH_003（token 有效但人已撤权）', async () => {
    box.platformAdminRows = [];
    const r = await call('GET', '/config/workflow-config-owner', undefined, AUTH());
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('PLATFORM_AUTH_003');
  });

  it('有效平台 token → 200（通道本身可用，不是把所有人都挡在外面）', async () => {
    const r = await call('GET', '/config/workflow-config-owner', undefined, AUTH());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.owner).toBe('platform');
  });

  it('代客写端点同样受这道闸（无 token 不得改客户流程）', async () => {
    const r = await call('PUT', `/tenants/${T}/workflow-def/work_order`, { def: DEF });
    expect(r.status).toBe(401);
    expect(box.sqls.some((s) => s.includes('INSERT INTO platform_audit'))).toBe(false);
  });
});

// ==================== 二、异常分支（404/409/422 语义） ====================
describe('097-B 代客配置：异常分支语义（不是一律 200 糊过去）', () => {
  it('submit 无在途草稿 → 404 NO_DRAFT', async () => {
    const r = await call('POST', `/tenants/${T}/workflow-def/work_order/submit`, {}, AUTH());
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('NO_DRAFT');
  });

  it('submit 已提交过 → 409 CHANGE_NOT_DRAFT（防重复提交把审批队列刷屏）', async () => {
    box.changeStatus = 'submitted';
    const r = await call('POST', `/tenants/${T}/workflow-def/work_order/submit`, {}, AUTH());
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('CHANGE_NOT_DRAFT');
  });

  it('submit 草稿 → 200 且留痕', async () => {
    box.changeStatus = 'draft';
    const r = await call('POST', `/tenants/${T}/workflow-def/work_order/submit`, {}, AUTH());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.status).toBe('submitted');
  });

  it('approve 草稿未提交 → 409 CHANGE_NOT_SUBMITTED（不许跳过提交直接生效）', async () => {
    box.changeStatus = 'draft';
    const r = await call('POST', `/tenants/${T}/workflow-def/work_order/approve`, {}, AUTH());
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('CHANGE_NOT_SUBMITTED');
  });

  it('approve 版本漂移（base_version != live）→ 409 DRAFT_STALE', async () => {
    box.changeStatus = 'submitted';
    box.changeBaseVersion = 3;
    box.liveVersion = 5;
    const r = await call('POST', `/tenants/${T}/workflow-def/work_order/approve`, {}, AUTH());
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('DRAFT_STALE');
  });

  it('approve 无在途 → 404 NO_DRAFT', async () => {
    const r = await call('POST', `/tenants/${T}/workflow-def/work_order/approve`, {}, AUTH());
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('NO_DRAFT');
  });

  it('reject 无在途 → 404 NO_DRAFT', async () => {
    const r = await call('POST', `/tenants/${T}/workflow-def/work_order/reject`, { comment: 'x' }, AUTH());
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('NO_DRAFT');
  });

  it('reject 意见为空 → 422（驳回必须写明原因，否则客户不知道改哪）', async () => {
    box.changeStatus = 'submitted';
    const r = await call('POST', `/tenants/${T}/workflow-def/work_order/reject`, { comment: '' }, AUTH());
    expect(r.status).toBe(422);
  });

  it('非法 entityType（大写开头）→ 400 BAD_PARAM', async () => {
    const r = await call('PUT', `/tenants/${T}/workflow-def/Work_Order`, { def: DEF }, AUTH());
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('BAD_PARAM');
  });

  it('def 结构非法（states 为空数组）→ 422，不得落库', async () => {
    const r = await call('PUT', `/tenants/${T}/workflow-def/work_order`,
      { def: { initial: 'a', states: [], transitions: [] } }, AUTH());
    expect(r.status).toBe(422);
    expect(box.sqls.some((s) => s.includes('INSERT INTO workflow_def_change'))).toBe(false);
  });
});

// ==================== 三、留痕（E3：不静默失败） ====================
describe('097-C 留痕：每次写操作必须落 platform_audit，且 actor/target_tenant 正确', () => {
  it('存草稿 → 落一行 audit，actor 带 platform: 前缀，target_tenant = 路径租户', async () => {
    const r = await call('PUT', `/tenants/${T}/workflow-def/work_order`, { def: DEF }, AUTH());
    expect(r.status).toBe(200);
    const idx = box.sqls.findIndex((s) => s.includes('INSERT INTO platform_audit'));
    expect(idx).toBeGreaterThanOrEqual(0);
    const p = box.allParams[idx];
    expect(String(p[0])).toMatch(/^platform:/); // actor 必须能区分平台运维与租户账号
    expect(p[1]).toBe('workflow_def.draft_save');
    expect(p[3]).toBe(T); // target_tenant
  });

  it('提交/审批/驳回 各有独立 action 留痕（审计时能还原完整动作序列）', async () => {
    box.changeStatus = 'draft';
    await call('POST', `/tenants/${T}/workflow-def/work_order/submit`, {}, AUTH());
    box.changeStatus = 'submitted';
    box.changeBaseVersion = 1; box.liveVersion = 1;
    await call('POST', `/tenants/${T}/workflow-def/work_order/approve`, {}, AUTH());
    box.changeStatus = 'submitted';
    await call('POST', `/tenants/${T}/workflow-def/work_order/reject`, { comment: '不符合规范' }, AUTH());
    const actions = box.sqls
      .map((s, i) => (s.includes('INSERT INTO platform_audit') ? box.allParams[i][1] : null))
      .filter(Boolean);
    expect(actions).toEqual(['workflow_def.submit', 'workflow_def.approve', 'workflow_def.reject']);
  });

  it('🔴 audit 写失败：主流程仍完成（不阻断），但必须 console.warn 报警（绝不静默吞掉）', async () => {
    box.auditFail = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await call('PUT', `/tenants/${T}/workflow-def/work_order`, { def: DEF }, AUTH());
      expect(r.status, JSON.stringify(r.body)).toBe(200); // 不阻断
      expect(warn).toHaveBeenCalled(); // 但必须叫出声
      const msg = warn.mock.calls.map((c) => String(c[0])).join(' ');
      expect(msg).toContain('platform_audit');
    } finally {
      warn.mockRestore();
    }
  });
});

// ==================== 四、租户定向（不串租户） ====================
describe('097-D 代客配置必须精确落在路径指定的租户上', () => {
  it('PUT 指定租户 A → 所有 SQL 的 tenant_id 参数都是 A，不出现别的租户', async () => {
    await call('PUT', '/tenants/tenant-A/workflow-def/work_order', { def: DEF }, AUTH());
    const tenantParams = box.allParams
      .filter((_, i) => box.sqls[i].includes('workflow_def'))
      .flat()
      .map(String);
    expect(tenantParams).toContain('tenant-A');
    expect(tenantParams).not.toContain(T);
  });

  it('读指定租户的流程 → 200 且回显 tenantId', async () => {
    const r = await call('GET', `/tenants/${T}/workflow-def/work_order`, undefined, AUTH());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.tenantId).toBe(T);
  });

  it('待审批清单：只列该租户的（SQL 带租户参数）', async () => {
    const r = await call('GET', `/tenants/${T}/workflow-def-pending`, undefined, AUTH());
    expect(r.status).toBe(200);
    expect(r.body.tenantId).toBe(T);
  });
});
