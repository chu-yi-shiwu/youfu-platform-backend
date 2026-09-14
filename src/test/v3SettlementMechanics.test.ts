// V3 机制修复批次——结算三项（D1/D2/D3）回归护栏。
// 范式与 settlement.http.test.ts 相同：真实 express（prod 鉴权）+ 脚本化 mock client。
//   D1 manual_edited：手工改价冻结 / note 不冻结 / 显式交还 / 重投影 WHERE 守护 / PG"不更新不报错"语义模拟
//   D2 voided：快照删明细+表头冻结 / 前置条件 / 重复作废 / 理由必填 / 导出 409
//   D3 退料回冲：type='out' 负 qty / 净消耗守卫 / SETTLEMENT_LOCKED / draft 重投影联动
// 注：②「同工单重建 201」的 uq_sti_service 键位释放属真库语义（部分唯一索引谓词只看
//     settlement_item 行），本层锚定 DELETE 明细行执行 + 注释挂账真库负例（对齐 085④ 惯例）。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';
import type { AuthLocals } from '../middleware/auth.js';

// ---- mock DB 连接池（与 settlement.http.test.ts 同款）----
const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../db/pool.js', () => ({
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) => fn(h.client),
  assertSafeTenantId: (t: string) => t,
  default: { connect: async () => { throw new Error('[v3Settlement.test] 单测禁用真实 pool'); } },
}));

import settlementRouter from '../routes/settlement.js';
import materialRouter from '../routes/material.js';
import { syncMaterialCostRows } from '../repo/settlement.js';

interface Handler {
  match: (text: string) => boolean;
  reply: (text: string, params: unknown[]) => { rows: unknown[]; rowCount?: number };
}

function makeClient(handlers: Handler[], opts?: { strict?: boolean }) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      for (const hd of handlers) {
        if (hd.match(text)) return hd.reply(text, params ?? []);
      }
      if (opts?.strict) throw new Error(`[mock] 未命中 handler 的 SQL：${text}`);
      return { rows: [], rowCount: 1 };
    },
  };
  return { client, calls } as { client: unknown; calls: typeof calls };
}

const T = 't-v3';
const BASE: Handler[] = [
  { match: (t: string) => t.includes('SELECT perm FROM role_permission'), reply: () => ({ rows: [], rowCount: 0 }) },
];

let server: Server;
let baseUrl = '';
const auth: AuthLocals & { role: string } = {
  tenantId: T,
  requestId: 'req-v3',
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
  app.use('/api/v1', settlementRouter);
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

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed as any };
}

