// acceptance.http.test.ts —— 真·HTTP 层验收端点测试（**prod 鉴权模式**）。
//
// 覆盖三类 bug：
//   ① 角色门禁：验收角色白名单由 workflow_def 验收边的 allowedRoles 单一事实源决定
//      （架构🔴2：删除硬编码 ACCEPTANCE_ROLES，与流程配置同源）。worker/dispatcher/service_desk → 403。
//   ② 老租户自救：def 缺验收边 → 409 + 文案含「启用完工验收」（而不是看不懂的 422 illegal transition）。
//   ③ reject 联动 SQL 序列：INSERT work_acceptance → transition → DELETE settlement_item ... RETURNING
//      → 只删**本次受影响**的草稿单（架构🔴5：严禁「无差别删除本租户所有空 draft」，
//      那会连带删掉他人正在编辑的草稿单，一次打回卡住全租户结算）。
//
// 断言纪律：一律断言真实 HTTP 状态码（expect(res.status).toBe(403)），
//   禁止 try{...}catch(e){expect(e.status)...} 这种「不抛错就空过」的写法。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';
import type { AuthLocals } from '../middleware/auth.js';
import { RICH_WORK_ORDER_DEF, DEFAULT_WORK_ORDER_DEF, type WorkflowDef } from '../engine/stateMachine.js';
import { ensureAcceptanceEdges } from '../engine/acceptanceEdges.js';

// ---- mock 掉 DB 连接池 ----
const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(h.client),
  assertSafeTenantId: (t: string) => t,
  default: { connect: async () => { throw new Error('[acceptance.http.test] 单测禁用真实 pool'); } },
}));

import acceptanceRouter from '../routes/acceptance.js';

interface Handler {
  match: (text: string) => boolean;
  reply: (text: string, params: unknown[]) => { rows: unknown[]; rowCount?: number };
}

function makeClient(handlers: Handler[], opts?: { strict?: boolean }) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const misses: string[] = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      for (const hd of handlers) {
        if (hd.match(text)) return hd.reply(text, params ?? []);
      }
      misses.push(text);
      if (opts?.strict) throw new Error(`[mock] 未命中 handler 的 SQL：${text}`);
      return { rows: [], rowCount: 1 };
    },
  };
  return { client, calls, misses } as { client: unknown; calls: typeof calls; misses: string[] };
}

const T = 't-acc-http';
const WO = 'WO_20260905_0001';

/** 富模板 + 幂等注入两条验收边（allowedRoles = admin/operator/reviewer）。 */
const RICH_WITH_ACCEPTANCE: WorkflowDef = ensureAcceptanceEdges(RICH_WORK_ORDER_DEF).def;
/** 无验收边的老租户 def（DEFAULT 4 态图：缺 acceptance_pass / acceptance_reject）。 */
const LEGACY_NO_EDGES: WorkflowDef = JSON.parse(JSON.stringify(DEFAULT_WORK_ORDER_DEF)) as WorkflowDef;

interface AccHandlersOpts {
  status?: string;
  def?: WorkflowDef;
  /** DELETE settlement_item ... RETURNING 的返回行（settlement_id 列表） */
  removedSettlementIds?: string[];
  /** DELETE settlement s ... RETURNING s.id 的返回行（被整单清空后删掉单头的 settlement_id） */
  emptiedSettlementIds?: string[];
  slaMinutes?: number | null;
}

