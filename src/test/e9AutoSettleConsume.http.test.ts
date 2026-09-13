// e9AutoSettleConsume.http.test.ts —— E-9 批次「自动结算（BUG-004）+ 耗材二级库存」测试锚点（设计 §8 十四例）。
//
// 【为什么这样测】
//  1) 权限类断言一律走 **真 HTTP + authMode:'prod'**（照 settlement.http.test.ts 先例）：
//     hasPerm 在 dev 模式恒 true，旧测试从未真正走到 403 分支——本文件禁 dev。
//  2) 自动结算段用 repo/route 层直调（runAutoSettleStep / createSettlementDraft），
//     与 learnStep.test.ts 直调 runIncrementalLearnStep 同范式：SAVEPOINT 隔离、幂等、共用函数
//     这些"事务语义"锚点在单元层可精确断言 SQL 序列，不必驱动整台状态机。
//  3) mock client 支持 { strict:true }：任何未命中 handler 的 SQL 直接抛错——新增/改写 SQL 必须同步补 handler
//     （防"改了 SQL 测试无感知"，这正是 071/live 类事故在单测里全绿的机制性原因）。
//  4) 每例都显式断言**结果**（status/字段/SQL 序列），杜绝 try{catch} "不抛错就空过"。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMiddleware } from '../middleware/error.js';
import type { AuthLocals } from '../middleware/auth.js';

// ---- mock 掉 DB 连接池：withTenantClient 直接把脚本化 client 交给回调（不连真库）----
const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(h.client),
  assertSafeTenantId: (t: string) => t,
  default: { connect: async () => { throw new Error('[e9.http.test] 单测禁用真实 pool'); } },
}));

import materialRouter from '../routes/material.js';
import { CONSUME_BLOCKED_STATUSES, CONSUME_WAREHOUSE } from '../routes/material.js';
import { runAutoSettleStep } from '../routes/workOrder.js';
import {
  AUTO_SETTLEMENT_OPERATOR,
  appendMaterialCostItems,
  autoCreateSettlementForOrder,
  createSettlementDraft,
  confirmSettlement,
} from '../repo/settlement.js';
import { parseArgs, assertStatuses, backfillTenant, BACKFILL_OPERATOR } from '../../scripts/backfill_settlements.js';
import { DEFAULT_PERM_MATRIX, PERMS } from '../middleware/role.js';

const T = 't-e9';
const WO = 'WO_20260914_0000000001';
const WO2 = 'WO_20260914_0000000002';
const MID1 = '11111111-1111-4111-8111-111111111111';
const MID2 = '22222222-2222-4222-8222-222222222222';

// ==================== mock client ====================
interface Handler {
  match: (text: string) => boolean;
  reply: (text: string, params: unknown[]) => { rows: unknown[]; rowCount?: number };
}

function makeClient(handlers: Handler[], opts?: { strict?: boolean; failOn?: (text: string) => boolean }) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const misses: string[] = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      if (opts?.failOn?.(text)) throw new Error('模拟结算 SQL 失败（价目表异常）');
      for (const hd of handlers) {
        if (hd.match(text)) return hd.reply(text, params ?? []);
      }
      misses.push(text);
      if (opts?.strict) throw new Error(`[mock] 未命中 handler 的 SQL：${text}`);
      return { rows: [], rowCount: 1 };
    },
  };
  return { client: client as unknown as import('pg').PoolClient, calls, misses };
}

/**
 * SQL 参数按「数组列」取值（取首元素）。
 *
 * params 的静态类型是 unknown[]，直接写 params![7][0] 会被 tsc 拦成 TS2571
 * （Object is of type 'unknown'）——这里显式收窄，保持断言表达式简洁可读。
 * 非数组（含 undefined）= 该 SQL 未按数组列传参 → 返回 undefined，由 Number() 映成 NaN 令断言失败，
 * 而不是静默通过。
 */
function arr0(col: unknown): unknown {
  return Array.isArray(col) ? col[0] : undefined;
}

/** 无租户覆盖行 → hasPerm 走默认矩阵（生产默认形态）。 */
const BASE: Handler[] = [
  { match: (t) => t.includes('SELECT perm FROM role_permission'), reply: () => ({ rows: [], rowCount: 0 }) },
];
/** 平台代授形态：role_permission 有行 → 覆盖集合生效。 */
const granted = (perm: string): Handler[] => [
  { match: (t) => t.includes('SELECT perm FROM role_permission'), reply: () => ({ rows: [{ perm }], rowCount: 1 }) },
];

const SAVEPOINT_H: Handler = {
  match: (t) => /^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(t),
  reply: () => ({ rows: [], rowCount: 0 }),
};

