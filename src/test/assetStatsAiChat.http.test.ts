// assetStatsAiChat.http.test.ts —— routes 层公网暴露面批次二（#932，承接 #931）。
// 覆盖三组路由：asset.ts（资产管理 12 端点：档案 CRUD/调拨/故障转单/历史/维保台账/CSV 导出导入）、
// stats.ts（报表大屏 4 端点：by-catalog/process/data-quality/overdue）、
// adminAiChat.ts（管理对话 1 端点：requireConfigRole + 双开关 503 降级）。
// 模式复用 upload.http.test.ts / publicReport.http.test.ts：vi.mock 重依赖，
// 真 handler + 真 errorMiddleware + 真 requireConfigRole（按注入角色测 403/放行）+ 真 csvUtil（RFC4180 真解析）。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ---- 可变夹具（beforeEach 归位）----
const TENANT = 't-demo';
let authRole = 'operator';
let detailRow: any = {
  id: 'a-1', tenant_id: TENANT, asset_no: 'ASSET-AAAA0001', name: '会议室空调', model: 'KF-120',
  location: '一号楼', status: 'in_use', linked_order_ids: ['w1'],
};
let detailFound = true;
let deleteCount = 1;
let lastTenant = '';

// ---- fakeClient：按 SQL 文本分发（细节分支优先于列表/导出）----
const fakeClient = {
  query: vi.fn(async (text: unknown, params?: unknown[]) => {
    const sql = String(text);
    if (sql.includes('SELECT * FROM asset WHERE id=$1 AND tenant_id=$2'))
      return detailFound ? { rows: [detailRow], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (sql.includes('SELECT linked_order_ids FROM asset WHERE id=$1'))
      return detailFound ? { rows: [{ linked_order_ids: detailRow.linked_order_ids }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (sql.includes('SELECT * FROM asset_maintenance WHERE id=$1 AND tenant_id=$2'))
      return detailFound ? { rows: [{ id: 'm-1' }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO asset ('))
      return { rows: [{ ...detailRow, id: 'a-new', asset_no: params?.[1], qr_code: params?.[9], status: params?.[6] }], rowCount: 1 };
    if (sql.includes('UPDATE asset SET') && !sql.includes('asset_maintenance'))
      return { rows: [detailRow], rowCount: 1 };
    if (sql.includes('INSERT INTO asset_maintenance')) return { rows: [{ id: 'm-1' }], rowCount: 1 };
    if (sql.includes('UPDATE asset_maintenance SET')) return { rows: [{ id: 'm-1' }], rowCount: 1 };
    if (sql.includes('DELETE FROM asset_maintenance')) return { rows: [], rowCount: deleteCount };
    if (sql.includes('SELECT * FROM asset_maintenance WHERE tenant_id=$1 AND asset_id=$2'))
      return { rows: [{ id: 'm-1' }], rowCount: 1 };
    if (sql.includes('FROM work_orders WHERE id = ANY'))
      return { rows: [{ id: 'w1', order_no: 'WO-1', business_type: 'repair', status: 'processing', created_at: 't' }], rowCount: 1 };
    if (sql.includes('FROM asset WHERE') && sql.includes('ORDER BY created_at DESC'))
      return { rows: [detailRow], rowCount: 1 };
    if (sql.includes('COUNT(*)::int AS overdue_total'))
      return { rows: [{ overdue_total: 3, earliest_due: '2026-09-05T10:00:00Z', avg_overdue_min: 42 }], rowCount: 1 };
    if (sql.includes('LEFT JOIN fault_category'))
      return { rows: [{ catalog: '空调', count: 2 }], rowCount: 1 };
    if (sql.includes('GROUP BY catalog ORDER BY count DESC'))
      return { rows: [{ catalog: '空调', count: 2 }], rowCount: 1 };
    return { rows: [], rowCount: 0 } as any;
  }) as any,
};
vi.mock('../db/pool.js', () => ({
  default: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  withTenantClient: async (tid: string, fn: (c: unknown) => unknown) => {
    lastTenant = tid;
    return fn(fakeClient);
  },
  assertSafeTenantId: (t: string) => t,
}));

// ---- asset.ts 依赖打桩（显式签名，避免 vi.fn 推断与调用参数不匹配）----
const createLinkedWorkOrder = vi.fn(async (_client: unknown, _opts: unknown): Promise<{ id: string; order_no: string; status: string }> => ({ id: 'wo-new', order_no: 'WO-NEW', status: 'draft' }));
vi.mock('../services/linkedWorkOrder.js', () => ({ createLinkedWorkOrder: (...a: unknown[]) => (createLinkedWorkOrder as any)(...a) }));
const summarizeLinkedOrders = vi.fn((rows: unknown[]): unknown[] => rows);
vi.mock('../services/assetHistory.js', () => ({ summarizeLinkedOrders: (rows: unknown[]) => (summarizeLinkedOrders as any)(rows) }));
const emitDomainEvent = vi.fn(async (..._a: unknown[]): Promise<null> => null);
vi.mock('../db/eventBus.js', () => ({ emitDomainEvent: (...a: unknown[]) => (emitDomainEvent as any)(...a) }));

// ---- stats.ts 依赖打桩 ----
const processMetrics = vi.fn(async (_c: unknown, tenantId: string): Promise<any> => ({ hit_rate: 0.8, tenant: tenantId }));
vi.mock('../repo/stats.js', () => ({ processMetrics: (...a: unknown[]) => (processMetrics as any)(...a) }));
const qualityReport = vi.fn(async (_c: unknown, _t: string): Promise<any> => ({ score: 1.0, note: '无数据' }));
vi.mock('../services/dataQuality.js', () => ({ qualityReport: (...a: unknown[]) => (qualityReport as any)(...a) }));
const getWorkflowDef = vi.fn(async (..._a: unknown[]): Promise<any> => ({ key: 'work_order', states: [] }));
vi.mock('../engine/workflowDef.js', () => ({ getWorkflowDef: (...a: unknown[]) => (getWorkflowDef as any)(...a) }));
const doneStates = vi.fn((): string[] => ['done', 'cancelled']);
vi.mock('../engine/stateMachine.js', () => ({ doneStates: () => (doneStates as any)() }));

// ---- adminAiChat.ts 依赖打桩 ----
const conversationAvailable = vi.fn(async (_t: string): Promise<{ ok: boolean; reason?: string }> => ({ ok: true }));
vi.mock('../services/conversationAgent.js', () => ({ conversationAvailable: (t: string) => (conversationAvailable as any)(t) }));
const runAdminTurn = vi.fn(async (_t: string, message: string): Promise<{ reply: string; confirm_card: any }> => ({ reply: `收到：${message}`, confirm_card: { kind: 'location', fields: [] } }));
vi.mock('../services/adminAgent.js', () => ({ runAdminTurn: (t: string, m: string) => (runAdminTurn as any)(t, m) }));

import assetRouter from '../routes/asset.js';
import statsRouter from '../routes/stats.js';
import adminAiChatRouter from '../routes/adminAiChat.js';
import { errorMiddleware } from '../middleware/error.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((_req, res, next) => {
  res.locals.auth = { tenantId: TENANT, role: authRole, userId: 'u-1', requestId: 'r-1', authMode: 'dev' };
  next();
});
app.use('/api/v1', assetRouter);
app.use('/api/v1', statsRouter);
app.use('/api/v1', adminAiChatRouter);
app.use(errorMiddleware);

let server: Server;
let base = '';
beforeAll(async () => {
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  authRole = 'operator';
  detailRow = { ...detailRow, linked_order_ids: ['w1'] };
  detailFound = true;
  deleteCount = 1;
  lastTenant = '';
  fakeClient.query.mockClear();
  emitDomainEvent.mockClear();
  createLinkedWorkOrder.mockClear();
  summarizeLinkedOrders.mockClear();
  processMetrics.mockClear();
  qualityReport.mockClear();
  getWorkflowDef.mockClear();
  doneStates.mockClear();
  conversationAvailable.mockClear();
  runAdminTurn.mockClear();
});
const req = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(base + p, { method, headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers, body: body !== undefined ? JSON.stringify(body) : undefined });
const calls = (): string[] => (fakeClient.query.mock.calls as unknown[][]).map((c) => String(c[0]));

describe('asset.ts · 资产档案（GET/POST/PUT + 过滤器）', () => {
  it('①GET /assets 无过滤 → 200 且租户参数居首（RLS 隔离）', async () => {
    const r = await req('GET', '/assets');
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.ok).toBe(true);
    expect(j.items[0].name).toBe('会议室空调');
    expect(lastTenant).toBe(TENANT);
    const [sql, params] = fakeClient.query.mock.calls[0];
    expect(String(sql)).toContain('FROM asset WHERE');
    expect((params as unknown[])[0]).toBe(TENANT);
  });

  it('②GET /assets?name&location → 动态拼接 ILIKE + 等值', async () => {
    const r = await req('GET', '/assets?name=' + encodeURIComponent('空调') + '&location=' + encodeURIComponent('一号楼'));
    expect(r.status).toBe(200);
    const [sql, params] = fakeClient.query.mock.calls[0];
    expect(String(sql)).toContain('name ILIKE');
    expect(String(sql)).toContain('location = $3');
    expect(params as unknown[]).toContain('%空调%');
  });

  it('③GET /assets?code=SN99 → 扫码三路 OR（asset_no/qr_code/sno，#565）', async () => {
    await req('GET', '/assets?code=SN99');
    const sql = calls()[0];
    expect(sql).toContain('asset_no ILIKE');
    expect(sql).toContain('OR qr_code =');
    expect(sql).toContain('OR sno =');
  });

  it('④POST /assets（operator）→ 201 + 自动资产编号 + 二维码内容 + 默认 in_use', async () => {
    const r = await req('POST', '/assets', { name: '新空调', model: 'KF-X' });
    expect(r.status).toBe(201);
    const j = (await r.json()) as any;
    expect(j.item.asset_no).toMatch(/^ASSET-[0-9A-F]{8}$/);
    expect(String(j.item.qr_code)).toMatch(/^ASSET:[0-9a-f-]{36}$/);
    expect(j.item.status).toBe('in_use');
    const params = fakeClient.query.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe(TENANT);
    expect(params[2]).toBe('新空调');
  });

  it('⑤POST /assets（worker）→ 403 FORBIDDEN（requireConfigRole 真守卫）', async () => {
    authRole = 'worker';
    const r = await req('POST', '/assets', { name: 'x' });
    expect(r.status).toBe(403);
    const j = (await r.json()) as any;
    expect(j.code).toBe('FORBIDDEN');
  });

  it('⑥POST /assets 缺 name → 422（zod）', async () => {
    const r = await req('POST', '/assets', { model: 'KF-X' });
    expect(r.status).toBe(422);
  });

  it('⑦PUT /assets/:id 改 status → 200 且 UPDATE 含新列', async () => {
    const r = await req('PUT', '/assets/a-1', { status: 'standby' });
    expect(r.status).toBe(200);
    expect(calls().some((s) => s.includes('UPDATE asset SET') && s.includes('status = $3'))).toBe(true);
  });

  it('⑧PUT /assets/:id 空体 → 200 返回现状且不产生 UPDATE（#789 幂等语义）', async () => {
    const r = await req('PUT', '/assets/a-1', {});
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.item.id).toBe('a-1');
    expect(calls().some((s) => s.includes('UPDATE asset SET'))).toBe(false);
  });

  it('⑨PUT /assets/:id 资产不存在 → 404 NOT_FOUND', async () => {
    detailFound = false;
    const r = await req('PUT', '/assets/none', { name: 'x' });
    expect(r.status).toBe(404);
    const j = (await r.json()) as any;
    expect(j.code).toBe('NOT_FOUND');
  });

  it('⑩POST /assets/:id/transfer → 200 + 调拨事件（P0 飞轮）', async () => {
    const r = await req('POST', '/assets/a-1/transfer', { location: '新仓库' });
    expect(r.status).toBe(200);
    expect(emitDomainEvent).toHaveBeenCalledTimes(1);
    const arg = (emitDomainEvent as ReturnType<typeof vi.fn>).mock.calls[0][1] as any;
    expect(arg.type).toBe('asset_transfer');
    expect(arg.entityType).toBe('asset');
    expect(arg.payload.to_location).toBe('新仓库');
  });

  it('⑪POST /assets/:id/fault → 转标准维修工单 + linked_order_ids 追加 + status=repairing + 故障事件', async () => {
    const r = await req('POST', '/assets/a-1/fault', { description: '不制冷' });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.result.order_no).toBe('WO-NEW');
    const arg = (createLinkedWorkOrder as ReturnType<typeof vi.fn>).mock.calls[0][1] as any;
    expect(arg.sourceType).toBe('asset');
    expect(arg.catalog).toBe('repair');
    expect(arg.title).toBe('资产故障报修·会议室空调'); // 未传 title 时用资产名兜底
    const updCall = fakeClient.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('UPDATE asset SET'));
    expect(updCall).toBeTruthy();
    expect((updCall![1] as unknown[])[2]).toEqual(['w1', 'wo-new']);
    const ev = (emitDomainEvent as ReturnType<typeof vi.fn>).mock.calls[0][1] as any;
    expect(ev.type).toBe('asset_fault');
    expect(ev.payload.work_order_id).toBe('wo-new');
  });

  it('⑫POST /assets/none/fault → 404', async () => {
    detailFound = false;
    const r = await req('POST', '/assets/none/fault', {});
    expect(r.status).toBe(404);
  });

  it('⑬GET /assets/:id/history → ANY($1) 反查 + summarize 聚合', async () => {
    const r = await req('GET', '/assets/a-1/history');
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.items[0].order_no).toBe('WO-1');
    expect(calls().some((s) => s.includes('WHERE id = ANY($1)'))).toBe(true);
    expect(summarizeLinkedOrders).toHaveBeenCalledTimes(1);
  });

  it('⑭GET /assets/:id/history 空 linked_order_ids → 短路 []（不打 work_orders）', async () => {
    detailRow = { ...detailRow, linked_order_ids: [] };
    const r = await req('GET', '/assets/a-1/history');
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.items).toEqual([]);
    expect(calls().some((s) => s.includes('work_orders'))).toBe(false);
  });

  it('⑮GET /assets/none/history → 404', async () => {
    detailFound = false;
    const r = await req('GET', '/assets/none/history');
    expect(r.status).toBe(404);
  });
});

