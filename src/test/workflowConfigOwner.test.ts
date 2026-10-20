// 097：流程配置权限归属闸门 —— 「早期只平台运维能配流程，不放开给客户」的行为锚。
//
// 【为什么这份测试必须存在】
//   收口前，租户自己的 admin 天然能改流程：hasPerm 里 `role === 'admin'` 恒放行（role.ts:237）、
//   DEFAULT_PERM_MATRIX.admin = [...PERMS]（role.ts:106）、还能经 role_permission 把 workflow.edit
//   授给任意自建角色（role.ts:238-241）。本文件把"客户改不了"钉死，防止后续改动把这道闸拆了。
//
// 【怎么聚焦到闸门本身】
//   authMode=dev（权限点 dev 恒放行）+ role=admin（最该被拦的那个角色）：
//   于是"过/不过"只由**归属闸门**决定，不会被权限矩阵干扰——且直接证明连 admin 都拦得住。
//   既有 4 个流程测试文件（env=tenant）负责覆盖"放开后的真实写库路径"（46 例全绿）。
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const box = vi.hoisted(() => ({
  owner: 'platform' as string,            // platform_config 表的当前值
}));

/** 宽容 client：只认识闸门查询与草稿写入两条 SQL，其余返回空行（够跑通拦截与存草稿路径）。 */
function makeClient() {
  return {
    query: async (sql: string, _params: unknown[] = []) => {
      const s = String(sql);
      if (s.includes('FROM platform_config')) return { rows: [{ value: box.owner }], rowCount: 1 };
      if (s.includes('INSERT INTO workflow_def_change')) return { rows: [{ rev: 1 }], rowCount: 1 };
      // rollback 的历史校验在闸门之前（先取快照再判权限），给它一行快照才能测到闸门本身
      if (s.includes('FROM workflow_def_history')) return { rows: [{ def: { initial: 'draft', states: ['draft'], transitions: [], config: {} }, version: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

vi.mock('../db/pool.js', () => ({
  default: {
    query: async (sql: string, params: unknown[] = []) => {
      const s = String(sql);
      if (s.includes('FROM platform_config')) return { rows: [{ value: box.owner }], rowCount: 1 };
      if (s.includes('INSERT INTO platform_config')) {
        box.owner = String(params[1]); // UPSERT：第二个参数是 value
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  },
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(makeClient()),
}));

import { errorMiddleware } from '../middleware/error.js';
import workflowDefRouter from '../routes/workflowDef.js';
import optimizeRouter from '../routes/optimize.js';
import platformWorkflowRouter from '../routes/platformWorkflow.js';
import { assertWorkflowConfigEditableByTenant, WORKFLOW_CONFIG_PLATFORM_ONLY } from '../middleware/workflowConfigGuard.js';
import { getWorkflowConfigOwner } from '../repo/platformConfig.js';
import { refreshAuthMode } from '../middleware/auth.js';

const T = 't-owner';
let server: Server;
let base = '';

beforeAll(async () => {
  // 平台端点走 platformAdminAuth：prod 会索要平台 bearer token（F7 fail-closed）；
  // 本文件验证的是归属闸门而非平台登录，故整体置 dev 让平台身份自动注入。
  process.env.AUTH_MODE = 'dev';
  refreshAuthMode();
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    // 直接注入租户上下文（与 workflowApproveFullChain.test.ts:155 同款）：
    // role=admin —— 最该被闸门拦住的角色，正是本文件的验证重点。
    res.locals.auth = {
      tenantId: T, requestId: 'r1', userId: 'u1', username: 'admin', role: 'admin', authMode: 'dev',
    };
    next();
  });
  app.use('/api/v1/workflow-defs', workflowDefRouter);
  app.use('/api/v1', optimizeRouter);
  app.use('/api/v1/platform', platformWorkflowRouter);
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  delete process.env.AUTH_MODE;
  refreshAuthMode();
  await new Promise<void>((r) => server.close(() => r()));
  delete process.env.WORKFLOW_CONFIG_OWNER;
});

beforeEach(() => {
  box.owner = 'platform'; // 缺省 = 最严侧
  delete process.env.WORKFLOW_CONFIG_OWNER;
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

const DEF = { initial: 'draft', states: ['draft', 'done'], transitions: [], config: {} };

describe('097 ① 归属读取：三种来源的优先级（env > DB > 默认）', () => {
  it('DB=platform → platform；DB=tenant → tenant', async () => {
    box.owner = 'platform';
    expect(await getWorkflowConfigOwner()).toBe('platform');
    box.owner = 'tenant';
    expect(await getWorkflowConfigOwner()).toBe('tenant');
  });

  it('DB 出故障 → 回退最严侧 platform（fail-closed，绝不因抖动把配置权放开）', async () => {
    const bad = { query: async () => { throw new Error('relation "platform_config" does not exist'); } };
    expect(await getWorkflowConfigOwner(bad)).toBe('platform');
  });

  it('env 优先级最高：DB=tenant 但 env=platform → 仍锁（紧急熔断层生效）', async () => {
    box.owner = 'tenant';
    process.env.WORKFLOW_CONFIG_OWNER = 'platform';
    expect(await getWorkflowConfigOwner()).toBe('platform');
  });
});

// 深化（第 2 轮）：脏数据方向。开关值是 TEXT 列，任何人 psql 手工 UPDATE 都能写进任意字符串；
// 读取侧必须「只认合法枚举，其余一律最严」，否则一次手误（大小写/空格/旧值）就把配置权放给了客户。
describe('097 ①-2 脏数据/非法值一律回退最严侧（TEXT 列没有约束，只能靠读取侧兜）', () => {
  const dirty: Array<[string, string]> = [
    ['Platform', '大小写错'],
    ['PLATFORM', '全大写'],
    [' tenant', '带前导空格'],
    ['tenant ', '带尾随空格'],
    ['ops', '完全无关的值'],
    ['', '空串'],
  ];
  for (const [raw, why] of dirty) {
    it(`DB 值 = ${JSON.stringify(raw)}（${why}）→ platform，绝不因此放开`, async () => {
      box.owner = raw;
      expect(await getWorkflowConfigOwner()).toBe('platform');
    });
  }

  it('DB 无此行（0 行）→ platform', async () => {
    const none = { query: async () => ({ rows: [], rowCount: 0 }) };
    expect(await getWorkflowConfigOwner(none)).toBe('platform');
  });

  it('env 非法值（Platform）→ 忽略 env，以 DB 为准（env 只接受精确值，不猜）', async () => {
    box.owner = 'tenant';
    process.env.WORKFLOW_CONFIG_OWNER = 'Platform';
    expect(await getWorkflowConfigOwner()).toBe('tenant'); // env 未生效，按 DB 走
  });
});

describe('097 ② 守卫单元：platform 抛 403 / tenant 放行', () => {
  it('owner=platform → 抛 403 且 code = WORKFLOW_CONFIG_PLATFORM_ONLY', async () => {
    box.owner = 'platform';
    await expect(assertWorkflowConfigEditableByTenant()).rejects.toMatchObject({
      status: 403, code: WORKFLOW_CONFIG_PLATFORM_ONLY,
    });
  });
  it('owner=tenant → 不抛', async () => {
    box.owner = 'tenant';
    await expect(assertWorkflowConfigEditableByTenant()).resolves.toBeUndefined();
  });
});

describe('097 ③ 端到端：归属=platform 时租户 admin 的写端点全数 403（客户改不了流程）', () => {
  const writeCalls: Array<[string, string, unknown?]> = [
    ['PUT', '/workflow-defs/work_order', { def: DEF }],
    ['PUT', '/workflow-defs/work_order/draft', { def: DEF }],
    ['POST', '/workflow-defs/work_order/submit'],
    ['POST', '/workflow-defs/work_order/approve'],
    ['POST', '/workflow-defs/work_order/reject', { comment: 'x' }],
    ['POST', '/workflow-defs/generate-from-theme', { entityType: 'transport_task' }],
    ['POST', '/workflow-defs/work_order/enable-acceptance'],
    ['POST', '/workflow-defs/work_order/versions/1/rollback'],
    ['POST', '/workflow-defs/work_order/import', { def: DEF }],
    ['PUT', '/workflow-defs/work_order/auto-rules', { from_state: 'draft', event: 'approve', conditions: {}, enabled: false }],
    ['DELETE', '/workflow-defs/work_order/auto-rules/draft/approve'],
    // 第 12 处：optimize 旁路。V3-D5 后它从「直写 live」收敛为「存草稿」，
    // 但仍是**改流程**——不同一道闸，客户 admin 从这条旁路就能改，收口形同虚设。
    ['PUT', '/workflow/def', { entity: 'work_order', def: DEF }],
  ];

  for (const [m, p, b] of writeCalls) {
    it(`${m} ${p} → 403 ${WORKFLOW_CONFIG_PLATFORM_ONLY}`, async () => {
      const r = await call(m, p, b);
      expect(r.status, `期望 403，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(403);
      expect(r.body.code).toBe(WORKFLOW_CONFIG_PLATFORM_ONLY);
    });
  }
});

describe('097 ④ 端到端：读端点不受闸门影响（客户必须看得见自己的流程）', () => {
  it('GET /workflow-defs/themes → 200', async () => {
    const r = await call('GET', '/workflow-defs/themes');
    expect(r.status).toBe(200);
  });
  it('GET /workflow-defs/:entityType → 不是 403（闸门不拦读）', async () => {
    const r = await call('GET', '/workflow-defs/work_order');
    expect(r.status).not.toBe(403);
    expect(r.body.code).not.toBe(WORKFLOW_CONFIG_PLATFORM_ONLY);
  });
});

describe('097 ⑤ 开关一拨即生效（不改代码、不发版）', () => {
  it('归属拨成 tenant 后，同一个写端点从 403 变 200', async () => {
    const locked = await call('PUT', '/workflow-defs/work_order', { def: DEF });
    expect(locked.status).toBe(403);
    box.owner = 'tenant';
    const opened = await call('PUT', '/workflow-defs/work_order', { def: DEF });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body.draft).toBe(true);
  });
});

describe('097 ⑥ 平台运维通道：归属=platform 时运维仍可代客配置（不留死路）', () => {
  it('PUT /platform/tenants/:id/workflow-def/:entityType → 200 且产出草稿', async () => {
    box.owner = 'platform'; // 租户侧此刻全锁；运维通道必须仍然通
    const r = await call('PUT', `/platform/tenants/${T}/workflow-def/work_order`, { def: DEF });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.draft).toBe(true);
    expect(r.body.tenantId).toBe(T);
  });

  it('开关端点：GET 读得到归属，PUT 改完立即生效', async () => {
    const g = await call('GET', '/platform/config/workflow-config-owner');
    expect(g.status).toBe(200);
    expect(g.body.owner).toBe('platform');

    const p = await call('PUT', '/platform/config/workflow-config-owner', { owner: 'tenant' });
    expect(p.status).toBe(200);
    expect(p.body.owner).toBe('tenant');
    expect(box.owner).toBe('tenant'); // 已落库（mock 侧记录写入值）

    // 拨开后租户写端点立即可用
    const opened = await call('PUT', '/workflow-defs/work_order', { def: DEF });
    expect(opened.status).toBe(200);
  });

  it('非法归属值 → 422 被拒（zod 枚举校验，不静默接受）', async () => {
    const r = await call('PUT', '/platform/config/workflow-config-owner', { owner: 'anyone' });
    expect(r.status).toBe(422); // 本系统参数校验失败统一 VALIDATION_001/422
    expect(box.owner).toBe('platform'); // 校验失败不得改写开关
  });
});

// 深化（第 3 轮）：这两条端点平时只生成建议，但 **AUTO_TUNE 打开时会直接把建议写成 live 流程定义**
// ——那就是改流程。静态护栏（workflowGuardCoverage）只能证明「代码里挂了闸」，
// 这里补行为锚：证明闸真的按开关开合，且**没开 AUTO_TUNE 时不误伤**（生成建议照常可用）。
describe('097 ⑦ optimize 旁路：自动改流程同样受归属闸约束', () => {
  const savedEnv = { v: undefined as string | undefined };
  beforeEach(() => { savedEnv.v = process.env.MODEL_AUTO_TUNE; });
  afterEach(() => {
    if (savedEnv.v === undefined) delete process.env.MODEL_AUTO_TUNE;
    else process.env.MODEL_AUTO_TUNE = savedEnv.v;
  });

  it('AUTO_TUNE 打开 + 归属=platform → apply-workflow 403（不许客户靠自动优化改流程）', async () => {
    process.env.MODEL_AUTO_TUNE = 'true';
    const r = await call('POST', '/optimize/apply-workflow');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe(WORKFLOW_CONFIG_PLATFORM_ONLY);
  });

  it('AUTO_TUNE 打开 + 归属=platform → generate-mining 403（它会顺手写 live）', async () => {
    process.env.MODEL_AUTO_TUNE = 'true';
    const r = await call('POST', '/optimize/generate-mining');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe(WORKFLOW_CONFIG_PLATFORM_ONLY);
  });

  it('AUTO_TUNE 打开 + 归属=tenant → 同端点不再 403（开关放开后恢复原行为）', async () => {
    process.env.MODEL_AUTO_TUNE = 'true';
    box.owner = 'tenant';
    const r = await call('POST', '/optimize/apply-workflow');
    expect(r.status).not.toBe(403);
    expect(r.body.code).not.toBe(WORKFLOW_CONFIG_PLATFORM_ONLY);
  });

  it('AUTO_TUNE 关闭 → apply-workflow 早退 200，闸门不介入（没开就不该被误伤）', async () => {
    process.env.MODEL_AUTO_TUNE = 'false';
    const r = await call('POST', '/optimize/apply-workflow');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.applied).toBe(false);
  });

  it('AUTO_TUNE 关闭 → generate-mining 仍可生成建议（200，闸门不该挡只读的挖掘）', async () => {
    process.env.MODEL_AUTO_TUNE = 'false';
    const r = await call('POST', '/optimize/generate-mining');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.applied).toBe(false);
  });
});