// ==================== D1 人工改价保护 ====================
describe('V3-D1 manual_edited 人工改价保护', () => {
  function itemHandlers(item: Record<string, unknown>) {
    return [
      ...BASE,
      { match: (t: string) => t.includes('FROM settlement WHERE id = $1 AND tenant_id = $2 FOR UPDATE'), reply: () => ({ rows: [{ id: 's-1', tenant_id: T, status: 'draft' }], rowCount: 1 }) },
      { match: (t: string) => t.includes('SELECT * FROM settlement_item WHERE id = $1 AND settlement_id'), reply: () => ({ rows: [item], rowCount: 1 }) },
      { match: (t: string) => t.includes('UPDATE settlement_item SET price'), reply: () => ({ rows: [], rowCount: 1 }) },
      { match: (t: string) => t.includes('COALESCE(SUM(amount)'), reply: () => ({ rows: [{ total: '40', c: 1 }], rowCount: 1 }) },
      { match: (t: string) => t.includes('UPDATE settlement SET total'), reply: () => ({ rows: [], rowCount: 1 }) },
    ];
  }

  it('① 手工改价（patch price）→ UPDATE 带 manual_edited=true（重投影冻结标记）', async () => {
    const { client, calls } = makeClient(itemHandlers({ id: 'i-1', price: '10', qty: '2', note: null, manual_edited: false }));
    h.client = client;
    const r = await call('PUT', '/settlements/s-1/items/i-1', { price: 20 });
    expect(r.status).toBe(200);
    const upd = calls.find((c) => c.text.includes('UPDATE settlement_item SET price'))!;
    expect(upd.text).toContain('manual_edited = $5');
    expect(upd.params?.[4]).toBe(true);
  });

  it('② 只改 note → manual_edited 保持原值（修错别字不冻结数量口径；已冻结的也不解冻）', async () => {
    // 原 false → 仍 false
    const a = makeClient(itemHandlers({ id: 'i-1', price: '10', qty: '2', note: null, manual_edited: false }));
    h.client = a.client;
    await call('PUT', '/settlements/s-1/items/i-1', { note: '改备注' });
    expect(a.calls.find((c) => c.text.includes('UPDATE settlement_item SET price'))!.params?.[4]).toBe(false);
    // 原 true → 仍 true
    const b = makeClient(itemHandlers({ id: 'i-1', price: '10', qty: '2', note: null, manual_edited: true }));
    h.client = b.client;
    await call('PUT', '/settlements/s-1/items/i-1', { note: '改备注' });
    expect(b.calls.find((c) => c.text.includes('UPDATE settlement_item SET price'))!.params?.[4]).toBe(true);
  });

  it('⑤ 显式 manual_edited:false → 交还重投影（UPDATE 参数 false）；schema 不接受 true', async () => {
    const { client, calls } = makeClient(itemHandlers({ id: 'i-1', price: '10', qty: '2', note: null, manual_edited: true }));
    h.client = client;
    const r = await call('PUT', '/settlements/s-1/items/i-1', { manual_edited: false });
    expect(r.status).toBe(200);
    expect(calls.find((c) => c.text.includes('UPDATE settlement_item SET price'))!.params?.[4]).toBe(false);
    const bad = await call('PUT', '/settlements/s-1/items/i-1', { manual_edited: true });
    expect(bad.status).toBe(400); // zod z.literal(false)：冻结只能由真实 price/qty 修改触发
  });

  it('③ 重投影 UPSERT 带 WHERE NOT settlement_item.manual_edited + pruneStale 带 AND NOT si.manual_edited（修复点文本锚定）', async () => {
    const { client, calls } = makeClient([
      // syncMaterialCostRows 事实源聚合：1 行净消耗
      { match: (t: string) => t.includes('FROM inventory_log il'), reply: () => ({ rows: [{ work_order_id: 'wo-1', material_id: 'm-1', qty: '3', material_code: 'M1', material_name: '物料', material_price: '10' }], rowCount: 1 }) },
      { match: (t: string) => t.includes('INSERT INTO settlement_item'), reply: () => ({ rows: [], rowCount: 1 }) },
      { match: (t: string) => t.includes('DELETE FROM settlement_item si'), reply: () => ({ rows: [], rowCount: 0 }) },
      { match: (t: string) => t.includes('COALESCE(SUM(amount)'), reply: () => ({ rows: [{ total: '30', c: 1 }], rowCount: 1 }) },
      { match: (t: string) => t.includes('UPDATE settlement SET total'), reply: () => ({ rows: [], rowCount: 1 }) },
    ]);
    const r = await syncMaterialCostRows(client as never, T, 's-1', ['wo-1'], { pruneStale: true });
    expect(r.upserted).toBe(1);
    const upsert = calls.find((c) => c.text.includes('INSERT INTO settlement_item'))!;
    expect(upsert.text).toContain('WHERE NOT settlement_item.manual_edited');
    const del = calls.find((c) => c.text.includes('DELETE FROM settlement_item si'))!;
    expect(del.text).toContain('AND NOT si.manual_edited');
  });

  it('④ PG"不更新不报错"语义模拟：manual 行占位 → UPSERT rowCount=0 跳过，整体成功且表头照常以行上人工金额汇总', async () => {
    // 模拟 PG：被 manual_edited 行占位的 (工单,耗材) → DO UPDATE WHERE false → 该行不更新，rowCount 0
    let manualRowStillThere = true;
    const { client, calls } = makeClient([
      { match: (t: string) => t.includes('FROM inventory_log il'), reply: () => ({ rows: [{ work_order_id: 'wo-1', material_id: 'm-1', qty: '3', material_code: 'M1', material_name: '物料', material_price: '10' }], rowCount: 1 }) },
      { match: (t: string) => t.includes('INSERT INTO settlement_item'), reply: () => ({ rows: [], rowCount: manualRowStillThere ? 0 : 1 }) },
      { match: (t: string) => t.includes('DELETE FROM settlement_item si'), reply: () => ({ rows: [], rowCount: 0 }) },
      { match: (t: string) => t.includes('COALESCE(SUM(amount)'), reply: () => ({ rows: [{ total: '40', c: 1 }], rowCount: 1 }) }, // 人工金额 20×2=40 而非事实源 30
      { match: (t: string) => t.includes('UPDATE settlement SET total'), reply: () => { manualRowStillThere = false; return { rows: [], rowCount: 1 }; } },
    ]);
    // 修复前风险形态：UPSERT 无 WHERE → 人工行被覆盖（这里以 rowCount 语义 + 表头汇总锚定"跳过仍成功"）
    const r = await syncMaterialCostRows(client as never, T, 's-1', ['wo-1'], { pruneStale: true });
    expect(r.upserted).toBe(0); // 不更新、不报错：rowCount=0 被诚实计为 0 跳过
    expect(calls.find((c) => c.text.includes('UPDATE settlement SET total'))).toBeTruthy(); // recalcHeader 照常跑
  });
});