describe('asset.ts · 维保台账 + CSV 导出/导入', () => {
  it('⑯maintenance POST → 201；PUT → 200；DELETE → ok；DELETE 0 行 → 404', async () => {
    const p = await req('POST', '/assets/a-1/maintenance', { type: '保养', cost: 120 });
    expect(p.status).toBe(201);
    const u = await req('PUT', '/assets/maintenance/m-1', { note: '已完成' });
    expect(u.status).toBe(200);
    expect(calls().some((s) => s.includes('UPDATE asset_maintenance SET'))).toBe(true);
    const d = await req('DELETE', '/assets/maintenance/m-1');
    expect(d.status).toBe(200);
    deleteCount = 0;
    const d2 = await req('DELETE', '/assets/maintenance/m-none');
    expect(d2.status).toBe(404);
  });

  it('⑰GET /assets/export（operator）→ CSV 带 BOM + 表头；（worker）→ 403（R9-F1）', async () => {
    const r = await req('GET', '/assets/export');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(r.headers.get('content-disposition')).toContain('attachment');
    // BOM 断言必须看原始字节：fetch().text() 的 UTF-8 解码默认剥 BOM（ignoreBOM:false），看 text 会假阴
    const buf = new Uint8Array(await (await req('GET', '/assets/export')).arrayBuffer());
    expect(buf[0]).toBe(0xef); expect(buf[1]).toBe(0xbb); expect(buf[2]).toBe(0xbf);
    expect(new TextDecoder('utf-8').decode(buf.slice(3)).startsWith('asset_no,name,model')).toBe(true);
    authRole = 'worker';
    const r2 = await req('GET', '/assets/export');
    expect(r2.status).toBe(403);
  });

  it('⑱POST /assets/import → 逐行建档 inserted=1（真 parseCsv）', async () => {
    const csv = 'name,model,location\n空调1,KF-1,一号楼\n';
    const r = await req('POST', '/assets/import', { csv });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.inserted).toBe(1);
    const ins = fakeClient.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('INSERT INTO asset ('));
    expect(ins).toBeTruthy();
    const params = ins![1] as unknown[];
    expect(params[1]).toBe(TENANT);
    expect(params[3]).toBe('空调1'); // cols: id, tenant_id, asset_no, name → index 3
  });

  it('⑲POST /assets/import 仅表头 → inserted=0；缺 csv → 400 BAD_INPUT', async () => {
    const r = await req('POST', '/assets/import', { csv: 'name,model\n' });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.inserted).toBe(0);
    const r2 = await req('POST', '/assets/import', { foo: 'bar' });
    expect(r2.status).toBe(400);
    const j2 = (await r2.json()) as any;
    expect(j2.code).toBe('BAD_INPUT');
  });
});