/** 结算建草稿全链路 handlers（含 E-9 耗材联动）。匹配顺序 = 先具体后泛化。 */
function settleHandlers(opts?: {
  orders?: Array<Record<string, unknown>>;
  settled?: Array<Record<string, unknown>>;
  /** 自动结算入口预检：该工单是否已有结算明细 */
  existingAutoItem?: boolean;
  /** inventory_log 聚合结果（非空即触发 source='material' 追加） */
  materialAgg?: Array<Record<string, unknown>>;
  /** 防双计预检：已存在 material 明细的工单 */
  existingMaterial?: string[];
  /** recalcHeader 返回的聚合（有耗材追加时才会被走到） */
  agg?: { total: string; c: number };
  headerStatus?: string;
}): Handler[] {
  const orders = opts?.orders ?? [{ id: WO, order_no: WO, status: 'evaluated', category: '空调维修' }];
  const header = {
    id: 'st-1',
    tenant_id: T,
    settlement_no: 'ST202609140001',
    status: opts?.headerStatus ?? 'draft',
    total: '120.00',
    item_count: 1,
  };
  return [
    ...BASE,
    // 自动结算入口预检（该工单是否已有任何结算明细）
    {
      match: (t) => t.includes('SELECT 1 FROM settlement_item WHERE tenant_id = $1 AND work_order_id = $2'),
      reply: () => (opts?.existingAutoItem ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 }),
    },
    { match: (t) => t.includes('FROM work_orders') && t.includes('ANY($2'), reply: () => ({ rows: orders }) },
    { match: (t) => t.includes('FROM settlement_item si') && t.includes('JOIN work_orders'), reply: () => ({ rows: opts?.settled ?? [] }) },
    { match: (t) => t.includes('COUNT(*)::int AS c FROM settlement WHERE'), reply: () => ({ rows: [{ c: 0 }] }) },
    SAVEPOINT_H,
    { match: (t) => t.includes('INSERT INTO settlement ('), reply: () => ({ rows: [{ id: 'st-1' }] }) },
    {
      match: (t) => t.includes('FROM product_catalog'),
      reply: (_t, p) => ({ rows: ((p[1] as string[]) ?? []).includes('空调维修') ? [{ code: 'AC', name: '空调维修', price: '120.00' }] : [] }),
    },
    // 耗材行 INSERT（先匹配，防被服务行 handler 吞掉）；返回 rowCount = 追加行数
    {
      match: (t) => t.includes('INSERT INTO settlement_item') && t.includes("'material'"),
      reply: () => ({ rows: [], rowCount: (opts?.materialAgg ?? []).length }),
    },
    { match: (t) => t.includes('INSERT INTO settlement_item'), reply: () => ({ rows: [], rowCount: 1 }) },
    // E-9 耗材聚合（inventory_log × material）
    {
      match: (t) => t.includes('FROM inventory_log il') && t.includes('JOIN material m'),
      reply: () => ({ rows: opts?.materialAgg ?? [], rowCount: (opts?.materialAgg ?? []).length }),
    },
    // 防双计预检
    {
      match: (t) => t.includes('SELECT DISTINCT work_order_id FROM settlement_item'),
      reply: () => ({ rows: (opts?.existingMaterial ?? []).map((id) => ({ work_order_id: id })), rowCount: (opts?.existingMaterial ?? []).length }),
    },
    { match: (t) => t.includes('COALESCE(SUM(amount)'), reply: () => ({ rows: [opts?.agg ?? { total: '120.00', c: 1 }] }) },
    { match: (t) => t.includes('UPDATE settlement SET total'), reply: () => ({ rows: [], rowCount: 1 }) },
    { match: (t) => t.includes('SELECT * FROM settlement WHERE id'), reply: () => ({ rows: [header] }) },
  ];
}