// ==================== D2 confirmed 单作废 ====================
describe('V3-D2 voided 作废路径', () => {
  const CONFIRMED_HDR = { id: 's-9', tenant_id: T, status: 'confirmed', settlement_no: 'ST202609140001', total: '100', item_count: 2, confirmed_by: 'boss', confirmed_at: '2026-09-14T01:00:00Z' };
  const ITEMS = [
    { id: 'i-a', source: 'service', price: '80', qty: '1', amount: '80' },
    { id: 'i-b', source: 'material', price: '10', qty: '2', amount: '20' },
  ];
  function voidHandlers(headerStatus: string) {
    return [
      ...BASE,
      { match: (t: string) => t.includes('FROM settlement WHERE id = $1 AND tenant_id = $2 FOR UPDATE'), reply: () => ({ rows: [{ ...CONFIRMED_HDR, status: headerStatus }], rowCount: 1 }) },
      { match: (t: string) => t.includes('SELECT * FROM settlement_item WHERE settlement_id = $1'), reply: () => ({ rows: ITEMS, rowCount: ITEMS.length }) },
      { match: (t: string) => t.includes('DELETE FROM settlement_item WHERE settlement_id'), reply: () => ({ rows: [], rowCount: ITEMS.length }) },
      { match: (t: string) => /UPDATE settlement\s+SET status/.test(t), reply: () => ({ rows: [{ ...CONFIRMED_HDR, status: 'voided' }], rowCount: 1 }) },
    ];
  }

  it('① void 成功：快照=作废前全部明细 → DELETE 明细 → 表头四列就位，total/confirmed 原样冻结', async () => {
    const { client, calls } = makeClient(voidHandlers('confirmed'));
    h.client = client;
    const r = await call('POST', '/settlements/s-9/void', { void_reason: '误确认，金额漏了外勤费' });
    expect(r.status).toBe(200);
    expect(r.body.settlement.status).toBe('voided');
    const upd = calls.find((c) => c.text.includes("SET status = 'voided'"))!;
    expect(upd.params?.[0]).toBe('admin'); // voided_by
    expect(upd.params?.[1]).toBe('误确认，金额漏了外勤费');
    const snapshot = JSON.parse(String(upd.params?.[2]));
    expect(snapshot).toHaveLength(2); // 快照 = 作废前全部明细
    expect(calls.find((c) => c.text.includes('DELETE FROM settlement_item WHERE settlement_id'))).toBeTruthy();
    // 快照先于 DELETE（作废前明细被完整保留）
    const snapIdx = calls.findIndex((c) => c.text.includes('SELECT * FROM settlement_item WHERE settlement_id'));
    const delIdx = calls.findIndex((c) => c.text.includes('DELETE FROM settlement_item WHERE settlement_id'));
    expect(snapIdx).toBeLessThan(delIdx);
    // 表头 UPDATE 不触碰 total/confirmed_*（冻结语义：SQL 文本只 SET 作废四列 + status）
    expect(upd.text).not.toContain('total =');
    expect(upd.text).not.toContain('confirmed_by =');
  });

  it('② 键位释放锚定：明细 DELETE 执行（uq_sti_service/uq_sti_material 部分唯一索引谓词只看 item 行，删行即释放；同工单重建 201 属真库负例，挂账部署窗口自证）', async () => {
    const { client, calls } = makeClient(voidHandlers('confirmed'));
    h.client = client;
    await call('POST', '/settlements/s-9/void', { void_reason: '作废后重建' });
    expect(calls.find((c) => c.text.includes('DELETE FROM settlement_item WHERE settlement_id'))).toBeTruthy();
  });

  it('④ draft 调 void → 409（草稿请走既有 DELETE）', async () => {
    const { client } = makeClient(voidHandlers('draft'));
    h.client = client;
    const r = await call('POST', '/settlements/s-9/void', { void_reason: 'x' });
    expect(r.status).toBe(409);
  });

  it('⑥ 重复 void（已 voided）→ 409', async () => {
    const { client } = makeClient(voidHandlers('voided'));
    h.client = client;
    const r = await call('POST', '/settlements/s-9/void', { void_reason: 'x' });
    expect(r.status).toBe(409);
  });

  it('⑤ void_reason 空串 → 400（zod min(1)）', async () => {
    const { client } = makeClient(voidHandlers('confirmed'));
    h.client = client;
    const r = await call('POST', '/settlements/s-9/void', { void_reason: '' });
    expect(r.status).toBe(400);
  });

  it('⑦ voided 单 export → 409 SETTLEMENT_VOIDED（导出凭证必须来自有效单）', async () => {
    const { client } = makeClient([
      ...BASE,
      { match: (t: string) => t.includes('FROM settlement WHERE id = $1 AND tenant_id = $2'), reply: () => ({ rows: [{ ...CONFIRMED_HDR, status: 'voided' }], rowCount: 1 }) },
      { match: (t: string) => t.includes('FROM settlement_item si'), reply: () => ({ rows: [], rowCount: 0 }) },
    ]);
    h.client = client;
    const r = await call('GET', '/settlements/s-9/export');
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('SETTLEMENT_VOIDED');
  });

  it('列表筛 voided 可见：LIST_STATUSES 含 voided（查询透传）', async () => {
    const { client, calls } = makeClient([
      ...BASE,
      { match: (t: string) => t.includes('COUNT(*)::int AS c FROM settlement'), reply: () => ({ rows: [{ c: 0 }], rowCount: 1 }) },
      { match: (t: string) => t.includes('SELECT * FROM settlement WHERE'), reply: () => ({ rows: [], rowCount: 0 }) },
    ]);
    h.client = client;
    const r = await call('GET', '/settlements?status=voided');
    expect(r.status).toBe(200);
    const listCall = calls.find((c) => c.text.includes('SELECT * FROM settlement WHERE'))!;
    expect(listCall.params).toContain('voided');
  });
});