function acceptanceHandlers(opts: AccHandlersOpts = {}): Handler[] {
  const status = opts.status ?? 'completed';
  const def = opts.def ?? RICH_WITH_ACCEPTANCE;
  const removed = opts.removedSettlementIds ?? ['st-1'];
  const emptied = opts.emptiedSettlementIds ?? [];
  const slaMinutes = opts.slaMinutes === undefined ? 60 : opts.slaMinutes;
  return [
    // ① applyAcceptance 行锁读工单（带 sla_minutes，与 transition 的 SELECT * 区分开）
    {
      match: (t) => t.includes('FROM work_orders') && t.includes('FOR UPDATE') && t.includes('sla_minutes'),
      reply: () => ({ rows: [{ id: WO, status, order_no: 'WO_1', sla_minutes: slaMinutes }] }),
    },
    // transition → findOneForUpdate
    {
      match: (t) => t.startsWith('SELECT * FROM work_orders') && t.includes('FOR UPDATE'),
      reply: () => ({ rows: [{ id: WO, status, order_no: 'WO_1', assignee_id: null, sla_minutes: slaMinutes }] }),
    },
    // workflow_def（applyAcceptance 的 assertAcceptanceEdgesReady + transition 的 getWorkflowDef）
    { match: (t) => t.includes('FROM workflow_def'), reply: () => ({ rows: [{ def }] }) },
    { match: (t) => t.includes('INSERT INTO work_acceptance'), reply: () => ({ rows: [{ id: 'acc-1' }] }) },
    {
      match: (t) => t.includes('UPDATE work_orders SET status') && t.includes('RETURNING'),
      reply: (_t, p) => ({ rows: [{ id: WO, status: p[0], tenant_id: T }] }),
    },
    { match: (t) => t.includes('INSERT INTO ticket_event'), reply: () => ({ rows: [], rowCount: 1 }) },
    { match: (t) => t.includes('INSERT INTO domain_event'), reply: () => ({ rows: [], rowCount: 1 }) },
    { match: (t) => t.includes('UPDATE worker SET load'), reply: () => ({ rows: [], rowCount: 1 }) },
    // reject 联动：清本单明细并 RETURNING 受影响的 settlement_id
    {
      match: (t) => t.includes('DELETE FROM settlement_item') && t.includes('RETURNING'),
      reply: () => ({ rows: removed.map((id) => ({ settlement_id: id })), rowCount: removed.length }),
    },
    {
      match: (t) => t.includes('DELETE FROM settlement s'),
      reply: () => ({ rows: emptied.map((id) => ({ id })), rowCount: emptied.length }),
    },
    // recalcHeader（QA🟡1）：重算剩余明细所在草稿单的表头 total/item_count
    {
      match: (t) => t.includes('COALESCE(SUM(amount)') && t.includes('FROM settlement_item'),
      reply: () => ({ rows: [{ total: '88.00', c: 1 }] }),
    },
    { match: (t) => t.includes('UPDATE settlement SET total'), reply: () => ({ rows: [], rowCount: 1 }) },
    { match: (t) => t.startsWith('SELECT * FROM settlement WHERE id = $1'), reply: (_t, p) => ({ rows: [{ id: p[0], status: 'draft', item_count: 1 }] }) },
    { match: (t) => t.includes('sla_due_at = NULL'), reply: () => ({ rows: [], rowCount: 1 }) },
    { match: (t) => t.includes("sla_due_at = now() + ($3::int * interval '1 minute')"), reply: () => ({ rows: [], rowCount: 1 }) },
  ];
}

// ---- 真实 express + 真 HTTP ----
let server: Server;
let baseUrl = '';
const auth: AuthLocals & { role: string } = {
  tenantId: T,
  requestId: 'req-acc',
  idempotencyKey: undefined,
  userId: 'u-1',
  username: 'admin',
  role: 'admin',
  authMode: 'prod',
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = auth;
    next();
  });
  app.use('/api/v1', acceptanceRouter);
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

