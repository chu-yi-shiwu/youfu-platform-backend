// materialPatrolFeedback.http.test.ts —— routes 层公网暴露面批次三（#933，承接 #931/#932）。
// 覆盖三组路由：material.ts（仓库物资 10 端点：档案 CRUD/库存/出入库/流水/CSV）、
// patrol.ts（二阶段巡更 9 端点：点位/任务/逐点签到/漏签 L2 预警飞轮）、
// feedback.ts（服务反馈 5 端点：提交/回复/统计/CSV 导出）。
// 模式复用 #931/#932：vi.mock 重依赖，真 handler + 真 errorMiddleware + 真 requireConfigRole
// + 真 csvUtil + 真 applyStockAction（库存计算诚实测，inventory.test.ts 已单测）。
// 挂载对齐 server.ts：material 直挂 /api/v1，patrol→/api/v1/patrol，feedback→/api/v1/feedback。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const TENANT = 't-demo';
let authRole = 'operator';
// material 夹具
let matFound = true;
let invExists = false;
let logExists = false;
let deleteCount = 1;
let lockQty = 10;
let lockFound = true;
let woFound = false;
const matRow = { id: 'm-1', tenant_id: TENANT, code: 'M-001', name: '滤芯', category: '耗材', unit: '个' };
// patrol 夹具
let pointExists = true;
let taskFound = true;
let taskRow: any = { id: 'pt-1', tenant_id: TENANT, title: '夜间巡更', status: 'pending', point_ids: ['p1', 'p2'], checkins: [] };
let missedRows: any[] = [];
let anomalyPts: any[] = [];
// feedback 夹具
let fbFound = true;
let lastTenant = '';