// ==================== D3 退料回冲 ====================
describe('V3-D3 退料回冲（type=out 负 qty）', () => {
  function returnHandlers(over: { locked?: boolean; net?: string; draft?: boolean } = {}) {
    return [
      ...BASE,
      { match: (t: string) => t.includes('FROM material WHERE id=$1 AND tenant_id=$2'), reply: () => ({ rows: [{ id: 'm-1' }], rowCount: 1 }) },
      { match: (t: string) => t.includes('FROM work_orders WHERE tenant_id=$1 AND order_no=$2'), reply: () => ({ rows: [{ id: 'wo-1', order_no: 'WO_1' }], rowCount: 1 }) },
      { match: (t: string) => t.includes("s.status = 'confirmed'"), reply: () => ({ rows: over.locked ? [{ id: 's-l', settlement_no: 'ST-LOCK' }] : [], rowCount: over.locked ? 1 : 0 }) },
      { match: (t: string) => t.includes('AS net FROM inventory_log'), reply: () => ({ rows: [{ net: over.net ?? '5' }], rowCount: 1 }) },
      { match: (t: string) => t.includes('INSERT INTO inventory ('), reply: () => ({ rows: [{ qty: '7' }], rowCount: 1 }) },
      { match: (t: string) => t.includes('INSERT INTO inventory_log'), reply: () => ({ rows: [], rowCount: 1 }) },
      { match: (t: string) => t.includes("s.status = 'draft'"), reply: () => ({ rows: over.draft === false ? [] : [{ id: 's-1', settlement_no: 'ST1' }], rowCount: over.draft === false ? 0 : 1 }) },
      { match: (t: string) => t.includes('FROM inventory_log il'), reply: () => ({ rows: [{ work_order_id: 'wo-1', material_id: 'm-1', qty: '3', material_code: 'M1', material_name: '物料', material_price: '10' }], rowCount: 1 }) },
      { match: (t: string) => t.includes('INSERT INTO settlement_item'), reply: () => ({ rows: [], rowCount: 1 }) },
      { match: (t: string) => t.includes('DELETE FROM settlement_item si'), reply: () => ({ rows: [], rowCount: 0 }) },
      { match: (t: string) => t.includes('COALESCE(SUM(amount)'), reply: () => ({ rows: [{ total: '30', c: 1 }], rowCount: 1 }) },
      { match: (t: string) => t.includes('UPDATE settlement SET total'), reply: () => ({ rows: [], rowCount: 1 }) },
    ];
  }

  it('① 领 5 退 2 → 流水行 qty=-2 + draft 结算单重投影联动（qty=3 行刷新）', async () => {
    const { client, calls } = makeClient(returnHandlers({ net: '5' }));
    h.client = client;
    const r = await call('POST', '/inventory/return', { material_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', qty: 2, work_order_no: 'WO_1' });
    expect(r.status).toBe(200);
    const log = calls.find((c) => c.text.includes('INSERT INTO inventory_log'))!;
    expect(log.params?.[2]).toBe(-2); // 流水存负值：SUM(type='out') 唯一口径自动消化
    expect(log.params?.[6]).toBe('wo-1'); // 强制挂单（$7 = work_order_id；type 内联 'out' 共 7 参）
    expect(log.text).toContain("'out'");
    const ups = calls.find((c) => c.text.includes('INSERT INTO inventory ('))!;
    expect(ups.params?.[3]).toBe(2); // 库存回补 +2
    // draft 联动：重投影真实执行（事实源 5-2=3）
    expect(calls.find((c) => c.text.includes('INSERT INTO settlement_item'))).toBeTruthy();
  });

  it('② 领 5 退 5 → 净归零：重投影聚合空 + pruneStale 清残留行（人工行除外）', async () => {
    const { client, calls } = makeClient(returnHandlers({ net: '5' }));
    h.client = client;
    const r = await call('POST', '/inventory/return', { material_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', qty: 5, work_order_no: 'WO_1' });
    expect(r.status).toBe(200);
    expect(calls.find((c) => c.text.includes('INSERT INTO inventory_log'))!.params?.[2]).toBe(-5);
    const del = calls.find((c) => c.text.includes('DELETE FROM settlement_item si'));
    expect(del).toBeTruthy();
    expect(del!.text).toContain('AND NOT si.manual_edited');
  });

  it('③ 净消耗 2 再退 3 → 400（防凭空造退料把结算金额打成负数）', async () => {
    const { client, calls } = makeClient(returnHandlers({ net: '2' }));
    h.client = client;
    const r = await call('POST', '/inventory/return', { material_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', qty: 3, work_order_no: 'WO_1' });
    expect(r.status).toBe(400);
    expect(calls.find((c) => c.text.includes('INSERT INTO inventory_log'))).toBeUndefined(); // 零写库
  });

  it('④ confirmed 单挂单退料 → 422 SETTLEMENT_LOCKED（要退先作废，D2 闭环）', async () => {
    const { client, calls } = makeClient(returnHandlers({ locked: true }));
    h.client = client;
    const r = await call('POST', '/inventory/return', { material_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', qty: 1, work_order_no: 'WO_1' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('SETTLEMENT_LOCKED');
    expect(calls.find((c) => c.text.includes('INSERT INTO inventory_log'))).toBeUndefined();
  });

  it('⑤ 不带 work_order_no → 400（退料必须挂单）', async () => {
    const { client } = makeClient(returnHandlers());
    h.client = client;
    const r = await call('POST', '/inventory/return', { material_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', qty: 1 });
    expect(r.status).toBe(400);
  });

  it('⑥ 顺手项：/inventory/out 挂单出库补 SETTLEMENT_LOCKED 守卫（此前确认锁定可被挂单出库绕过）', async () => {
    const { client, calls } = makeClient([
      ...BASE,
      { match: (t: string) => t.includes('FROM material WHERE id=$1 AND tenant_id=$2'), reply: () => ({ rows: [{ id: 'm-1' }], rowCount: 1 }) },
      { match: (t: string) => t.includes('FROM work_orders WHERE tenant_id=$1 AND order_no=$2'), reply: () => ({ rows: [{ id: 'wo-1', order_no: 'WO_1' }], rowCount: 1 }) },
      { match: (t: string) => t.includes("s.status = 'confirmed'"), reply: () => ({ rows: [{ id: 's-l', settlement_no: 'ST-LOCK' }], rowCount: 1 }) },
    ]);
    h.client = client;
    const r = await call('POST', '/inventory/out', { material_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', qty: 1, work_order_no: 'WO_1' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('SETTLEMENT_LOCKED');
    expect(calls.find((c) => c.text.includes("UPDATE inventory SET qty"))).toBeUndefined(); // 库存分毫不动
  });

  it('⑦ 不挂单出库（woId=null）不触发守卫——存量无单出库路径零回归', async () => {
    const { client, calls } = makeClient([
      ...BASE,
      { match: (t: string) => t.includes('FROM material WHERE id=$1 AND tenant_id=$2'), reply: () => ({ rows: [{ id: 'm-1' }], rowCount: 1 }) },
      { match: (t: string) => t.includes('FROM inventory WHERE tenant_id=$1 AND material_id=$2 AND warehouse=$3 FOR UPDATE'), reply: () => ({ rows: [{ qty: '10' }], rowCount: 1 }) },
      { match: (t: string) => t.includes('UPDATE inventory SET qty'), reply: () => ({ rows: [], rowCount: 1 }) },
      { match: (t: string) => t.includes('INSERT INTO inventory_log'), reply: () => ({ rows: [], rowCount: 1 }) },
    ]);
    h.client = client;
    const r = await call('POST', '/inventory/out', { material_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', qty: 1 });
    expect(r.status).toBe(200);
    expect(calls.find((c) => c.text.includes("s.status = 'confirmed'"))).toBeUndefined();
  });
});
