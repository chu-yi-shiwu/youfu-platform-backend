// inspection.http.test.ts —— routes 层公网暴露面批次四（#934，承接 #931/#932/#933）。
// 覆盖 inspection.ts（978 行 24 端点）：点位/检查项/巡检单 CRUD、checkin/complete/exception/
// transition/convert 流转引擎（真 stateMachine + INSPECTION_DEF 拓扑）、归属守卫（#583）、
// 周期计划（G3）/runDuePlansForTenant catch-up、统计、CSV 导出（R9-F1/R30-F7/R5-001）。
// 模式复用 #931-#933：vi.mock 重依赖，真 handler + 真 errorMiddleware + 真 requireConfigRole
// + 真 stateMachine 引擎 + 真 csvEscape + 真 haversine；归属守卫走真实 worker 反查路径。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const TENANT = 't-demo';
let authRole = 'operator';
let authMode: 'dev' | 'prod' = 'dev';
// —— 夹具（beforeEach 归位）——
let taskFound = true;
let taskRow: any = { id: 'it-1', tenant_id: TENANT, title: '配电房日检', status: 'pending', assignee: 'w-9', point_id: '11111111-1111-4111-8111-111111111111', items_json: [], note: null, plan_id: null };
let updatedRow: any = { ...taskRow, status: 'in_progress' };
let pointFound = true;
let itemFound = true;
let planFound = true;
let pointCoordRows: any[] = [{ lat: 30.0, lng: 110.0 }];
let workerRows: any[] = [];
let permRows: any[] = [];
let snapshotRows: any[] = [{ id: 'u1', name: '温度', type: 'number', standard_value: '5', unit: '℃', category: '环境' }];
let recordsRows: any[] = [];
let snapItems: any[] = [];
let duePlans: any[] = [];

