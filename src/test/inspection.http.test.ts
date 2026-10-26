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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
// T1-B 批1：inspection 读写两侧已改为走 getWorkflowDefAtVersion / getWorkflowDefVersion，
//   桩必须补齐这两个导出，否则真模块被整体替换后二者为 undefined ⇒ 调用即 TypeError。
vi.mock('../engine/workflowDef.js', () => {
  const stubDef = {
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
  };
  return {
    getWorkflowDefOrDefault: async () => stubDef,
    getWorkflowDefAtVersion: async () => stubDef,
    // 🔴 刻意返回非零的 3，不返回 0：桩值若取 0，实现把版本号写死成 0（= 永不上锁，
    //   最严重的那种错）时断言照样绿 —— 桩值恰好等于"错误实现的默认值"就是假绿的温床。
    //   取 3 之后，"漏传参数 / 写死 0 / 写死别的数"三种错都会被 A4-c/A4-d 抓住。
    getWorkflowDefVersion: async () => 3,
  };
});
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
    // T8（2026-10-25）：配置面守卫由 requireConfigRole（角色白名单）收敛为
    // requirePermission('inspect.manage')。requirePermission 在 dev 模式恒放行（role.ts:396），
    // 继续用 dev 跑这条等于恒绿 ⇒ 切 prod 走真实权限点路径，护栏比改前更强。
    authRole = 'worker'; authMode = 'prod';
    expect((await req('POST', '/api/v1/inspection/points', { name: '锅炉房' })).status).toBe(403);
    authRole = 'operator';
    r = await req('POST', '/api/v1/inspection/points', { name: '锅炉房', lng: 110.1, lat: 30.1 });
    expect(r.status).toBe(201); // operator 默认矩阵含 inspect.manage
    authMode = 'dev';
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

  it('⑩POST /tasks（worker）→ 403（inspect.manage 真 403）', async () => {
    authRole = 'worker'; authMode = 'prod'; // 同①：dev 恒放行，切 prod 才走真实权限点路径
    expect((await req('POST', '/api/v1/inspection/tasks', { title: 'x' })).status).toBe(403);
    authMode = 'dev';
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
    authRole = 'worker'; authMode = 'prod'; // 同①：dev 恒放行，切 prod 才走真实权限点路径
    expect((await req('GET', '/api/v1/inspection/export?month=2026-08')).status).toBe(403);
    // 复位 dev：下面的 mockImplementationOnce 夹具是按「CSV 查询」注入的，守卫移到事务首行后
    // 会抢先消费掉它 ⇒ operator 段留在 dev，不改夹具语义（operator 放行已由①的 prod 断言覆盖）。
    authMode = 'dev';
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

// ============================================================
// T1-B 批 1 · inspection_task 在途单锁版本
//
// 【口径分工】A1/A2/A3 的**动态**部分在 src/test/workflowDefAtVersion.pglite.test.ts 里用真库验
//   （那里 workflowDef 是**真模块**而非桩 ⇒ 才验得到版本链）。本文件只承担两件桩也能验的事：
//   ① A4：三处 INSERT 的盖章是否真的落到 SQL 参数里（桩能验，因为它验的是"参数从哪来"）；
//   ② A3 静态侧：读写两侧是不是同一条 read 路径（防 R-1：只改写侧不改读侧）。
//
// 【为什么不验"版本号具体等于几"】本文件的 workflowDef 是被 vi.mock 整体替换的桩 ⇒
//   在这里断言"版本号 == live version"验的是桩不是实现，属纸面验证（E2 反面）。
//   真值断言放到 PGlite 那份（真 getWorkflowDefVersion）里去。
// ============================================================
const INSPECTION_SRC = readFileSync(join(__dirname, '..', 'routes', 'inspection.ts'), 'utf8');

/** 抽出 inspection_task 的三处 INSERT：列清单 / VALUES 段最大占位符 / 出现位置。 */
function inspectionInserts(src: string) {
  const re = /INSERT INTO inspection_task \(([^)]*)\)\s*VALUES \(([^)]*)\)/g;
  const out: { cols: string[]; maxPh: number; at: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const cols = m[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const nums = [...m[2].matchAll(/\$(\d+)/g)].map((x) => Number(x[1]));
    out.push({ cols, maxPh: nums.length ? Math.max(...nums) : 0, at: m.index });
  }
  return out;
}
const INSERTS = inspectionInserts(INSPECTION_SRC);

describe('T1-B 批1 · inspection_task 在途单锁版本', () => {
  it('A4-a：三处 INSERT 全部带上 def_version 列（手工建单 / 周期计划 / 批量生成）', () => {
    // 设计文档 §5 批1 明确点名「:632 / :704 是计划批量生成路径，不要漏」。
    expect(INSERTS.length, 'inspection_task 的 INSERT 应为 3 处').toBe(3);
    for (const s of INSERTS) {
      expect(s.cols, 'INSERT 列清单缺 def_version ⇒ 该路径的新单不入版本锁').toContain('def_version');
    }
  });

  it('A4-b：三处 INSERT 占位符各自止于 8/7/6，且与列清单对齐（防参数错位）', () => {
    // 三处列数不同（手工建单多 assignee、各路径 plan_id 写法不同）⇒ 逐个钉死，不写成一个笼统的 >0。
    expect(INSERTS.map((s) => s.maxPh).sort((a, b) => b - a)).toEqual([8, 7, 6]);
    for (const s of INSERTS) {
      // def_version 必须是最后一个占位符 ⇒ 列清单里它也必须是最后一列。
      expect(s.cols[s.cols.length - 1]).toBe('def_version');
    }
  });

  it('A4-c：POST /tasks 手工建单 ⇒ 版本号真的落到 INSERT 参数里（8 个参，末位即版本）', async () => {
    authRole = 'operator';
    authMode = 'dev';
    fakeClient.query.mockClear();
    const r = await req('POST', '/api/v1/inspection/tasks', { title: '配电房日检', point_id: U1 });
    expect(r.status).toBe(201);
    const insert = fakeClient.query.mock.calls.find((c: any) => String(c[0]).includes('INSERT INTO inspection_task'));
    expect(insert, '没捕获到 INSERT INTO inspection_task').toBeTruthy();
    const params = insert![1] as unknown[];
    // 漏传参数 ⇒ length 是 7；把版本号写死成 0 或别的常量 ⇒ 不等于桩返回的 3。三种错都能抓住。
    expect(params.length).toBe(8);
    expect(params[7], 'def_version 参数必须取 getWorkflowDefVersion 的返回值').toBe(3);
  });

  it('A4-d：POST /generate 批量生成 ⇒ 每单都盖章，版本号在循环外只取一次', async () => {
    authRole = 'operator';
    authMode = 'dev';
    fakeClient.query.mockClear();
    const r = await req('POST', '/api/v1/inspection/generate', { point_ids: [U1, U2] });
    expect(r.status).toBe(201);
    const inserts = fakeClient.query.mock.calls.filter((c: any) => String(c[0]).includes('INSERT INTO inspection_task'));
    expect(inserts.length, '两个点位 ⇒ 两条 INSERT，一条都不能漏盖章').toBe(2);
    for (const c of inserts) {
      const params = c[1] as unknown[];
      expect(params.length).toBe(6);
      expect(params[5]).toBe(3);
    }
  });

  it('A3-静态：读写两侧走同一条 versioned read 路径（这条是抓 R-1 的关键）', () => {
    // 🔴 若只把写侧 :40 改成 versioned、读侧 :330 仍读 live ⇒ 这里只会匹配到 1 次 ⇒ 立刻红。
    const re = /getWorkflowDefAtVersion\(client, tenantId, 'inspection_task', t\.def_version, INSPECTION_DEF\)/g;
    expect(INSPECTION_SRC.match(re)?.length, '写侧 + 读侧 = 2 处，少一处即 R-1（按钮与实际校验不一致）').toBe(2);
    // 文件内不得再残留裸调用：那条残留路径读的就是 live，等于锁了个寂寞。
    expect(INSPECTION_SRC).not.toMatch(/getWorkflowDefOrDefault\s*\(/);
  });

  it('A4-e：取版本号排在 for 循环之外（周期计划两处各只查一次，不是每单查一次）', () => {
    for (const marker of ['for (const pid of plan.point_ids)', 'for (const row of rows)']) {
      const forAt = INSPECTION_SRC.indexOf(marker);
      expect(forAt, `源码里找不到 ${marker} —— 本测试已与设计脱节，请同步`).toBeGreaterThan(0);
      const verAt = INSPECTION_SRC.lastIndexOf('getWorkflowDefVersion(client, tenantId', forAt);
      expect(verAt, `取版本号必须排在 ${marker} 之前（放到循环内会变成每单一次查询）`).toBeGreaterThan(0);
      // 两者之间不得再夹一个 for ⇒ 证明这次取值紧贴本循环、不在更外层（否则一样是每单查一次）。
      expect(INSPECTION_SRC.slice(verAt, forAt)).not.toContain('for (const ');
    }
  });

  it('A4-f：POST /plans 建周期计划 ⇒ 预生成的实例也盖章（这条路径不能只靠静态断言）', async () => {
    // 设计文档 §5 批1 点名「:632 是计划批量生成路径，不要漏」；A4-a/b 是静态的，
    // 这条把 :632 也拉进动态覆盖 ⇒ 三处 INSERT 每一处都有真请求打底。
    authRole = 'operator';
    authMode = 'dev';
    fakeClient.query.mockClear();
    const r = await req('POST', '/api/v1/inspection/plans', {
      name: '日常巡检',
      point_ids: [U1, U2],
      frequency: 'weekly',
    });
    expect(r.status).toBe(201);
    const inserts = fakeClient.query.mock.calls.filter((c: any) => String(c[0]).includes('INSERT INTO inspection_task'));
    expect(inserts.length, '两个点位 ⇒ 预生成两条，一条都不能漏盖章').toBe(2);
    for (const c of inserts) {
      const params = c[1] as unknown[];
      expect(params.length).toBe(7);
      expect(params[6]).toBe(3);
    }
  });
});