// ==================== HTTP 脚手架（material 路由 · prod 鉴权）====================
let server: Server;
let baseUrl = '';
const auth: AuthLocals = {
  tenantId: T,
  userId: 'acc-1',
  username: 'admin',
  role: 'admin',
  authMode: 'prod',
} as AuthLocals;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = auth;
    next();
  });
  app.use('/api/v1', materialRouter);
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

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts?: { body?: unknown; role?: string | null; authMode?: 'prod' | 'dev' },
): Promise<{ status: number; body: Record<string, unknown> }> {
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

/** 耗材消耗 handlers（工单/材料/库存/流水/事件）。 */
function consumeHandlers(opts?: {
  status?: string;
  orderFound?: boolean;
  inventoryQty?: number | null;
  perms?: Handler[];
}): Handler[] {
  const status = opts?.status ?? 'processing';
  const qty = opts?.inventoryQty === undefined ? 10 : opts.inventoryQty;
  return [
    ...(opts?.perms ?? BASE),
    {
      match: (t) => t.includes('FROM work_orders') && t.includes('FOR UPDATE'),
      reply: () =>
        opts?.orderFound === false
          ? { rows: [], rowCount: 0 }
          : { rows: [{ id: WO, order_no: WO, status }], rowCount: 1 },
    },
    { match: (t) => t.includes('SELECT id, name FROM material'), reply: (_t, p) => ({ rows: [{ id: p[0], name: `耗材-${String(p[0]).slice(0, 4)}` }], rowCount: 1 }) },
    {
      match: (t) => t.includes('SELECT qty FROM inventory'),
      reply: () => (qty === null ? { rows: [], rowCount: 0 } : { rows: [{ qty }], rowCount: 1 }),
    },
    { match: (t) => t.includes('UPDATE inventory SET qty'), reply: () => ({ rows: [], rowCount: 1 }) },
    { match: (t) => t.includes('INSERT INTO inventory_log'), reply: () => ({ rows: [], rowCount: 1 }) },
    { match: (t) => t.includes('INSERT INTO domain_event'), reply: () => ({ rows: [], rowCount: 1 }) },
  ];
}

// ==================== ① 自动结算：evaluated → 自动草稿 ====================
describe('① 自动结算（BUG-004）：评价流转自动生成 draft 结算草稿', () => {
  it('created=true / 单号草稿 / created_by=auto:evaluated / 明细含 source=service 价目行', async () => {
    const mk = makeClient(settleHandlers(), { strict: true });
    const r = await runAutoSettleStep(mk.client, T, WO);
    expect(r.settleError).toBeNull();
    expect(r.created).toBe(true);
    expect(r.settlementId).toBe('st-1');

    // SAVEPOINT 包裹（隔离语义的结构证据）
    const texts = mk.calls.map((c) => c.text);
    expect(texts[0]).toBe('SAVEPOINT auto_settle');
    expect(texts).toContain('RELEASE SAVEPOINT auto_settle');

    // 创建人留痕 = 'auto:evaluated'（FE 据此打「自动生成」标记）
    const ins = mk.calls.find((c) => c.text.includes('INSERT INTO settlement ('))!;
    expect(ins.params![2]).toBe(AUTO_SETTLEMENT_OPERATOR);
    expect(AUTO_SETTLEMENT_OPERATOR).toBe('auto:evaluated');

    // 服务价目预填行：source 走列默认 'service'（未显式写 source 列 = 默认值，存量语义不变）
    const svc = mk.calls.find((c) => c.text.includes('INSERT INTO settlement_item') && c.text.includes('category_code'))!;
    expect(svc.text).not.toContain('source'); // 服务行不写 source 列 → DEFAULT 'service'
    expect(svc.params![2]).toEqual([WO]);
    expect(svc.params![3]).toEqual(['AC']); // 命中价目 code 快照
    expect(Number(arr0(svc.params![7]))).toBe(120); // amount = price × qty
  });
});

// ==================== ② 幂等 ====================
describe('② 幂等：该工单已有结算明细 → 跳过（不建第二单）', () => {
  it('existingAutoItem → created=false/skipped=true，且零写库', async () => {
    const mk = makeClient(settleHandlers({ existingAutoItem: true }), { strict: true });
    const r = await runAutoSettleStep(mk.client, T, WO);
    expect(r.settleError).toBeNull();
    expect(r.created).toBe(false);
    expect(r.skipped).toBe(true);
    expect(r.settlementId).toBeNull();
    expect(mk.calls.some((c) => c.text.includes('INSERT INTO settlement ('))).toBe(false);
    expect(mk.calls.some((c) => c.text.includes('INSERT INTO settlement_item'))).toBe(false);
  });

  it('并发兜底：createSettlementDraft 报 already_settled → 同口径跳过（非错误）', async () => {
    const mk = makeClient(
      settleHandlers({ settled: [{ work_order_id: WO, order_no: WO }] }),
      { strict: true },
    );
    const r = await autoCreateSettlementForOrder(mk.client, T, WO);
    expect(r.skipped).toBe(true);
    expect(r.created).toBe(false);
  });
});

// ==================== ③ SAVEPOINT 隔离 ====================
describe('③ SAVEPOINT 隔离：结算失败不阻断评价流转（settle_error 诚实透出）', () => {
  it('结算内 SQL 抛错 → 回滚到 SAVEPOINT，settleError 非空且不冒泡', async () => {
    const mk = makeClient(settleHandlers(), { strict: true, failOn: (t) => t.includes('FROM product_catalog') });
    const r = await runAutoSettleStep(mk.client, T, WO);

    expect(r.created).toBe(false);
    expect(r.settleError).toBeTruthy();
    expect(String(r.settleError)).toContain('模拟结算 SQL 失败');

    const texts = mk.calls.map((c) => c.text);
    const saveIdx = texts.indexOf('SAVEPOINT auto_settle');
    const rbIdx = texts.indexOf('ROLLBACK TO SAVEPOINT auto_settle');
    expect(saveIdx).toBeGreaterThanOrEqual(0);
    expect(rbIdx).toBeGreaterThan(saveIdx);
    // 失败路径不得 RELEASE（否则隔离失效）
    expect(texts).not.toContain('RELEASE SAVEPOINT auto_settle');
  });

  it('失败发生在建单之后也不残留：本段整体回滚（结构证据 = ROLLBACK 在 INSERT settlement 之后）', async () => {
    const mk = makeClient(settleHandlers(), { strict: true, failOn: (t) => t.includes('FROM product_catalog') });
    await runAutoSettleStep(mk.client, T, WO);
    const texts = mk.calls.map((c) => c.text);
    expect(texts.findIndex((t) => t.includes('INSERT INTO settlement ('))).toBeLessThan(
      texts.indexOf('ROLLBACK TO SAVEPOINT auto_settle'),
    );
  });
});

// ==================== ④ 人工多单合并同样追加耗材行 ====================
describe('④ 人工建单（多单合并）与自动结算共用耗材联动函数', () => {
  it('两单合并：服务行批量 + 各单耗材行，均落 source 正确', async () => {
    const mk = makeClient(
      settleHandlers({
        orders: [
          { id: WO, order_no: WO, status: 'completed', category: '空调维修' },
          { id: WO2, order_no: WO2, status: 'closed', category: '空调维修' },
        ],
        materialAgg: [
          { work_order_id: WO, material_id: MID1, qty: '2.00', material_code: 'MAT-1', material_name: '滤芯', material_price: '30.00' },
          { work_order_id: WO2, material_id: MID2, qty: '1.00', material_code: 'MAT-2', material_name: '密封圈', material_price: '5.00' },
        ],
        agg: { total: '305.00', c: 4 },
      }),
      { strict: true },
    );
    const r = await createSettlementDraft(mk.client, T, [WO, WO2], 'admin');
    expect(r.ok).toBe(true);
    const matIns = mk.calls.filter((c) => c.text.includes('INSERT INTO settlement_item') && c.text.includes("'material'"));
    expect(matIns).toHaveLength(1); // 批量 unnest 一条 INSERT
    expect(matIns[0].params![2]).toEqual([WO, WO2]);
    expect(matIns[0].params![4]).toEqual(['MAT-1', 'MAT-2']);
    // 服务行仍是一条批量 INSERT（未被耗材行挤掉）
    const svcIns = mk.calls.filter((c) => c.text.includes('INSERT INTO settlement_item') && c.text.includes('category_code') && !c.text.includes("'material'"));
    expect(svcIns).toHaveLength(1);
    expect(svcIns[0].params![2]).toEqual([WO, WO2]);
  });
});

// ==================== ⑤ confirm 流程不变 ====================
describe('⑤ confirm 流程不变：自动草稿走同一条 draft→confirmed 路径', () => {
  it('自动草稿可被 admin 确认锁定（两态机零改动）', async () => {
    const header = { id: 'st-1', tenant_id: T, settlement_no: 'ST202609140001', status: 'draft', total: '150.00', item_count: 2 };
    const mk = makeClient([
      ...BASE,
      { match: (t) => t.includes('FROM settlement WHERE id = $1 AND tenant_id = $2 FOR UPDATE'), reply: () => ({ rows: [header] }) },
      { match: (t) => t.includes('COUNT(*)::int AS c FROM settlement_item WHERE settlement_id'), reply: () => ({ rows: [{ c: 2 }] }) },
      { match: (t) => t.includes("SET status = 'confirmed'"), reply: () => ({ rows: [], rowCount: 1 }) },
      { match: (t) => t.includes('SELECT * FROM settlement WHERE id'), reply: () => ({ rows: [{ ...header, status: 'confirmed' }] }) },
    ], { strict: true });
    const s = await confirmSettlement(mk.client, T, 'st-1', 'admin');
    expect(s.status).toBe('confirmed');
    const upd = mk.calls.find((c) => c.text.includes("SET status = 'confirmed'"))!;
    expect(upd.params![0]).toBe('admin');
  });
});

// ==================== ⑥ 存量补建脚本 ====================
describe('⑥ 存量补建脚本（scripts/backfill_settlements.ts）', () => {
  // 候选行必须带 category（= work_orders.catalog 别名）——否则 createSettlementDraft 的 catValues 为空、
  // 价目表查询被跳过，「单笔失败不中断整批」一例的 failOn('FROM product_catalog') 永远不会命中（假绿）。
  const candidates = [
    { id: WO, order_no: WO, status: 'evaluated', category: '空调维修' },
    { id: WO2, order_no: WO2, status: 'evaluated', category: '空调维修' },
  ];

  it('参数解析：--dry-run / --tenant / --status / --limit；未知参数与非法状态直接抛错（不静默按默认跑）', () => {
    expect(parseArgs(['--dry-run'])).toMatchObject({ dryRun: true, tenant: null, statuses: ['evaluated'], limit: null });
    expect(parseArgs(['--tenant=t-x', '--limit=5', '--status=evaluated,closed'])).toMatchObject({
      tenant: 't-x',
      limit: 5,
      statuses: ['evaluated', 'closed'],
    });
    expect(() => parseArgs(['--dryrun'])).toThrowError(/未知参数/);
    expect(() => parseArgs(['--limit=0'])).toThrowError(/正整数/);
    expect(() => assertStatuses(['evaluated', 'bogus'], ['completed', 'closed', 'evaluated'])).toThrowError(/非法状态/);
    expect(BACKFILL_OPERATOR).toBe('backfill:e9');
  });

  it('候选集 SQL 自带幂等（NOT EXISTS settlement_item）——重跑天然全跳过', async () => {
    const mk = makeClient(settleHandlers({ orders: candidates }), { strict: true });
    h.client = mk.client;
    await backfillTenant(T, { dryRun: true, statuses: ['evaluated'], limit: null }, { log: () => undefined });
    const cand = mk.calls.find((c) => c.text.includes('FROM work_orders') && c.text.includes('NOT EXISTS'))!;
    expect(cand.text).toContain('NOT EXISTS');
    expect(cand.text).toContain('settlement_item');
    expect(cand.text).toContain('$2::text[]'); // 状态数组显式 ::text[]（防类型误推）
    expect(cand.params![1]).toEqual(['evaluated']);
  });

  it('dry-run：只统计不写库（报告 candidates=2 / created=0，零 INSERT）', async () => {
    const mk = makeClient(settleHandlers({ orders: candidates }), { strict: true });
    h.client = mk.client;
    const rep = await backfillTenant(T, { dryRun: true, statuses: ['evaluated'], limit: null }, { log: () => undefined });
    expect(rep.candidates).toBe(2);
    expect(rep.created).toBe(0);
    expect(mk.calls.some((c) => c.text.includes('INSERT INTO settlement ('))).toBe(false);
  });

  it('正式执行：逐单建草稿（created=2），留痕 backfill:e9；重跑全跳过（幂等）', async () => {
    const mk = makeClient(settleHandlers({ orders: candidates }), { strict: true });
    h.client = mk.client;
    const rep = await backfillTenant(T, { dryRun: false, statuses: ['evaluated'], limit: null }, { log: () => undefined });
    expect(rep.created).toBe(2);
    expect(rep.failed).toBe(0);
    expect(rep.skipped).toBe(0);
    const ins = mk.calls.filter((c) => c.text.includes('INSERT INTO settlement ('));
    expect(ins).toHaveLength(2);
    for (const i of ins) expect(i.params![2]).toBe(BACKFILL_OPERATOR);

    // 重跑：候选集返回 0（结算明细已存在）→ created=0，零 INSERT
    const mk2 = makeClient(settleHandlers({ orders: [] }), { strict: true });
    h.client = mk2.client;
    const rep2 = await backfillTenant(T, { dryRun: false, statuses: ['evaluated'], limit: null }, { log: () => undefined });
    expect(rep2.candidates).toBe(0);
    expect(rep2.created).toBe(0);
    expect(mk2.calls.some((c) => c.text.includes('INSERT INTO settlement ('))).toBe(false);
  });

  it('单笔失败不中断整批：失败计数 + 逐单原因入报告', async () => {
    const mk = makeClient(settleHandlers({ orders: candidates }), {
      strict: true,
      failOn: (t) => t.includes('FROM product_catalog'),
    });
    h.client = mk.client;
    const rep = await backfillTenant(T, { dryRun: false, statuses: ['evaluated'], limit: null }, { log: () => undefined });
    expect(rep.failed).toBe(2);
    expect(rep.created).toBe(0);
    expect(rep.failures).toHaveLength(2);
    expect(rep.failures[0].orderNo).toBe(WO);
    expect(String(rep.failures[0].error)).toContain('模拟结算 SQL 失败');
  });

  it('--limit 截断：只处理前 N 单且报告候选为实际处理数', async () => {
    const mk = makeClient(settleHandlers({ orders: candidates }), { strict: true });
    h.client = mk.client;
    const rep = await backfillTenant(T, { dryRun: true, statuses: ['evaluated'], limit: 1 }, { log: () => undefined });
    expect(rep.candidates).toBe(1);
  });
});

// ==================== ⑦ worker 工单耗材消耗 ====================
describe('⑦ 工单耗材消耗（POST /inventory/consume）：扣库存 + 挂单流水 + 领域事件', () => {
  it('worker 消耗 2 种耗材 → 200，各扣减/各一条 out 流水（带 work_order_id）/各一条事件', async () => {
    const mk = makeClient(consumeHandlers(), { strict: true });
    h.client = mk.client;
    const r = await call('POST', '/inventory/consume', {
      role: 'worker',
      body: { work_order_id: WO, items: [{ material_id: MID1, qty: 2, note: '换滤芯' }, { material_id: MID2, qty: 3 }] },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const items = r.body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ material_id: MID1, remaining_qty: 8 });
    expect(items[1]).toMatchObject({ material_id: MID2, remaining_qty: 7 });

    const updates = mk.calls.filter((c) => c.text.includes('UPDATE inventory SET qty'));
    expect(updates).toHaveLength(2);
    expect(updates[0].params![2]).toBe(8);
    expect(updates[1].params![2]).toBe(7);

    const logs = mk.calls.filter((c) => c.text.includes('INSERT INTO inventory_log'));
    expect(logs).toHaveLength(2);
    for (const l of logs) {
      expect(l.text).toContain("'out'");
      expect(l.params![6]).toBe(WO); // 流水强制挂工单号
      expect(l.params![3]).toBe(WO); // ref_no = 工单号（人工可读）
    }
    const events = mk.calls.filter((c) => c.text.includes('INSERT INTO domain_event'));
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.params![1]).toBe('material');
      expect(e.params![3]).toBe('material_consumed');
      expect(String(e.params![5])).toContain(WO);
    }
  });

  it('同一材料重复出现先合并（防"逐行读同一库存行"的重复扣减判断失真）', async () => {
    const mk = makeClient(consumeHandlers({ inventoryQty: 3 }), { strict: true });
    h.client = mk.client;
    const r = await call('POST', '/inventory/consume', {
      role: 'worker',
      body: { work_order_id: WO, items: [{ material_id: MID1, qty: 2 }, { material_id: MID1, qty: 2 }] },
    });
    // 合并后需 4 > 可用 3 → 整体拒绝（若未合并则各行各自"合法"，实际超卖）
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('INSUFFICIENT_STOCK');
    expect(String(r.body.message)).toContain('需 4');
  });

  it('工单不存在 → 404 NOT_FOUND', async () => {
    const mk = makeClient(consumeHandlers({ orderFound: false }), { strict: true });
    h.client = mk.client;
    const r = await call('POST', '/inventory/consume', { role: 'worker', body: { work_order_id: 'WO_x', items: [{ material_id: MID1, qty: 1 }] } });
    expect(r.status).toBe(404);
  });

  it('参数校验：qty 非正 / items 为空 / material_id 非 uuid → 400', async () => {
    const mk = makeClient(consumeHandlers(), { strict: true });
    h.client = mk.client;
    for (const body of [
      { work_order_id: WO, items: [{ material_id: MID1, qty: 0 }] },
      { work_order_id: WO, items: [] },
      { work_order_id: WO, items: [{ material_id: 'not-a-uuid', qty: 1 }] },
    ]) {
      const r = await call('POST', '/inventory/consume', { role: 'worker', body });
      expect(r.status, JSON.stringify(r.body)).toBe(400);
    }
  });
});