const fakeClient = {
  query: vi.fn(async (text: unknown, params?: unknown[]) => {
    const sql = String(text);
    // —— material ——（细节分支优先）
    if (sql.includes('SELECT 1 FROM inventory WHERE material_id')) return { rows: invExists ? [{ '?column?': 1 }] : [], rowCount: invExists ? 1 : 0 };
    if (sql.includes('SELECT 1 FROM inventory_log WHERE material_id')) return { rows: logExists ? [{ '?column?': 1 }] : [], rowCount: logExists ? 1 : 0 };
    if (sql.includes('SELECT id FROM material WHERE id=$1')) return matFound ? { rows: [{ id: 'm-1' }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (sql.includes('SELECT * FROM material WHERE id = $1')) return matFound ? { rows: [matRow], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO material (')) return { rows: [{ ...matRow, code: params?.[1], name: params?.[2] }], rowCount: 1 };
    if (sql.includes('UPDATE material SET')) return { rows: [matRow], rowCount: 1 };
    if (sql.includes('DELETE FROM material')) return { rows: [], rowCount: deleteCount };
    if (sql.includes('SELECT * FROM material WHERE')) return { rows: [matRow], rowCount: 1 };
    if (sql.includes('ON CONFLICT (tenant_id, material_id, warehouse)')) return { rows: [{ qty: 15 }], rowCount: 1 };
    if (sql.includes('FOR UPDATE')) return lockFound ? { rows: [{ qty: lockQty }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (sql.includes('UPDATE inventory SET qty=')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO inventory_log')) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM inventory_log WHERE')) return { rows: [{ id: 'l-1', type: 'out', qty: 2 }], rowCount: 1 };
    // —— patrol ——
    if (sql.includes("SELECT point_ids, checkins FROM patrol_task WHERE tenant_id=$1 AND status='missed'")) return { rows: missedRows, rowCount: missedRows.length };
    if (sql.includes('SELECT id, name FROM patrol_point WHERE tenant_id=$1 AND id = ANY')) return { rows: anomalyPts, rowCount: anomalyPts.length };
    if (sql.includes('SELECT * FROM patrol_task WHERE tenant_id=$1 AND id=$2')) return taskFound ? { rows: [taskRow], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO patrol_task')) return { rows: [{ ...taskRow, id: 'pt-new' }], rowCount: 1 };
    if (sql.includes('UPDATE patrol_task SET status')) return { rows: [taskRow], rowCount: 1 };
    if (sql.includes('SELECT * FROM patrol_task WHERE')) return { rows: [taskRow], rowCount: 1 };
    if (sql.includes('INSERT INTO patrol_point')) return { rows: [{ id: 'pp-1', name: params?.[2] }], rowCount: 1 };
    if (sql.includes('UPDATE patrol_point')) return { rows: [{ id: 'pp-1' }], rowCount: pointExists ? 1 : 0 };
    if (sql.includes('DELETE FROM patrol_point')) return { rows: [], rowCount: pointExists ? 1 : 0 };
    if (sql.includes('SELECT * FROM patrol_point WHERE')) return { rows: [{ id: 'pp-1', name: '东门' }], rowCount: 1 };
    // —— feedback ——
    if (sql.includes('SELECT * FROM feedback WHERE id = $1 AND tenant_id = $2')) return fbFound ? { rows: [{ id: 'fb-1', status: 'new' }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO feedback')) return { rows: [{ id: 'fb-1', status: 'new' }], rowCount: 1 };
    if (sql.includes('UPDATE feedback SET status')) return { rows: [{ id: 'fb-1', status: 'replied' }], rowCount: 1 };
    if (sql.includes('COUNT(*) FILTER')) return { rows: [{ satisfaction_count: 2, opinion_count: 3, new_count: 1, replied_count: 4, avg_rating: '4.5' }], rowCount: 1 };
    if (sql.includes('SELECT * FROM feedback WHERE tenant_id=$1 ORDER BY')) return { rows: [{ id: 'fb-1', type: 'opinion', content: '很满意' }], rowCount: 1 };
    if (sql.includes('FROM feedback WHERE')) return { rows: [{ id: 'fb-1' }], rowCount: 1 };
    // —— 共享：工单归因解析 ——
    if (sql.includes('SELECT id FROM work_orders WHERE tenant_id=$1 AND order_no=$2')) return woFound ? { rows: [{ id: 'wo-9' }], rowCount: 1 } : { rows: [], rowCount: 0 };
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
const emitDomainEvent = vi.fn(async (..._a: unknown[]): Promise<null> => null);
vi.mock('../db/eventBus.js', () => ({ emitDomainEvent: (...a: unknown[]) => (emitDomainEvent as any)(...a) }));
// patrol.ts 依赖 emergency.ts 的 createAlert（route 文件互相引用）——打桩掉，L2 预警断言走 mock
const createAlert = vi.fn(async (..._a: unknown[]): Promise<null> => null);
vi.mock('../routes/emergency.js', () => ({ createAlert: (...a: unknown[]) => (createAlert as any)(...a) }));

import materialRouter from '../routes/material.js';
import patrolRouter from '../routes/patrol.js';
import feedbackRouter from '../routes/feedback.js';
import { errorMiddleware } from '../middleware/error.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((_req, res, next) => {
  res.locals.auth = { tenantId: TENANT, role: authRole, userId: 'u-1', requestId: 'r-1', authMode: 'dev' };
  next();
});
app.use('/api/v1', materialRouter);
app.use('/api/v1/patrol', patrolRouter);
app.use('/api/v1/feedback', feedbackRouter);
app.use(errorMiddleware);

let server: Server;
let base = '';
beforeAll(async () => {
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  authRole = 'operator';
  matFound = true; invExists = false; logExists = false; deleteCount = 1; lockQty = 10; lockFound = true; woFound = false;
  pointExists = true; taskFound = true;
  taskRow = { id: 'pt-1', tenant_id: TENANT, title: '夜间巡更', status: 'pending', point_ids: ['p1', 'p2'], checkins: [] };
  missedRows = []; anomalyPts = [];
  fbFound = true; lastTenant = '';
  fakeClient.query.mockClear();
  emitDomainEvent.mockClear();
  createAlert.mockClear();
});
const req = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(base + p, { method, headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers, body: body !== undefined ? JSON.stringify(body) : undefined });
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const calls = (): string[] => (fakeClient.query.mock.calls as unknown[][]).map((c) => String(c[0]));
const callParams = (i: number): unknown[] => (fakeClient.query.mock.calls[i]?.[1] ?? []) as unknown[];
const evArg = (i = 0) => (emitDomainEvent as ReturnType<typeof vi.fn>).mock.calls[i]?.[1] as any;

describe('material.ts · 材料档案 CRUD', () => {
  it('①GET /materials → 租户参数居首 + 过滤器 ILIKE/等值拼接', async () => {
    let r = await req('GET', '/api/v1/materials');
    expect(r.status).toBe(200);
    const [sql, params] = fakeClient.query.mock.calls[0];
    expect(String(sql)).toContain('FROM material WHERE');
    expect((params as unknown[])[0]).toBe(TENANT);
    expect(lastTenant).toBe(TENANT);
    await req('GET', '/api/v1/materials?code=M-001&category=' + encodeURIComponent('耗材'));
    const sql2 = String(fakeClient.query.mock.calls[1][0]);
    expect(sql2).toContain('code ILIKE');
    expect(sql2).toContain('category = $3');
  });

  it('②POST /materials（operator）→ 201 默认 enabled=true/price=0；（worker）→ 403；缺 code → 422', async () => {
    const r = await req('POST', '/api/v1/materials', { code: 'M-002', name: '密封圈' });
    expect(r.status).toBe(201);
    const p = callParams(0);
    expect(p[0]).toBe(TENANT);
    expect(p[7]).toBe(true); // enabled 默认
    expect(p[6]).toBe(0); // price 默认
    authRole = 'worker';
    expect((await req('POST', '/api/v1/materials', { code: 'x', name: 'x' })).status).toBe(403);
    authRole = 'operator';
    expect((await req('POST', '/api/v1/materials', { name: '缺编码' })).status).toBe(422);
  });

  it('③PUT /materials/:id → 200 COALESCE 更新；不存在 → 404', async () => {
    const r = await req('PUT', '/api/v1/materials/m-1', { name: '滤芯Pro' });
    expect(r.status).toBe(200);
    expect(calls().some((s) => s.includes('UPDATE material SET'))).toBe(true);
    matFound = false;
    expect((await req('PUT', '/api/v1/materials/none', { name: 'x' })).status).toBe(404);
  });

  it('④DELETE /materials/:id 三重护栏：有台账 409 → 有流水 409 → 干净可删；0 行 → 404', async () => {
    invExists = true;
    let r = await req('DELETE', '/api/v1/materials/m-1');
    expect(r.status).toBe(409);
    let j = (await r.json()) as any;
    expect(j.code).toBe('CONFLICT');
    expect(j.message).toContain('库存台账');
    invExists = false; logExists = true;
    r = await req('DELETE', '/api/v1/materials/m-1');
    expect(r.status).toBe(409);
    j = (await r.json()) as any;
    expect(j.message).toContain('流水');
    logExists = false;
    expect((await req('DELETE', '/api/v1/materials/m-1')).status).toBe(200);
    deleteCount = 0;
    expect((await req('DELETE', '/api/v1/materials/m-1')).status).toBe(404);
  });
});

describe('material.ts · 库存与出入库（真 applyStockAction）', () => {
  it('⑤GET /inventory?low=1 → 低库存过滤 SQL（qty < min_qty）', async () => {
    const r = await req('GET', '/api/v1/inventory?low=1');
    expect(r.status).toBe(200);
    expect(calls()[0]).toContain('qty < min_qty');
  });

  it('⑥POST /inventory/in → 物料不存在 404；happy 走 ON CONFLICT 原子 upsert + 流水 type=in + 操作人', async () => {
    matFound = false;
    expect((await req('POST', '/api/v1/inventory/in', { material_id: '22222222-2222-4222-8222-222222222222', qty: 5 })).status).toBe(404);
    matFound = true;
    const r = await req('POST', '/api/v1/inventory/in', { material_id: '11111111-1111-4111-8111-111111111111', qty: 5, ref_no: 'PO-1' });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.result.qty).toBe(15);
    expect(calls().some((s) => s.includes('ON CONFLICT'))).toBe(true); // R23-001 并发首存修复
    const logIdx = calls().findIndex((s) => s.includes('INSERT INTO inventory_log'));
    expect(calls()[logIdx]).toContain("'in'");
    expect(callParams(logIdx)[5]).toBe('u-1'); // 占位符 $1..$6：'in' 是字面量
  });

  it('⑦POST /inventory/out happy → FOR UPDATE 行锁 + 真库存计算 + 流水 + material_consumed 事件挂工单', async () => {
    woFound = true;
    const r = await req('POST', '/api/v1/inventory/out', { material_id: '11111111-1111-4111-8111-111111111111', qty: 4, work_order_no: 'WO-9' });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.result.qty).toBe(6); // 10-4 真计算
    expect(calls().some((s) => s.includes('FOR UPDATE'))).toBe(true);
    const logIdx = calls().findIndex((s) => s.includes('INSERT INTO inventory_log'));
    expect(calls()[logIdx]).toContain("'out'");
    expect(callParams(logIdx)[6]).toBe('wo-9'); // 工单归因落流水（占位符 $1..$7）
    const ev = evArg();
    expect(ev.type).toBe('material_consumed');
    expect(ev.payload.work_order_id).toBe('wo-9');
    expect(ev.payload.qty).toBe(4);
  });

  it('⑧POST /inventory/out 库存不足 → 400；台账不存在 → 400', async () => {
    lockQty = 3;
    const r = await req('POST', '/api/v1/inventory/out', { material_id: '11111111-1111-4111-8111-111111111111', qty: 5 });
    expect(r.status).toBe(400);
    const j = (await r.json()) as any;
    expect(j.message).toContain('库存不足');
    lockQty = 10;
    lockFound = false; // FOR UPDATE 查空 → 台账不存在
    const r2 = await req('POST', '/api/v1/inventory/out', { material_id: '11111111-1111-4111-8111-111111111111', qty: 1 });
    expect(r2.status).toBe(400);
  });
});

describe('material.ts · 流水/CSV 导出导入', () => {
  it('⑨GET /inventory/logs?type=out → 类型过滤', async () => {
    const r = await req('GET', '/api/v1/inventory/logs?type=out');
    expect(r.status).toBe(200);
    expect(calls()[0]).toContain('type = $2');
  });

  it('⑩GET /materials/export → BOM+表头；（worker）→ 403；import 逐行建档', async () => {
    const r = await req('GET', '/api/v1/materials/export');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    const buf = new Uint8Array(await r.arrayBuffer());
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder('utf-8').decode(buf.slice(3)).startsWith('code,name,category')).toBe(true);
    authRole = 'worker';
    expect((await req('GET', '/api/v1/materials/export')).status).toBe(403);
    authRole = 'operator';
    const r2 = await req('POST', '/api/v1/materials/import', { csv: 'code,name\nM-A,胶带\n' });
    const j2 = (await r2.json()) as any;
    expect(j2.inserted).toBe(1);
    expect(calls().some((s) => s.includes('INSERT INTO material ('))).toBe(true);
  });
});

describe('patrol.ts · 巡更点位与任务', () => {
  it('⑪points：GET 列表 / POST 201+事件 / PUT 空体 400 / PUT 不存在 404 / DELETE ok+404', async () => {
    expect((await req('GET', '/api/v1/patrol/points')).status).toBe(200);
    const p = await req('POST', '/api/v1/patrol/points', { name: '东门', seq: 1 });
    expect(p.status).toBe(201);
    expect(evArg().type).toBe('create');
    expect(evArg().entityType).toBe('patrol_point');
    expect((await req('PUT', '/api/v1/patrol/points/pp-1', {})).status).toBe(400); // no fields to update
    pointExists = false;
    expect((await req('PUT', '/api/v1/patrol/points/none', { name: 'x' })).status).toBe(404);
    expect((await req('DELETE', '/api/v1/patrol/points/none')).status).toBe(404);
    pointExists = true;
    expect((await req('DELETE', '/api/v1/patrol/points/pp-1')).status).toBe(200);
  });

  it('⑫POST /tasks（operator）→ 201 point_ids 数组入库；GET /tasks 列表过滤；GET /tasks/:id 不存在 → 404', async () => {
    const r = await req('POST', '/api/v1/patrol/tasks', { title: '早班巡更', point_ids: ['11111111-1111-4111-8111-111111111111'] });
    expect(r.status).toBe(201);
    expect(callParams(0)[3]).toEqual(['11111111-1111-4111-8111-111111111111']);
    const gl = await req('GET', '/api/v1/patrol/tasks?assignee=u-1&status=pending');
    expect(gl.status).toBe(200);
    expect(calls()[1]).toContain('assignee = $2');
    expect(calls()[1]).toContain('status = $3');
    taskFound = false;
    expect((await req('GET', '/api/v1/patrol/tasks/none')).status).toBe(404);
  });

  it('⑬checkin 部分签 → in_progress + checkins JSON 追加 + checkin 事件；重复点 → 409', async () => {
    const r = await req('POST', '/api/v1/patrol/tasks/pt-1/checkin', { point_id: '11111111-1111-4111-8111-111111111111' });
    expect(r.status).toBe(200);
    const updIdx = calls().findIndex((s) => s.includes('UPDATE patrol_task SET status'));
    expect(calls()[updIdx]).toContain('$3'); // status 参数化
    expect(callParams(updIdx)[2]).toBe('in_progress');
    expect(String(callParams(updIdx)[3])).toContain('11111111');
    expect(evArg().type).toBe('checkin');
    taskRow = { ...taskRow, checkins: [{ point_id: '11111111-1111-4111-8111-111111111111' }] };
    const r2 = await req('POST', '/api/v1/patrol/tasks/pt-1/checkin', { point_id: '11111111-1111-4111-8111-111111111111' });
    expect(r2.status).toBe(409);
    const j2 = (await r2.json()) as any;
    expect(j2.message).toBe('point already checked');
  });

  it('⑭checkin 签满 → done + complete 事件；已终态 → 409；任务不存在 → 404', async () => {
    taskRow = { ...taskRow, point_ids: [U1], checkins: [] };
    const r = await req('POST', '/api/v1/patrol/tasks/pt-1/checkin', { point_id: U1 });
    const updIdx = calls().findIndex((s) => s.includes('UPDATE patrol_task SET status'));
    expect(callParams(updIdx)[2]).toBe('done');
    expect(evArg().type).toBe('complete');
    taskRow = { ...taskRow, status: 'done' };
    expect((await req('POST', '/api/v1/patrol/tasks/pt-1/checkin', { point_id: U2 })).status).toBe(409);
    taskFound = false;
    expect((await req('POST', '/api/v1/patrol/tasks/none/checkin', { point_id: U1 })).status).toBe(404);
  });

  it('⑮miss → status=missed + note + miss 事件', async () => {
    const r = await req('POST', '/api/v1/patrol/tasks/pt-1/miss', { note: '大雨中断' });
    expect(r.status).toBe(200);
    const updIdx = calls().findIndex((s) => s.includes("status='missed'"));
    expect(callParams(updIdx)[2]).toBe('大雨中断');
    expect(evArg().type).toBe('miss');
    expect(createAlert).not.toHaveBeenCalled(); // 无漏签历史 → 不预警
  });

  it('⑯miss 连续漏签飞轮：同点 ≥2 次 → createAlert L2；检测器抛错不阻断主流程', async () => {
    missedRows = [
      { point_ids: ['p1', 'p9'], checkins: [] },
      { point_ids: ['p1'], checkins: [] },
    ];
    anomalyPts = [{ id: 'p1', name: '东门' }];
    const r = await req('POST', '/api/v1/patrol/tasks/pt-1/miss', {});
    expect(r.status).toBe(200);
    expect(createAlert).toHaveBeenCalledTimes(1);
    const arg = (createAlert as ReturnType<typeof vi.fn>).mock.calls[0][2] as any;
    expect(arg.level).toBe('L2');
    expect(arg.title).toContain('东门');
    createAlert.mockImplementation(async () => { throw new Error('drill'); });
    const r2 = await req('POST', '/api/v1/patrol/tasks/pt-1/miss', {});
    expect(r2.status).toBe(200); // P2 飞轮异常不阻断 miss 主流程
    createAlert.mockImplementation(async (..._a: unknown[]) => null);
  });
});

describe('feedback.ts · 反馈提交/回复/统计', () => {
  it('⑰GET / → type/status 过滤', async () => {
    const r = await req('GET', '/api/v1/feedback?type=satisfaction&status=new');
    expect(r.status).toBe(200);
    expect(calls()[0]).toContain('type = $2');
    expect(calls()[0]).toContain('status = $3');
  });

  it('⑱POST / → 201 status=new + images 序列化 + submit 事件；工单归因命中落 work_order_id', async () => {
    woFound = true;
    const r = await req('POST', '/api/v1/feedback', { type: 'satisfaction', content: '很满意', rating: 5, images: ['a.png'], work_order_no: 'WO-9' });
    expect(r.status).toBe(201);
    const j = (await r.json()) as any;
    expect(j.item.status).toBe('new');
    const insIdx = calls().findIndex((s) => s.includes('INSERT INTO feedback'));
    expect(callParams(insIdx)[4]).toBe(JSON.stringify(['a.png']));
    expect(callParams(insIdx)[7]).toBe('wo-9'); // P1 归因桥接（8 参数末位）
    expect(evArg().type).toBe('submit');
    expect(evArg().payload.rating).toBe(5);
  });

  it('⑲POST /:id/reply → status=replied；（worker）→ 403；不存在 → 404', async () => {
    const r = await req('POST', '/api/v1/feedback/fb-1/reply', { reply: '已处理' });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.item.status).toBe('replied');
    expect(evArg().type).toBe('reply');
    authRole = 'worker';
    expect((await req('POST', '/api/v1/feedback/fb-1/reply', { reply: 'x' })).status).toBe(403);
    authRole = 'operator';
    fbFound = false;
    expect((await req('POST', '/api/v1/feedback/none/reply', { reply: 'x' })).status).toBe(404);
  });

  it('⑳GET /stats → 满意度聚合透传（诚实口径：数从库来）', async () => {
    const r = await req('GET', '/api/v1/feedback/stats');
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.stats.avg_rating).toBe('4.5');
    expect(j.stats.replied_count).toBe(4);
  });

  it('㉑GET /feedback/export → BOM+表头；（worker）→ 403', async () => {
    const r = await req('GET', '/api/v1/feedback/export');
    expect(r.status).toBe(200);
    const buf = new Uint8Array(await r.arrayBuffer());
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder('utf-8').decode(buf.slice(3)).startsWith('created_at,type,content')).toBe(true);
    authRole = 'worker';
    expect((await req('GET', '/api/v1/feedback/export')).status).toBe(403);
  });
});