describe('stats.ts · 报表大屏 4 端点', () => {
  it('⑳GET /stats/by-catalog → 分类聚合透传', async () => {
    const r = await req('GET', '/stats/by-catalog');
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.items[0]).toEqual({ catalog: '空调', count: 2 });
    expect(lastTenant).toBe(TENANT);
  });

  it('㉑GET /stats/process → processMetrics(client, tenantId) 透传', async () => {
    const r = await req('GET', '/stats/process');
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.metrics.hit_rate).toBe(0.8);
    expect(j.metrics.tenant).toBe(TENANT);
    expect(processMetrics).toHaveBeenCalledTimes(1);
  });

  it('㉒GET /stats/data-quality → qualityReport 透传（诚实口径）', async () => {
    const r = await req('GET', '/stats/data-quality');
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.quality.score).toBe(1.0);
  });

  it('㉓GET /stats/overdue → 完成态拓扑派生进 SQL + 聚合返回', async () => {
    const r = await req('GET', '/stats/overdue');
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.overdue.overdue_total).toBe(3);
    expect(j.overdue.avg_overdue_min).toBe(42);
    expect(j.overdue.by_catalog[0].catalog).toBe('空调');
    expect(getWorkflowDef).toHaveBeenCalledTimes(1);
    expect(doneStates).toHaveBeenCalledTimes(1);
    const total = fakeClient.query.mock.calls.find((c: unknown[]) => String(c[0]).includes('overdue_total'));
    expect((total![1] as unknown[])[1]).toEqual(['done', 'cancelled']); // 完成态 exclusion 参数
  });

  it('㉔stats 依赖抛错 → 500（errorMiddleware 兜底）', async () => {
    processMetrics.mockImplementationOnce(async () => {
      throw new Error('drill');
    });
    const r = await req('GET', '/stats/process');
    expect(r.status).toBe(500);
  });
});