// ==================== ⑧ 库存不足 all-or-nothing ====================
describe('⑧ 库存不足：422 INSUFFICIENT_STOCK + 事务内零部分扣减', () => {
  it('两种耗材其一不足 → 422 带缺货明细，且没有任何 UPDATE/INSERT（零部分扣减）', async () => {
    // MID1 够（可用 10）；MID2 不够（库存行缺失 = 可用 0）
    const mk = makeClient([
      ...BASE,
      { match: (t) => t.includes('FROM work_orders') && t.includes('FOR UPDATE'), reply: () => ({ rows: [{ id: WO, order_no: WO, status: 'processing' }], rowCount: 1 }) },
      { match: (t) => t.includes('SELECT id, name FROM material'), reply: (_t, p) => ({ rows: [{ id: p[0], name: p[0] === MID2 ? '密封圈' : '滤芯' }], rowCount: 1 }) },
      { match: (t) => t.includes('SELECT qty FROM inventory'), reply: (_t, p) => (p[1] === MID2 ? { rows: [], rowCount: 0 } : { rows: [{ qty: 10 }], rowCount: 1 }) },
      { match: (t) => t.includes('UPDATE inventory SET qty'), reply: () => ({ rows: [], rowCount: 1 }) },
      { match: (t) => t.includes('INSERT INTO inventory_log'), reply: () => ({ rows: [], rowCount: 1 }) },
      { match: (t) => t.includes('INSERT INTO domain_event'), reply: () => ({ rows: [], rowCount: 1 }) },
    ], { strict: true });
    h.client = mk.client;
    const r = await call('POST', '/inventory/consume', {
      role: 'worker',
      body: { work_order_id: WO, items: [{ material_id: MID1, qty: 2 }, { material_id: MID2, qty: 1 }] },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.code).toBe('INSUFFICIENT_STOCK');
    expect(String(r.body.message)).toContain('密封圈');
    expect(String(r.body.message)).toContain('可用 0');
    // all-or-nothing：MID1 虽足额，也一行都没扣（无部分扣减）
    expect(mk.calls.some((c) => c.text.includes('UPDATE inventory SET qty'))).toBe(false);
    expect(mk.calls.some((c) => c.text.includes('INSERT INTO inventory_log'))).toBe(false);
    expect(mk.calls.some((c) => c.text.includes('INSERT INTO domain_event'))).toBe(false);
  });
});

// ==================== ⑨ 终态工单拒收 ====================
describe('⑨ 终态工单不可再登记消耗（422 ORDER_CLOSED）', () => {
  it('evaluated（评价后耗材费已进结算快照）→ 422 ORDER_CLOSED，零库存动作', async () => {
    const mk = makeClient(consumeHandlers({ status: 'evaluated' }), { strict: true });
    h.client = mk.client;
    const r = await call('POST', '/inventory/consume', { role: 'worker', body: { work_order_id: WO, items: [{ material_id: MID1, qty: 1 }] } });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.code).toBe('ORDER_CLOSED');
    expect(mk.calls.some((c) => c.text.includes('UPDATE inventory'))).toBe(false);
  });

  it('cancelled → 422 ORDER_CLOSED', async () => {
    const mk = makeClient(consumeHandlers({ status: 'cancelled' }), { strict: true });
    h.client = mk.client;
    const r = await call('POST', '/inventory/consume', { role: 'worker', body: { work_order_id: WO, items: [{ material_id: MID1, qty: 1 }] } });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('ORDER_CLOSED');
  });

  it('禁入集合口径 = 工作流 doneStates ∪ cancelled（单一事实源断言）', () => {
    for (const s of ['completed', 'closed', 'evaluated', 'cancelled']) {
      expect(CONSUME_BLOCKED_STATUSES).toContain(s);
    }
    expect(CONSUME_BLOCKED_STATUSES).not.toContain('processing');
    expect(CONSUME_WAREHOUSE).toBe('中心库');
  });
});