async function accept(
  body: unknown,
  opts?: { role?: string | null; workOrderId?: string; authMode?: 'prod' | 'dev' },
): Promise<{ status: number; body: Record<string, unknown> }> {
  // role 显式传 null = 「请求里没有角色」；未传（undefined）才回落到 admin。
  auth.role = (opts?.role === undefined ? 'admin' : opts.role) as string;
  auth.username = auth.role;
  auth.authMode = opts?.authMode ?? 'prod';
  const id = opts?.workOrderId ?? WO;
  const r = await fetch(`${baseUrl}/open/work_order/${id}/acceptance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  return { status: r.status, body: parsed };
}

describe('① 验收角色门禁（prod 模式 · 由 workflow_def 边的 allowedRoles 单一事实源决定）', () => {
  it('admin / operator / reviewer → 200（验收边 allowedRoles 放行）', async () => {
    for (const role of ['admin', 'operator', 'reviewer']) {
      h.client = makeClient(acceptanceHandlers(), { strict: true }).client;
      const r = await accept({ result: 'pass' }, { role });
      expect(r.status, `role=${role} 期望 200，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(200);
      expect(r.body.ok).toBe(true);
      expect(r.body.acceptance_id).toBe('acc-1');
      expect(r.body.status).toBe('closed');
    }
  });

  it('worker / dispatcher / service_desk → 403（不在验收边 allowedRoles 内）', async () => {
    for (const role of ['worker', 'dispatcher', 'service_desk']) {
      h.client = makeClient(acceptanceHandlers(), { strict: true }).client;
      const r = await accept({ result: 'pass' }, { role });
      expect(r.status, `role=${role} 期望 403，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(403);
      expect(r.body.ok).toBe(false);
    }
  });

  it('role 缺失（为空）→ 403（R9-003：不得因缺角色短路放行）', async () => {
    h.client = makeClient(acceptanceHandlers(), { strict: true }).client;
    const r = await accept({ result: 'pass' }, { role: null });
    expect(r.status, `期望 403，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(403);
  });

  it('reject 同样是 admin/operator/reviewer 专属（worker → 403）', async () => {
    h.client = makeClient(acceptanceHandlers(), { strict: true }).client;
    expect((await accept({ result: 'reject' }, { role: 'worker' })).status).toBe(403);
    h.client = makeClient(acceptanceHandlers(), { strict: true }).client;
    expect((await accept({ result: 'reject' }, { role: 'reviewer' })).status).toBe(200);
  });
});