describe('adminAiChat.ts · 管理对话端点（建议卡，绝不写库）', () => {
  it('㉕worker → 403（仅 admin/operator）', async () => {
    authRole = 'worker';
    const r = await req('POST', '/admin/ai-chat', { message: '帮我把一号楼加进位置字典' });
    expect(r.status).toBe(403);
    const j = (await r.json()) as any;
    expect(j.code).toBe('FORBIDDEN');
  });

  it('㉖schema：空 message → 422；conversation_id 非 uuid → 422；超 1000 字 → 422', async () => {
    expect((await req('POST', '/admin/ai-chat', { message: '' })).status).toBe(422);
    expect((await req('POST', '/admin/ai-chat', { message: 'hi', conversation_id: 'not-uuid' })).status).toBe(422);
    expect((await req('POST', '/admin/ai-chat', { message: 'x'.repeat(1001) })).status).toBe(422);
  });

  it('㉗AI 双开关未开 → 503 诚实降级（code=reason 透传）', async () => {
    conversationAvailable.mockImplementationOnce(async () => ({ ok: false as const, reason: 'AI_DISABLED' }));
    const r = await req('POST', '/admin/ai-chat', { message: '加个位置' });
    expect(r.status).toBe(503);
    const j = (await r.json()) as any;
    expect(j.code).toBe('AI_DISABLED');
    expect(runAdminTurn).not.toHaveBeenCalled();
  });

  it('㉘happy（operator）→ conversation_id 透传 + runAdminTurn(tenantId, message) + 建议卡回包', async () => {
    const cid = '11111111-1111-4111-8111-111111111111';
    const r = await req('POST', '/admin/ai-chat', { message: '把一号楼加进位置字典', conversation_id: cid });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.conversation_id).toBe(cid); // 前端生成并回传续聊
    expect(j.reply).toBe('收到：把一号楼加进位置字典');
    expect(j.confirm_card.kind).toBe('location');
    expect(runAdminTurn).toHaveBeenCalledWith(TENANT, '把一号楼加进位置字典');
    // 本端点只产出建议卡绝不写库：无任何 INSERT/UPDATE 打到库
    expect(calls().every((s) => !/insert into|update /i.test(s))).toBe(true);
  });

  it('㉙未传 conversation_id → 服务端生成 uuid', async () => {
    const r = await req('POST', '/admin/ai-chat', { message: 'hi' });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.conversation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