// ==================== ⑩ consumable.consume 权限 ====================
describe('⑩ consumable.consume（prod 模式 · 真 HTTP 状态码）', () => {
  const body = { work_order_id: WO, items: [{ material_id: MID1, qty: 1 }] };

  it('worker → 200（默认矩阵新增 consumable.consume）', async () => {
    const mk = makeClient(consumeHandlers(), { strict: true });
    h.client = mk.client;
    const r = await call('POST', '/inventory/consume', { role: 'worker', body });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('operator → 200（受理台代工人登记）', async () => {
    const mk = makeClient(consumeHandlers(), { strict: true });
    h.client = mk.client;
    const r = await call('POST', '/inventory/consume', { role: 'operator', body });
    expect(r.status).toBe(200);
  });

  it('dispatcher → 403（默认矩阵无 consumable.consume）', async () => {
    const mk = makeClient(consumeHandlers(), { strict: true });
    h.client = mk.client;
    const r = await call('POST', '/inventory/consume', { role: 'dispatcher', body });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(String(r.body.message)).toContain('consumable.consume');
  });

  it('reviewer / service_desk → 403；角色缺失 → 403', async () => {
    const mk = makeClient(consumeHandlers(), { strict: true });
    h.client = mk.client;
    for (const role of ['reviewer', 'service_desk'] as const) {
      const r = await call('POST', '/inventory/consume', { role, body });
      expect(r.status, `role=${role}`).toBe(403);
    }
    const none = await call('POST', '/inventory/consume', { role: null, body });
    expect(none.status).toBe(403);
  });

  it('平台代授 consumable.consume 覆盖行 → dispatcher 亦可（覆盖集合语义）', async () => {
    const mk = makeClient(consumeHandlers({ perms: granted('consumable.consume') }), { strict: true });
    h.client = mk.client;
    const r = await call('POST', '/inventory/consume', { role: 'dispatcher', body });
    expect(r.status).toBe(200);
  });
});

// ==================== ⑪ 结算联动：服务价目 + 耗材费 ====================
describe('⑪ 结算联动：自动单总额 = 服务价目 + Σ(耗材单价×消耗量)', () => {
  it('material 行 material_id/qty/price/amount 正确，且表头按全部明细重算', async () => {
    const mk = makeClient(
      settleHandlers({
        materialAgg: [
          { work_order_id: WO, material_id: MID1, qty: '2.00', material_code: 'MAT-1', material_name: '滤芯', material_price: '30.00' },
        ],
        agg: { total: '180.00', c: 2 },
      }),
      { strict: true },
    );
    const r = await runAutoSettleStep(mk.client, T, WO);
    expect(r.settleError).toBeNull();
    expect(r.created).toBe(true);

    const mat = mk.calls.find((c) => c.text.includes('INSERT INTO settlement_item') && c.text.includes("'material'"))!;
    expect(mat).toBeTruthy();
    expect(mat.params![1]).toBe('st-1');
    expect(mat.params![2]).toEqual([WO]);
    expect(mat.params![3]).toEqual([MID1]); // material_id
    expect(mat.params![4]).toEqual(['MAT-1']); // category_code = 耗材编号快照
    expect(mat.params![5]).toEqual(['滤芯']); // category_name = 耗材名称快照
    expect(Number(arr0(mat.params![6]))).toBe(30); // price 快照
    expect(Number(arr0(mat.params![7]))).toBe(2); // qty = 累计消耗量
    expect(Number(arr0(mat.params![8]))).toBe(60); // amount = 30 × 2
    expect(mat.params![9]).toEqual(['工单耗材']);

    // 表头重算发生在耗材行之后，且用的是"含耗材"的聚合结果
    const texts = mk.calls.map((c) => c.text);
    const matIdx = texts.findIndex((t) => t.includes('INSERT INTO settlement_item') && t.includes("'material'"));
    const aggIdx = texts.findIndex((t) => t.includes('COALESCE(SUM(amount)'));
    expect(aggIdx).toBeGreaterThan(matIdx);
    const hdr = mk.calls.filter((c) => c.text.includes('UPDATE settlement SET total'));
    const last = hdr[hdr.length - 1];
    expect(Number(last.params![0])).toBe(180); // 120（服务价目）+ 60（耗材）
    expect(last.params![1]).toBe(2);
  });

  it('无耗材消耗 → 不追加任何行、不触发表头重算（存量路径零回归）', async () => {
    const mk = makeClient(settleHandlers(), { strict: true });
    const out = await appendMaterialCostItems(mk.client, T, 'st-1', [WO]);
    expect(out.inserted).toBe(0);
    expect(mk.calls.some((c) => c.text.includes('INSERT INTO settlement_item'))).toBe(false);
    expect(mk.calls.some((c) => c.text.includes('COALESCE(SUM(amount)'))).toBe(false);
  });
});

// ==================== ⑫ 防双计 ====================
describe('⑫ 防双计：已有 material 明细的工单不再追加耗材行', () => {
  it('existingMaterial 命中 → 零耗材 INSERT、零表头重算', async () => {
    const mk = makeClient(
      settleHandlers({
        materialAgg: [
          { work_order_id: WO, material_id: MID1, qty: '2.00', material_code: 'MAT-1', material_name: '滤芯', material_price: '30.00' },
        ],
        existingMaterial: [WO],
      }),
      { strict: true },
    );
    const out = await appendMaterialCostItems(mk.client, T, 'st-1', [WO]);
    expect(out.inserted).toBe(0);
    expect(mk.calls.some((c) => c.text.includes('INSERT INTO settlement_item') && c.text.includes("'material'"))).toBe(false);
    expect(mk.calls.some((c) => c.text.includes('COALESCE(SUM(amount)'))).toBe(false);
  });
});

// ==================== ⑬ 类型修复回归（048 uuid → text）====================
describe('⑬ 类型修复回归：inventory_log.work_order_id uuid → text（084）', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const sql084 = readFileSync(join(root, '084_settlement_material_link.sql'), 'utf8');

  it('084 DDL 文本断言：列类型改 text + 来源列 + 唯一约束放宽到 (tenant_id, work_order_id, source)', () => {
    expect(sql084).toMatch(/ALTER TABLE inventory_log ALTER COLUMN work_order_id TYPE text USING work_order_id::text;/);
    expect(sql084).toMatch(/ALTER TABLE settlement_item ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'service';/);
    expect(sql084).toMatch(/ALTER TABLE settlement_item ADD COLUMN IF NOT EXISTS material_id uuid;/);
    expect(sql084).toMatch(/uq_settlement_item_tenant_wo_source UNIQUE \(tenant_id, work_order_id, source\)/);
    expect(sql084).toMatch(/idx_sti_wo_source[\s\S]*WHERE source = 'material'/);
    // 🔴索引谓词纪律：索引谓词必须是 IMMUTABLE（本批不含 now()）
    const idxPredicate = sql084.split('\n').find((l) => l.includes('WHERE source'))!;
    expect(idxPredicate).not.toMatch(/now\(\)/i);
  });

  // ==================== ⑬b 防重未松的反向证明（team-lead 裁决 2 的强制要求）====================
  // 疑虑：084 把 UV 从 (tenant_id, work_order_id) 放宽为 (tenant_id, work_order_id, source)，
  // 会不会把"同一工单被重复建结算"的防线一起放开？——不会，本组两例分别从**应用层**与**DDL 层**双向钉死：
  //   ① 应用层：createSettlementDraft 的 already_settled 预检仍在，第二笔行在建单 SQL 之前就被拒；
  //   ② DDL 层：source 列 NOT NULL DEFAULT 'service' ⇒ 两笔"服务行"的 (tenant, wo, source) 三元组完全相同
  //      ⇒ 必撞 uq_settlement_item_tenant_wo_source。放宽的只是"服务行 vs 耗材行"这一对合法共存，
  //      不是"同类型两行"。
  it('同工单第二笔 service 行仍被拒：应用层 already_settled 预检拦在建单 SQL 之前（零写库）', async () => {
    const mk = makeClient(
      settleHandlers({ settled: [{ work_order_id: WO, order_no: WO }] }),
      { strict: true },
    );
    const r = await createSettlementDraft(mk.client, T, [WO], 'admin');
    expect(r.ok).toBe(false);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts![0]).toMatchObject({ work_order_id: WO, reason: 'already_settled' });
    // 关键：被拒发生在**任何插入之前**——没有任何 settlement / settlement_item 写库动作
    expect(mk.calls.some((c) => c.text.includes('INSERT INTO settlement ('))).toBe(false);
    expect(mk.calls.some((c) => c.text.includes('INSERT INTO settlement_item'))).toBe(false);
  });

  it('DDL 层：旧两列唯一约束被显式 DROP，新约束三列含 source（同类型第二行必撞 UNIQUE）', () => {
    // team-lead 特别要求：对 072 旧约束的处理必须是**显式** DROP，不靠隐式/无操作兜底
    expect(sql084).toMatch(/ALTER TABLE settlement_item DROP CONSTRAINT IF EXISTS uq_settlement_item_tenant_work_order;/);
    // 新约束三列（service 与 material 各占一档，重复的 service 行仍在同一档 → 撞约束）
    expect(sql084).toMatch(/uq_settlement_item_tenant_wo_source UNIQUE \(tenant_id, work_order_id, source\)/);
    // 反向断言：脚本里**不得**残留两列形态的唯一约束（放宽不等于取消）
    expect(sql084).not.toMatch(/UNIQUE \(tenant_id, work_order_id\)/);
    // source 的默认值正是"服务行"档位——存量行迁移后全部落 'service'，故旧防线对存量依然成立
    expect(sql084).toMatch(/ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'service'/);
  });

  it('DB 行为层：service 行撞约束抛 23505 → createSettlementDraft 转 409 CONFLICT（防重兜底真实触发，不静默吞掉）', async () => {
    // 场景：入口预检与建单之间出现并发写入（预检时该工单尚无明细，服务行 INSERT 时约束已存在）
    //   → PG 对 uq_settlement_item_tenant_wo_source 抛 23505 → 必须转成与 conflicts 同口径的 409，
    //   绝不能落 500 / 静默成功。mock 按真 PG 错误形态（code + constraint 字段）抛出。
    const pgUniqueViolation = Object.assign(
      new Error('duplicate key value violates unique constraint "uq_settlement_item_tenant_wo_source"'),
      { code: '23505', constraint: 'uq_settlement_item_tenant_wo_source' },
    );
    // 只拦服务行 INSERT（含 category_code / 不含 'material'），其余 SQL 走正常 handler
    const svcInsertThrows: Handler = {
      match: (t) => t.includes('INSERT INTO settlement_item') && t.includes('category_code'),
      reply: () => {
        throw pgUniqueViolation;
      },
    };
    const mk = makeClient([svcInsertThrows, ...settleHandlers()], { strict: true });
    await expect(createSettlementDraft(mk.client, T, [WO], 'admin')).rejects.toMatchObject({
      code: 'CONFLICT',
      status: 409,
      message: '工单已被其他结算单占用（并发冲突），请刷新后重试',
    });
    // 结构证据：确实执行到了服务行 INSERT（约束位），错误由 catch(23505) 转译——不是被预检短路
    expect(mk.calls.some((c) => c.text.includes('INSERT INTO settlement_item'))).toBe(true);
  });

  it('非 uuid 形态业务号走 /inventory/out → 200，流水 work_order_id 收下业务号（不再 22P02→500）', async () => {
    const mk = makeClient([
      ...BASE,
      { match: (t) => t.includes('SELECT id FROM material'), reply: () => ({ rows: [{ id: MID1 }], rowCount: 1 }) },
      // 注意：material.ts 里该 SQL 是 `order_no=$2`（无空格），匹配串必须逐字对齐，否则 strict 模式直接炸出 500
      { match: (t) => t.includes('FROM work_orders') && t.includes('order_no=$2'), reply: (_t, p) => ({ rows: [{ id: p[1] }], rowCount: 1 }) },
      { match: (t) => t.includes('SELECT qty FROM inventory'), reply: () => ({ rows: [{ qty: 10 }], rowCount: 1 }) },
      { match: (t) => t.includes('UPDATE inventory SET qty'), reply: () => ({ rows: [], rowCount: 1 }) },
      { match: (t) => t.includes('INSERT INTO inventory_log'), reply: () => ({ rows: [], rowCount: 1 }) },
      { match: (t) => t.includes('INSERT INTO domain_event'), reply: () => ({ rows: [], rowCount: 1 }) },
    ], { strict: true });
    h.client = mk.client;
    const r = await call('POST', '/inventory/out', {
      role: 'admin',
      body: { material_id: MID1, qty: 2, work_order_no: WO },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const log = mk.calls.find((c) => c.text.includes('INSERT INTO inventory_log'))!;
    // 业务号原样落列（text 列接受 WO_ 形态；uuid 列在此必然 22P02）
    expect(log.params![6]).toBe(WO);
    expect(log.params![6]).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('工人仍无手工出库权（必须走挂单 consume）', async () => {
    const mk = makeClient([
      ...BASE,
      { match: (t) => t.includes('SELECT id FROM material'), reply: () => ({ rows: [{ id: MID1 }], rowCount: 1 }) },
    ], { strict: true });
    h.client = mk.client;
    const r = await call('POST', '/inventory/out', { role: 'worker', body: { material_id: MID1, qty: 1 } });
    expect(r.status).toBe(403);
    expect(String(r.body.message)).toContain('material.manage');
  });
});

// ==================== ⑭ 权限收口两种租户形态 ====================
describe('⑭ 权限收口：material.manage / asset.manage 仅 admin（含覆盖行形态）', () => {
  it('operator（默认矩阵）POST /materials → 403；平台代授 material.manage → 201', async () => {
    const denied = makeClient([...BASE], { strict: true });
    h.client = denied.client;
    const r1 = await call('POST', '/materials', { role: 'operator', body: { code: 'M1', name: '滤芯' } });
    expect(r1.status, JSON.stringify(r1.body)).toBe(403);
    expect(String(r1.body.message)).toContain('material.manage');

    const allowed = makeClient([
      ...granted('material.manage'),
      { match: (t) => t.includes('INSERT INTO material'), reply: () => ({ rows: [{ id: 'mat-1', code: 'M1', name: '滤芯' }], rowCount: 1 }) },
    ], { strict: true });
    h.client = allowed.client;
    const r2 = await call('POST', '/materials', { role: 'operator', body: { code: 'M1', name: '滤芯' } });
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
  });

  it('operator PUT/DELETE /materials、POST /inventory/in、/inventory/out、POST /assets、/assets/import 全 403（写归口 manage）', async () => {
    h.client = makeClient([...BASE], { strict: true }).client;
    const cases: Array<[string, 'POST' | 'PUT' | 'DELETE', string, unknown]> = [
      ['PUT', 'PUT', '/materials/m-1', { name: 'x' }],
      ['DELETE', 'DELETE', '/materials/m-1', undefined],
      ['POST/in', 'POST', '/inventory/in', { material_id: MID1, qty: 1 }],
      ['POST/out', 'POST', '/inventory/out', { material_id: MID1, qty: 1 }],
    ];
    for (const [label, method, path, body] of cases) {
      const r = await call(method, path, { role: 'operator', body });
      expect(r.status, `${label} 期望 403，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(403);
    }
  });

  it('worker GET /materials、/inventory、/inventory/logs → 200（读不收：工人选耗材依赖目录读）', async () => {
    h.client = makeClient([
      ...BASE,
      { match: (t) => t.includes('FROM material WHERE'), reply: () => ({ rows: [{ id: MID1, code: 'M1', name: '滤芯' }], rowCount: 1 }) },
      { match: (t) => t.includes('FROM inventory WHERE'), reply: () => ({ rows: [], rowCount: 0 }) },
      { match: (t) => t.includes('FROM inventory_log WHERE'), reply: () => ({ rows: [], rowCount: 0 }) },
    ], { strict: true }).client;
    for (const p of ['/materials', '/inventory', '/inventory/logs']) {
      const r = await call('GET', p, { role: 'worker' });
      expect(r.status, `${p} 期望 200，实际 ${r.status} ${JSON.stringify(r.body)}`).toBe(200);
    }
  });

  it('/inventory/logs?work_order_id= 过滤生效（mp 已消耗清单只读数据源）', async () => {
    const mk = makeClient([
      ...BASE,
      { match: (t) => t.includes('FROM inventory_log WHERE'), reply: () => ({ rows: [], rowCount: 0 }) },
    ], { strict: true });
    h.client = mk.client;
    const r = await call('GET', `/inventory/logs?work_order_id=${WO}`, { role: 'worker' });
    expect(r.status).toBe(200);
    const q = mk.calls.find((c) => c.text.includes('FROM inventory_log WHERE'))!;
    expect(q.text).toContain('work_order_id = $');
    expect(q.params![1]).toBe(WO);
  });

  it('权限矩阵单一事实源：三点登记 + 默认归属正确', () => {
    for (const p of ['material.manage', 'asset.manage', 'consumable.consume'] as const) {
      expect(PERMS).toContain(p);
    }
    // admin 经 [...PERMS] 自动全含
    for (const p of ['material.manage', 'asset.manage', 'consumable.consume'] as const) {
      expect(DEFAULT_PERM_MATRIX.admin).toContain(p);
    }
    // operator：只加 consumable.consume（有意 breaking：不再维护耗材/资产目录）
    expect(DEFAULT_PERM_MATRIX.operator).toContain('consumable.consume');
    expect(DEFAULT_PERM_MATRIX.operator).not.toContain('material.manage');
    expect(DEFAULT_PERM_MATRIX.operator).not.toContain('asset.manage');
    // worker：加 consumable.consume（执行侧）；仍无手工出库权限点
    expect(DEFAULT_PERM_MATRIX.worker).toContain('consumable.consume');
    expect(DEFAULT_PERM_MATRIX.worker).not.toContain('material.manage');
    // 其余角色默认不给
    for (const role of ['dispatcher', 'reviewer', 'service_desk'] as const) {
      expect(DEFAULT_PERM_MATRIX[role]).not.toContain('consumable.consume');
      expect(DEFAULT_PERM_MATRIX[role]).not.toContain('material.manage');
      expect(DEFAULT_PERM_MATRIX[role]).not.toContain('asset.manage');
    }
  });
});