const fakeClient = {
  query: vi.fn(async (text: unknown, params?: unknown[]) => {
    const sql = String(text);
    // —— 检查项 inspection_item ——
    if (sql.includes('FROM inspection_item') && sql.includes('id = ANY')) return { rows: snapshotRows, rowCount: snapshotRows.length };
    if (sql.includes('FROM inspection_item WHERE tenant_id = $1 ORDER BY')) return { rows: [{ id: 'u1', name: '温度', type: 'number' }], rowCount: 1 };
    if (sql.includes('SELECT * FROM inspection_item WHERE id')) return itemFound ? { rows: [{ id: 'u1', name: '温度', type: 'number' }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO inspection_item')) return { rows: [{ id: 'u1', name: params?.[2], device_type: params?.[6], trigger_mode: params?.[8] }], rowCount: 1 };
    if (sql.includes('UPDATE inspection_item SET')) return { rows: [{ id: 'u1' }], rowCount: 1 };
    if (sql.includes('DELETE FROM inspection_item')) return { rows: [], rowCount: itemFound ? 1 : 0 };
    // —— 点位 inspection_point ——
    if (sql.includes('SELECT id, name, code, lng, lat, asset_id, created_at FROM inspection_point')) return { rows: [{ id: 'ip-1', name: '东门' }], rowCount: 1 };
    if (sql.includes('SELECT lat, lng FROM inspection_point')) return { rows: pointCoordRows, rowCount: pointCoordRows.length };
    if (sql.includes('SELECT * FROM inspection_point WHERE id')) return pointFound ? { rows: [{ id: 'ip-1', name: '东门', lng: 110.0, lat: 30.0 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO inspection_point')) return { rows: [{ id: 'ip-1', name: params?.[2] }], rowCount: 1 };
    if (sql.includes('UPDATE inspection_point SET')) return { rows: [{ id: 'ip-1' }], rowCount: 1 };
    if (sql.includes('DELETE FROM inspection_point')) return { rows: [], rowCount: pointFound ? 1 : 0 };
    // —— 权限/归属（真实守卫路径）——
    if (sql.includes('SELECT perm FROM role_permission')) return { rows: permRows, rowCount: permRows.length };
    if (sql.includes('SELECT id FROM worker WHERE')) return { rows: workerRows, rowCount: workerRows.length };
    // —— 巡检单 inspection_task ——（细节分支优先）
    if (sql.includes('SELECT assignee, point_id FROM inspection_task') || sql.includes('SELECT assignee FROM inspection_task') || sql.includes('SELECT id, assignee FROM inspection_task'))
      return taskFound ? { rows: [{ assignee: taskRow.assignee, point_id: taskRow.point_id }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (sql.includes('WHERE t.id = $1 AND t.tenant_id = $2')) return taskFound ? { rows: [taskRow], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (sql.includes('SELECT * FROM inspection_task WHERE id = $1 AND tenant_id = $2')) return taskFound ? { rows: [taskRow], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (sql.includes('DATE(COALESCE(scheduled_at, created_at)) = CURRENT_DATE')) return { rows: [{ c: 1 }], rowCount: 1 };
    if (sql.includes('GROUP BY p.name ORDER BY c DESC LIMIT 5')) return { rows: [{ point_name: '东门', c: 2 }], rowCount: 1 };
    if (sql.includes('FROM inspection_task t LEFT JOIN inspection_point p')) return { rows: [taskRow], rowCount: 1 };
    if (sql.includes('INSERT INTO inspection_task')) return { rows: [{ id: 'it-new', status: 'pending', title: params?.[4] ?? taskRow.title }], rowCount: 1 };
    if (sql.includes('SET scan_meta')) return { rows: [], rowCount: 1 };
    if (sql.includes('SET items_json=$2')) return { rows: [], rowCount: 1 };
    if (sql.includes('SET linked_wo_id')) return { rows: [], rowCount: 1 };
    if (sql.includes('UPDATE inspection_task SET')) return { rows: [updatedRow], rowCount: 1 };
    // —— 实测记录 inspection_record ——
    if (sql.includes('INSERT INTO inspection_record')) return { rows: [], rowCount: 1 };
    if (sql.includes('COUNT(*) FILTER')) return { rows: [{ total_items: 0, passed: 0, failed: 0 }], rowCount: 1 };
    if (sql.includes('FROM inspection_record WHERE')) return { rows: recordsRows, rowCount: recordsRows.length };
    if (sql.includes('SELECT items_json, tenant_id FROM inspection_task')) return { rows: [{ items_json: snapItems }], rowCount: 1 };
    // —— 周期计划 inspection_plan ——
    if (sql.includes('paused=false AND next_run_at IS NOT NULL')) return { rows: duePlans, rowCount: duePlans.length };
    if (sql.includes('FROM inspection_plan WHERE tenant_id=$1 ORDER BY')) return { rows: [{ id: 'pl-1', name: '日常' }], rowCount: 1 };
    if (sql.includes('SELECT * FROM inspection_plan WHERE id=$1 AND tenant_id=$2')) return planFound ? { rows: [{ id: 'pl-1', name: '日常', point_ids: [U1, U2], frequency: 'weekly', interval_n: 1, paused: false, next_run_at: new Date().toISOString(), item_ids: [] }], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO inspection_plan')) return { rows: [], rowCount: 1 };
    if (sql.includes('UPDATE inspection_plan SET')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 } as any;
  }) as any,
};
vi.mock('../db/pool.js', () => ({
  default: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  withTenantClient: async (tid: string, fn: (c: unknown) => unknown) => fn(fakeClient),
  assertSafeTenantId: (t: string) => t,
}));
const emitDomainEvent = vi.fn(async (..._a: unknown[]): Promise<null> => null);
vi.mock('../db/eventBus.js', () => ({ emitDomainEvent: (...a: unknown[]) => (emitDomainEvent as any)(...a) }));
const createLinkedWorkOrder = vi.fn(async (..._a: unknown[]) => ({ id: 'wo-l1', order_no: 'WO-L1', status: 'draft' }));
vi.mock('../services/linkedWorkOrder.js', () => ({ createLinkedWorkOrder: (...a: unknown[]) => (createLinkedWorkOrder as any)(...a) }));
// workflow_def 查询打桩 → 回 INSPECTION_DEF 同款拓扑（stateMachine 真引擎消费）
vi.mock('../engine/workflowDef.js', () => ({
  getWorkflowDefOrDefault: async () => ({
    initial: 'pending',
    states: ['pending', 'in_progress', 'done', 'exception', 'cancelled'],
    transitions: [
      { from: 'pending', to: 'in_progress', event: 'checkin', allowedRoles: ['admin', 'operator', 'worker'] },
      { from: 'in_progress', to: 'done', event: 'complete', allowedRoles: ['admin', 'operator', 'worker'] },
      { from: 'in_progress', to: 'exception', event: 'exception', requiredFields: ['note'] },
      { from: 'pending', to: 'cancelled', event: 'cancel', allowedRoles: ['admin', 'operator'] },
      { from: 'in_progress', to: 'cancelled', event: 'cancel', allowedRoles: ['admin', 'operator'] },
    ],
    config: { doneStates: ['done'], learningTriggers: ['done'] },
  }),
}));
const createAlert = vi.fn(async (..._a: unknown[]): Promise<null> => null);
vi.mock('../routes/emergency.js', () => ({ createAlert: (...a: unknown[]) => (createAlert as any)(...a) }));

import inspectionRouter, { runDuePlansForTenant } from '../routes/inspection.js';
import { errorMiddleware } from '../middleware/error.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((_req, res, next) => {
  res.locals.auth = { tenantId: TENANT, role: authRole, userId: 'acct-1', requestId: 'r-1', authMode };
  next();
});
app.use('/api/v1/inspection', inspectionRouter);
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
  authMode = 'dev';
  taskFound = true; pointFound = true; itemFound = true; planFound = true;
  taskRow = { id: 'it-1', tenant_id: TENANT, title: '配电房日检', status: 'pending', assignee: 'w-9', point_id: '11111111-1111-4111-8111-111111111111', items_json: [], note: null, plan_id: null };
  updatedRow = { ...taskRow, status: 'in_progress' };
  pointCoordRows = [{ lat: 30.0, lng: 110.0 }];
  workerRows = []; permRows = [];
  snapshotRows = [{ id: 'u1', name: '温度', type: 'number', standard_value: '5', unit: '℃', category: '环境' }];
  recordsRows = []; snapItems = []; duePlans = [];
  fakeClient.query.mockClear();
  emitDomainEvent.mockClear();
  createLinkedWorkOrder.mockClear();
  createAlert.mockClear();
});
const req = (method: string, p: string, body?: unknown) =>
  fetch(base + p, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const calls = (): string[] => (fakeClient.query.mock.calls as unknown[][]).map((c) => String(c[0]));
const callParams = (i: number): unknown[] => (fakeClient.query.mock.calls[i]?.[1] ?? []) as unknown[];
const evArg = (i = 0) => (emitDomainEvent as ReturnType<typeof vi.fn>).mock.calls[i]?.[1] as any;

describe('inspection.ts · 点位与检查项', () => {
  it('①GET /points → 租户参数居首；②POST /points（operator）201+事件；（worker）403', async () => {
    let r = await req('GET', '/api/v1/inspection/points');
    expect(r.status).toBe(200);
    expect(callParams(0)[0]).toBe(TENANT);
    authRole = 'worker';
    expect((await req('POST', '/api/v1/inspection/points', { name: '锅炉房' })).status).toBe(403);
    authRole = 'operator';
    r = await req('POST', '/api/v1/inspection/points', { name: '锅炉房', lng: 110.1, lat: 30.1 });
    expect(r.status).toBe(201);
    const ev = evArg();
    expect(ev.entityType).toBe('inspection_point');
    expect(ev.type).toBe('create');
  });

  it('③PUT /points/:id 合并更新（body 缺省沿用现值）+404；④DELETE 无行 → 404', async () => {
    const r = await req('PUT', `/api/v1/inspection/points/ip-1`, { name: '东门（改造）' });
    expect(r.status).toBe(200);
    const updIdx = calls().findIndex((s) => s.includes('UPDATE inspection_point SET'));
    expect(callParams(updIdx)[2]).toBe('东门（改造）');
    expect(callParams(updIdx)[5]).toBe(30.0); // lat 现值回填（UPDATE 参数 $6 位）
    pointFound = false;
    expect((await req('PUT', '/api/v1/inspection/points/none', { name: 'x' })).status).toBe(404);
    expect((await req('DELETE', '/api/v1/inspection/points/none')).status).toBe(404);
  });

  it('⑤POST /items → 201 设备字段默认（device_type=none/trigger_mode=manual）；PUT 不存在 → 404', async () => {
    const r = await req('POST', '/api/v1/inspection/items', { name: '皮带张力', type: 'bool' });
    expect(r.status).toBe(201);
    const j5 = (await r.json()) as any;
    expect(j5.item.device_type).toBe('none');
    expect(j5.item.trigger_mode).toBe('manual');
    itemFound = false;
    expect((await req('PUT', '/api/v1/inspection/items/none', { name: 'x' })).status).toBe(404);
  });

  it('⑥DELETE /items 干净删除；GET /items 列表租户参数', async () => {
    expect((await req('DELETE', '/api/v1/inspection/items/u1')).status).toBe(200);
    itemFound = false;
    expect((await req('DELETE', '/api/v1/inspection/items/u1')).status).toBe(404);
    const r = await req('GET', '/api/v1/inspection/items');
    expect(r.status).toBe(200);
    expect(callParams(calls().length - 1)[0]).toBe(TENANT);
  });
});

describe('inspection.ts · 巡检单 CRUD 与列表', () => {
  it('⑦GET /tasks 过滤器拼接：status/assignee/scheduled_from → 子句与参数位序', async () => {
    await req('GET', '/api/v1/inspection/tasks?status=pending&assignee=w-9&scheduled_from=2026-09-01');
    const [sql, params] = fakeClient.query.mock.calls[0];
    const s = String(sql);
    expect(s).toContain('t.tenant_id = $1');
    expect(s).toContain('status = $2');
    expect(s).toContain('assignee = $3');
    expect(s).toContain('scheduled_at >= $4');
    expect(params).toEqual([TENANT, 'pending', 'w-9', '2026-09-01']);
  });

  it('⑧GET /tasks/:id 详情：available 由引擎拓扑派生（pending → checkin/cancel，无 complete）+ records 叠加快照', async () => {
    taskRow.items_json = [{ item_id: 'u1', name: '温度', type: 'number', standard_value: '5', unit: '℃', category: '环境', actual_value: null, passed: null, photo: null, remark: null }];
    recordsRows = [{ item_id: 'u1', actual_value: '7.2', passed: false, photo: 'p-1', remark: '偏高' }];
    const r = await req('GET', '/api/v1/inspection/tasks/it-1');
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    const evts = j.item.available.map((t: any) => t.event).sort();
    expect(evts).toEqual(['cancel', 'checkin']);
    expect(j.item.items[0].actual_value).toBe('7.2');
    expect(j.item.items[0].passed).toBe(false);
  });

  it('⑨POST /tasks 带 item_ids → 检查项快照 seed 进 items_json（ANY 查询落库）', async () => {
    const r = await req('POST', '/api/v1/inspection/tasks', { title: '周检', point_id: U1, item_ids: [U2] });
    expect(r.status).toBe(201);
    const anyIdx = calls().findIndex((s) => s.includes('id = ANY'));
    expect(anyIdx).toBeGreaterThan(-1);
    expect(callParams(anyIdx)[1]).toEqual([U2]);
    const insIdx = calls().findIndex((s) => s.includes('INSERT INTO inspection_task'));
    expect(String(JSON.parse(String(callParams(insIdx)[6]))[0].name)).toBe('温度');
  });

  it('⑩POST /tasks（worker）→ 403（requireConfigRole 真 403）', async () => {
    authRole = 'worker';
    expect((await req('POST', '/api/v1/inspection/tasks', { title: 'x' })).status).toBe(403);
  });
});

describe('inspection.ts · 流转引擎（checkin/complete/exception/transition/convert）', () => {
  it('⑪checkin：pending→in_progress + 500m 防伪 L1（>500m → geo_suspect 落 scan_meta）+ scan_tag 回显', async () => {
    // 点位基准 (30.0,110.0)，签到偏移 0.02° 纬度 ≈ 2.2km
    const r = await req('POST', '/api/v1/inspection/tasks/it-1/checkin', { geo_lat: 30.02, geo_lng: 110.0, note: '到位', scan_tag: 'QR-001' });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.item.status).toBe('in_progress');
    expect(j.scan_tag).toBe('QR-001');
    const metaIdx = calls().findIndex((s) => s.includes('SET scan_meta'));
    expect(metaIdx).toBeGreaterThan(-1);
    const meta = JSON.parse(String(callParams(metaIdx)[0]));
    expect(meta.geo_suspect).toBe(true);
    expect(meta.geo_distance_m).toBeGreaterThan(500);
    expect(evArg().type).toBe('checkin');
  });

  it('⑫checkin worker：归属不符 → 403（真实 worker 反查路径）；归属本人 → 放行', async () => {
    authRole = 'worker';
    authMode = 'prod'; // 非 dev 即走真实守卫路径
    permRows = [{ perm: 'inspect.execute' }];
    workerRows = [{ id: 'w-1' }]; // acct-1 → w-1 ≠ owner w-9
    expect((await req('POST', '/api/v1/inspection/tasks/it-1/checkin', {})).status).toBe(403);
    workerRows = [{ id: 'w-9' }]; // 反查命中本人
    const r = await req('POST', '/api/v1/inspection/tasks/it-1/checkin', {});
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).item.status).toBe('in_progress');
  });

  it('⑬complete 于 pending → 422 BAD_STATE（引擎拒绝，不是硬编码 400）', async () => {
    const r = await req('POST', '/api/v1/inspection/tasks/it-1/complete', { note: '提前完成' });
    expect(r.status).toBe(422);
    expect(((await r.json()) as any).code).toBe('BAD_STATE');
  });

  it('⑭complete 于 in_progress → done；done_at=now() 字面量分支；records upsert + items_json 回填', async () => {
    taskRow.status = 'in_progress';
    updatedRow = { ...taskRow, status: 'done' };
    snapItems = [{ item_id: U1, name: '温度', actual_value: null, passed: null, photo: null, remark: null }]; // 与记录同 id 才能合并
    const r = await req('POST', '/api/v1/inspection/tasks/it-1/complete', {
      note: '完成',
      records: [{ item_id: U1, actual_value: '5.1', passed: true }],
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).item.status).toBe('done');
    const updIdx = calls().findIndex((s) => s.includes('RETURNING *') && s.includes('UPDATE inspection_task SET'));
    expect(calls()[updIdx]).toContain('done_at = now()');
    expect(callParams(updIdx)[3]).toBe('完成'); // note 走参数位（now() 之外的字段白名单参数化）
    const upIdx = calls().findIndex((s) => s.includes('INSERT INTO inspection_record'));
    expect(upIdx).toBeGreaterThan(-1);
    expect(callParams(upIdx)[2]).toBe(U1);
    const backIdx = calls().findIndex((s) => s.includes('SET items_json=$2'));
    const backfill = JSON.parse(String(callParams(backIdx)[1]));
    expect(backfill[0].actual_value).toBe('5.1');
    expect(backfill[0].passed).toBe(true);
  });

  it('⑮exception：→ exception 态 + L1 预警飞轮（createAlert source=inspection）', async () => {
    taskRow.status = 'in_progress';
    updatedRow = { ...taskRow, status: 'exception', title: '配电房日检' };
    const r = await req('POST', '/api/v1/inspection/tasks/it-1/exception', { note: '异响' });
    expect(r.status).toBe(200);
    const alert = (createAlert as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as any;
    expect(alert.source_type).toBe('inspection');
    expect(alert.level).toBe('L1');
    expect(alert.title).toContain('配电房日检');
  });

  it('⑯transition：缺 event → 400；白名单外列被丢弃（防列名注入）；cancel 合法流转', async () => {
    expect((await req('POST', '/api/v1/inspection/tasks/it-1/transition', { note: 'x' })).status).toBe(400);
    const r = await req('POST', '/api/v1/inspection/tasks/it-1/transition', { event: 'cancel', note: '取消', evil_col: 'DROP TABLE' });
    expect(r.status).toBe(200);
    const updIdx = calls().findIndex((s) => s.includes('UPDATE inspection_task SET'));
    expect(calls()[updIdx]).not.toContain('evil_col');
    expect(callParams(updIdx)[2]).toBe('cancelled');
  });

  it('⑰convert：非 exception 态 → 409；exception 态 → 转标准维修工单 + linked_wo_id + convert 事件', async () => {
    expect((await req('POST', '/api/v1/inspection/tasks/it-1/convert')).status).toBe(409);
    taskRow.status = 'exception';
    taskRow.note = '皮带断裂';
    const r = await req('POST', '/api/v1/inspection/tasks/it-1/convert');
    expect(r.status).toBe(200);
    const arg = (createLinkedWorkOrder as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as any;
    expect(arg.businessType).toBe('inspection');
    expect(arg.sourceId).toBe('it-1');
    expect(calls().some((s) => s.includes('SET linked_wo_id'))).toBe(true);
    const ev = (emitDomainEvent as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as any).find((x) => x.type === 'convert');
    expect(ev.payload.work_order_id).toBe('wo-l1');
  });
});

describe('inspection.ts · 周期计划（G3）与 catch-up 调度', () => {
  it('⑱GET /plans 列表；⑲POST /plans generate_ahead=2 × 2 点位 → 4 张实例单 + next_run_at 推进', async () => {
    expect((await req('GET', '/api/v1/inspection/plans')).status).toBe(200);
    const r = await req('POST', '/api/v1/inspection/plans', { name: '周检', point_ids: [U1, U2], frequency: 'weekly', generate_ahead: 2 });
    expect(r.status).toBe(201);
    expect(((await r.json()) as any).count).toBe(4);
    expect(calls().filter((s) => s.includes('INSERT INTO inspection_task')).length).toBe(4);
    expect(calls().some((s) => s.includes('UPDATE inspection_plan SET next_run_at'))).toBe(true);
    const evs = (emitDomainEvent as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] as any);
    expect(evs.at(-1)?.entityType).toBe('inspection_plan'); // 计划事件在实例单事件之后
  });

  it('⑳PUT /plans/:id paused=true → SET paused；空 body → 不产生 UPDATE（幂等语义）', async () => {
    const r = await req('PUT', '/api/v1/inspection/plans/pl-1', { paused: true });
    expect(r.status).toBe(200);
    const updIdx = calls().findIndex((s) => s.includes('UPDATE inspection_plan SET'));
    expect(calls()[updIdx]).toContain('paused = $3');
    fakeClient.query.mockClear();
    await req('PUT', '/api/v1/inspection/plans/pl-1', {});
    expect(calls().some((s) => s.includes('UPDATE inspection_plan SET'))).toBe(false);
  });

  it('㉑POST /plans/:id/generate：暂停 → 409；正常 → 按点位数生成并推进 next_run_at', async () => {
    planFound = false;
    expect((await req('POST', '/api/v1/inspection/plans/pl-1/generate')).status).toBe(404);
    planFound = true;
    fakeClient.query.mockClear();
    fakeClient.query.mockImplementationOnce(async () => ({ rows: [{ id: 'pl-1', name: '日常', point_ids: [U1, U2], frequency: 'daily', interval_n: 1, paused: true, next_run_at: new Date().toISOString(), item_ids: [] }], rowCount: 1 } as any));
    expect((await req('POST', '/api/v1/inspection/plans/pl-1/generate')).status).toBe(409);
    fakeClient.query.mockClear();
    const r = await req('POST', '/api/v1/inspection/plans/pl-1/generate');
    expect(r.status).toBe(201);
    expect(((await r.json()) as any).count).toBe(2);
  });

  it('㉒runDuePlansForTenant：到期计划 catch-up 补齐 2 期 × 2 点位 → generated=4 + next_run_at 推进', async () => {
    duePlans = [{ id: 'pl-1', name: '日检', point_ids: [U1, U2], frequency: 'daily', interval_n: 1, next_run_at: new Date(Date.now() - 2 * 86400000).toISOString() }];
    const n = await runDuePlansForTenant(TENANT);
    expect(n).toBe(6); // catch-up 补 3 期（-2d/-1d/今天）× 2 点位
    expect(calls().filter((s) => s.includes('INSERT INTO inspection_task')).length).toBe(6);
    expect(calls().some((s) => s.includes('UPDATE inspection_plan SET next_run_at'))).toBe(true);
  });
});

describe('inspection.ts · 统计与导出', () => {
  it('㉓GET /stats：完成率/异常率真计算；无实测 → item_pass_rate 诚实置 null', async () => {
    const byStatusReply = { rows: [{ status: 'pending', c: 2 }, { status: 'done', c: 3 }, { status: 'exception', c: 1 }], rowCount: 3 };
    fakeClient.query.mockImplementationOnce(async () => byStatusReply as any);
    const r = await req('GET', '/api/v1/inspection/stats');
    expect(r.status).toBe(200);
    const s = ((await r.json()) as any).stats;
    expect(s.total).toBe(6);
    expect(s.completion_rate).toBe(50);
    expect(s.exception_rate).toBe(16.7);
    expect(s.item_pass_rate).toBeNull(); // itemAgg 回 0 行聚合 → 不虚构
  });

  it('㉔GET /export：worker → 403；CSV 带 BOM（EF BB BF）；Content-Disposition month 白名单（CRLF 注入回落 all）；R5-001 公式注入前置引号', async () => {
    authRole = 'worker';
    expect((await req('GET', '/api/v1/inspection/export?month=2026-08')).status).toBe(403);
    authRole = 'operator';
    taskRow.items_json = [{ item_id: 'u1', passed: true }, { item_id: 'u2', passed: false }];
    taskRow.title = '=cmd|\' /c calc!';
    fakeClient.query.mockImplementationOnce(async () => ({ rows: [taskRow], rowCount: 1 } as any));
    const r = await req('GET', '/api/v1/inspection/export?month=' + encodeURIComponent('2026-08\r\nX-Evil: 1'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-disposition')).toContain('inspection_report_all.csv');
    const buf = new Uint8Array(await r.arrayBuffer());
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(buf.slice(3));
    expect(text).toContain("'=cmd"); // R5-001：公式前缀单引号 neutral
    expect(text).toContain('计划巡检');
  });
});