describe('② 状态与流程前置校验（409 语义）', () => {
  it('非 completed 单验收 → 409', async () => {
    h.client = makeClient(acceptanceHandlers({ status: 'processing' }), { strict: true }).client;
    const r = await accept({ result: 'pass' });
    expect(r.status, `期望 409，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(409);
    expect(String(r.body.message)).toContain('仅已完成工单可验收');
  });

  it('工单不存在 → 404', async () => {
    const handlers = acceptanceHandlers().map((hd) =>
      hd.match('SELECT id, status, order_no, sla_minutes FROM work_orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE')
        ? { match: (t: string) => t.includes('sla_minutes'), reply: () => ({ rows: [] }) }
        : hd,
    );
    h.client = makeClient(handlers, { strict: true }).client;
    const r = await accept({ result: 'pass' });
    expect(r.status).toBe(404);
  });

  it('def 缺验收边 → 409 且文案含「启用完工验收」（老租户可操作自救，而非 422）', async () => {
    h.client = makeClient(acceptanceHandlers({ def: LEGACY_NO_EDGES }), { strict: true }).client;
    const r = await accept({ result: 'pass' });
    expect(r.status, `期望 409，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(409);
    expect(String(r.body.message)).toContain('启用完工验收');
    expect(String(r.body.message)).toContain('acceptance_pass');
  });

  it('def 缺验收边时不得落 work_acceptance 凭证（409 必须发生在写之前）', async () => {
    const mk = makeClient(acceptanceHandlers({ def: LEGACY_NO_EDGES }), { strict: true });
    h.client = mk.client;
    await accept({ result: 'pass' });
    expect(mk.calls.some((c) => c.text.includes('INSERT INTO work_acceptance'))).toBe(false);
  });

  it('body 非法（result 非 pass/reject）→ 400', async () => {
    h.client = makeClient(acceptanceHandlers(), { strict: true }).client;
    const r = await accept({ result: 'maybe' });
    expect(r.status).toBe(400);
  });

  it('media 超过 9 个 → 400', async () => {
    h.client = makeClient(acceptanceHandlers(), { strict: true }).client;
    const r = await accept({ result: 'pass', media: Array.from({ length: 10 }, (_, i) => `u${i}`) });
    expect(r.status).toBe(400);
  });
});

describe('③ reject 联动 SQL 序列（架构🔴5：只清本次受影响的草稿单）', () => {
  it('语句序列：INSERT work_acceptance → transition → DELETE settlement_item ... RETURNING', async () => {
    const mk = makeClient(acceptanceHandlers(), { strict: true });
    h.client = mk.client;
    const r = await accept({ result: 'reject', note: '维修不到位' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('processing');

    const texts = mk.calls.map((c) => c.text);
    const idxIns = texts.findIndex((t) => t.includes('INSERT INTO work_acceptance'));
    const idxUpd = texts.findIndex((t) => t.includes('UPDATE work_orders SET status'));
    const idxDelItem = texts.findIndex((t) => t.includes('DELETE FROM settlement_item'));
    expect(idxIns).toBeGreaterThanOrEqual(0);
    expect(idxUpd).toBeGreaterThan(idxIns); // 凭证先落库，再流转
    expect(idxDelItem).toBeGreaterThan(idxUpd); // 流转成功才做结算清理
  });

  it('DELETE settlement_item 必须带 RETURNING（精确回收受影响的 settlement_id）', async () => {
    const mk = makeClient(acceptanceHandlers({ removedSettlementIds: ['st-1'] }), { strict: true });
    h.client = mk.client;
    await accept({ result: 'reject' });
    const del = mk.calls.find((c) => c.text.includes('DELETE FROM settlement_item'))!;
    expect(del).toBeTruthy();
    expect(del.text).toContain('RETURNING');
    expect(del.text).toContain('si.settlement_id');
    expect(del.params?.[0]).toBe(T);
    expect(del.params?.[1]).toBe(WO);
  });

  it('删单头只作用于受影响的 settlement_id（不得无差别删本租户所有空 draft）', async () => {
    const mk = makeClient(acceptanceHandlers({ removedSettlementIds: ['st-1', 'st-2'] }), { strict: true });
    h.client = mk.client;
    await accept({ result: 'reject' });
    const delHeader = mk.calls.find((c) => c.text.includes('DELETE FROM settlement s'))!;
    expect(delHeader, 'reject 应清理受影响的草稿单头').toBeTruthy();
    // 必须按受影响 id 集合收敛（= ANY($2)），而不是「本租户所有空 draft 一律删」
    expect(delHeader.text).toContain('ANY($2');
    expect(delHeader.params?.[1]).toEqual(['st-1', 'st-2']);
    // 不得出现"仅按 tenant_id + draft + NOT EXISTS"的无差别删除
    const indiscriminate = mk.calls.filter(
      (c) =>
        c.text.includes('DELETE FROM settlement s') &&
        !c.text.includes('ANY($2'),
    );
    expect(indiscriminate.map((c) => c.text)).toEqual([]);
  });

  it('受影响集合为空（本单不在任何草稿单里）→ 不删任何单头', async () => {
    const mk = makeClient(acceptanceHandlers({ removedSettlementIds: [] }), { strict: true });
    h.client = mk.client;
    const r = await accept({ result: 'reject' });
    expect(r.status).toBe(200);
    expect(mk.calls.some((c) => c.text.includes('DELETE FROM settlement s'))).toBe(false);
  });

  it('pass 不触发任何结算清理', async () => {
    const mk = makeClient(acceptanceHandlers(), { strict: true });
    h.client = mk.client;
    await accept({ result: 'pass' });
    expect(mk.calls.some((c) => c.text.includes('DELETE FROM settlement_item'))).toBe(false);
    expect(mk.calls.some((c) => c.text.includes('DELETE FROM settlement s'))).toBe(false);
  });

  it('SLA 按 sla_minutes 重算（有时长来源则 now()+N 分钟，不再一律置 NULL）', async () => {
    const mk = makeClient(acceptanceHandlers({ slaMinutes: 120 }), { strict: true });
    h.client = mk.client;
    await accept({ result: 'reject' });
    const upd = mk.calls.find((c) => c.text.includes('sla_due_at = now()'))!;
    expect(upd).toBeTruthy();
    expect(upd.params?.[2]).toBe(120);
    expect(mk.calls.some((c) => c.text.includes('sla_due_at = NULL'))).toBe(false);
  });

  it('无 sla_minutes → 退回置 NULL（slaScan 跳过 NULL，不误升级）', async () => {
    const mk = makeClient(acceptanceHandlers({ slaMinutes: null }), { strict: true });
    h.client = mk.client;
    await accept({ result: 'reject' });
    expect(mk.calls.some((c) => c.text.includes('sla_due_at = NULL'))).toBe(true);
  });

  // QA🟡1：部分清空的草稿单表头 total/item_count 必须重算——否则管理员确认锁定后
  // 「表头总额 ≠ 明细合计」，账实不符。
  it('部分清空（仍剩明细）→ 对剩余明细所在的 settlement_id 重算表头 total/item_count', async () => {
    // st-1 整单清空被删单头；st-2 还剩其他明细 → 表头必须重算
    const mk = makeClient(
      acceptanceHandlers({ removedSettlementIds: ['st-1', 'st-2'], emptiedSettlementIds: ['st-1'] }),
      { strict: true },
    );
    h.client = mk.client;
    const r = await accept({ result: 'reject' });
    expect(r.status).toBe(200);
    const recalcs = mk.calls.filter((c) => c.text.includes('UPDATE settlement SET total'));
    expect(recalcs, '未对剩余明细的草稿单重算表头').toBeTruthy();
    // 只重算未被删除的 st-2（被清空删除的 st-1 不应重算）
    expect(recalcs.map((c) => c.params?.[2])).toEqual(['st-2']);
    // 重算 SQL 必须限定租户（多租户隔离），且参数顺序 [total, item_count, settlementId, tenantId]
    expect(recalcs[0].text).toContain('tenant_id');
    expect(recalcs[0].params?.[3]).toBe(T);
    // 重算必须发生在单头清理之后（同一事务内先删后算）
    const idxDelHeader = mk.calls.findIndex((c) => c.text.includes('DELETE FROM settlement s'));
    const idxRecalc = mk.calls.findIndex((c) => c.text.includes('UPDATE settlement SET total'));
    expect(idxDelHeader).toBeGreaterThanOrEqual(0);
    expect(idxRecalc).toBeGreaterThan(idxDelHeader);
    // 重算前应先汇总剩余明细（COALESCE(SUM(amount) ...）
    const idxAgg = mk.calls.findIndex((c) => c.text.includes('COALESCE(SUM(amount)'));
    expect(idxAgg).toBeGreaterThanOrEqual(0);
    expect(idxAgg).toBeLessThan(idxRecalc);
  });

  it('整单清空 → 草稿单头仍被删除且不触发表头重算（既有语义不回归）', async () => {
    const mk = makeClient(
      acceptanceHandlers({ removedSettlementIds: ['st-1'], emptiedSettlementIds: ['st-1'] }),
      { strict: true },
    );
    h.client = mk.client;
    const r = await accept({ result: 'reject' });
    expect(r.status).toBe(200);
    const delHeader = mk.calls.find((c) => c.text.includes('DELETE FROM settlement s'))!;
    expect(delHeader, '整单清空时草稿单头必须仍被删除').toBeTruthy();
    expect(delHeader.text).toContain('ANY($2');
    expect(delHeader.text).toContain('RETURNING s.id');
    expect(delHeader.params?.[1]).toEqual(['st-1']);
    // 单头已删，无剩余明细可算 → 不得出现重算语句
    expect(mk.calls.some((c) => c.text.includes('UPDATE settlement SET total'))).toBe(false);
  });
});
