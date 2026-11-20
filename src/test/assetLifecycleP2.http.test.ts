// 资产模块 P2/P3 契约测试（2026-11-17）：
// 责任人/部门/保修、维保计划、事件时间线、到期提醒、附件、统计折旧、批量操作、导入二维码。
// 负控制：已处置不可改、维修中不可报废、批量缺 patch/报废缺原因、附件/维保不存在 → 404。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const UPLOAD_TMP = vi.hoisted(() => {
  const dir = `${process.cwd()}/.tmp-asset-p2-upload-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  process.env.UPLOAD_DIR = dir;
  return dir;
});
const ATTACH_FILE = '123e4567-e89b-12d3-a456-426614174000.pdf';
const TENANT = 't-asset-p2';
const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const A3 = '33333333-3333-4333-8333-333333333333';

let authRole = 'admin';
let assets: Record<string, any> = {};
let events: any[] = [];
let orders: any[] = [];
let attachments: any[] = [];
let reversals: any[] = [];
let pendingReversal = false;
let workflowDef: any = { initial: 'draft', states: ['draft','assigned','processing','cancelled','completed'], transitions: [
  { from: 'draft', to: 'assigned', event: 'assign' },
  { from: 'assigned', to: 'processing', event: 'start' },
  { from: 'processing', to: 'completed', event: 'complete' },
  { from: 'processing', to: 'cancelled', event: 'cancel' },
], config: { doneStates: ['completed'] } };
let authUserId = 'u-1';

const fakeClient = {
  query: vi.fn(async (text: unknown, params?: unknown[]) => {
    const sql = String(text);
    const p = (params ?? []) as any[];

    if (sql.includes('SELECT * FROM asset WHERE id=$1 AND tenant_id=$2')) {
      const a = assets[p[0]];
      return a ? { rows: [{ ...a }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes('SELECT linked_order_ids FROM asset WHERE id=$1')) {
      const a = assets[p[0]];
      return a ? { rows: [{ linked_order_ids: a.linked_order_ids ?? [] }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM workflow_def')) {
      return { rows: [{ def: workflowDef }], rowCount: 1 };
    }
    if (sql.includes('SELECT id FROM asset_disposal_reversal') && sql.includes("status='pending'")) {
      return pendingReversal
        ? { rows: [{ id: 'rev-1' }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes('INSERT INTO asset_disposal_reversal')) {
      const row = { id: 'rev-1', asset_id: p[1], status: 'pending', reason: p[2], requested_by: p[4], requested_by_id: p[5] };
      reversals = [row];
      pendingReversal = true;
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('SELECT * FROM asset_disposal_reversal WHERE id=$1')) {
      const row = reversals.find((x) => x.id === p[0]);
      return row ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes('UPDATE asset_disposal_reversal')) {
      const row = reversals.find((x) => x.id === p[0]);
      if (!row) return { rows: [], rowCount: 0 };
      row.status = sql.includes("status='approved'") ? 'approved' : 'rejected';
      row.decided_by = p[2];
      row.decision_note = p[4];
      pendingReversal = false;
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (sql.includes('FROM asset_disposal_reversal r')) {
      return { rows: reversals.map((r) => ({ ...r, asset_no: assets[r.asset_id]?.asset_no, name: assets[r.asset_id]?.name })), rowCount: reversals.length };
    }
    if (sql.includes('FROM asset_disposal_reversal') && sql.startsWith('SELECT')) {
      return { rows: reversals, rowCount: reversals.length };
    }
    if (sql.includes('SELECT id FROM asset_reminder_dismissal')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('SELECT d.kind, d.ref_id')) {
      return {
        rows: [{ kind: 'warranty', ref_id: A1, dismissed_by: 'admin', dismissed_at: '2026-11-20T00:00:00Z', asset_id: A1, asset_no: 'ASSET-A1', name: '呼吸机', due_at: '2026-11-22' }],
        rowCount: 1,
      };
    }
    if (sql.includes('UPDATE asset_reminder_dismissal')) {
      return { rows: [{ ref_id: p[2] }], rowCount: 1 };
    }
    if (sql.includes('SELECT id FROM asset WHERE id=$1 AND tenant_id=$2')) {
      const a = assets[p[0]];
      return a ? { rows: [{ id: a.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM domain_event')) {
      return { rows: events, rowCount: events.length };
    }
    if (sql.includes('FROM work_orders WHERE id = ANY')) {
      return { rows: orders, rowCount: orders.length };
    }
    if (sql.includes('INSERT INTO asset (')) {
      if (p[2] === 'DUP-2') throw new Error('duplicate key value violates unique constraint "ux_asset_tenant_asset_no"');
      return {
        rows: [{ id: 'a-new', asset_no: p[2], qr_code: p[3], status: p[6], responsible_user: p[14], department: p[15] }],
        rowCount: 1,
      };
    }
    if (sql.includes('INSERT INTO asset_maintenance')) {
      return { rows: [{ id: 'm-1', asset_id: p[1], maintain_date: p[2], next_due: p[7] }], rowCount: 1 };
    }
    if (sql.includes('UPDATE asset_maintenance SET')) {
      return { rows: [{ id: 'm-1', asset_id: A1 }], rowCount: 1 };
    }
    if (sql.includes('SELECT id FROM asset_maintenance WHERE id=$1 AND tenant_id=$2')) {
      const exists = p[0] !== '99999999-9999-4999-8999-999999999999';
      return exists ? { rows: [{ id: p[0] }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes('INSERT INTO asset_reminder_dismissal')) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('SELECT asset_id FROM asset_maintenance')) {
      return { rows: [{ asset_id: A1 }], rowCount: 1 };
    }
    if (sql.includes('DELETE FROM asset_maintenance')) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE asset') && sql.includes('SET') && !sql.includes('asset_maintenance') && !sql.includes('asset_attachment')) {
      const a = assets[p[0]];
      if (a && sql.includes("status='disposed'")) a.status = 'disposed';
      else if (a && sql.includes("status='in_use'")) a.status = 'in_use';
      else if (a && sql.match(/status = \$/)) a.status = p.find((x, i) => sql.includes(`status = $${i + 1}`)) ?? a.status;
      return { rows: [{ ...(a ?? { id: p[0] }) }], rowCount: a ? 1 : 0 };
    }
    // reminders：保修
    if (sql.includes('AS days_left') && sql.includes('warranty_until <= current_date')) {
      return { rows: [{ id: A1, asset_no: 'ASSET-W1', name: '呼吸机', days_left: 5, warranty_until: '2026-11-22' }], rowCount: 1 };
    }
    // reminders：维保计划
    if (sql.includes('FROM asset_maintenance m')) {
      return { rows: [{ id: 'm-9', asset_id: A1, days_left: -2, next_due: '2026-11-15', name: '呼吸机' }], rowCount: 1 };
    }
    // stats
    if (sql.includes('AS in_use') && sql.includes('AS warranty_expired')) {
      return {
        rows: [{
          total: 3, in_use: 1, repairing: 1, standby: 0, disabled: 0, disposed: 1,
          purchase_total: '2200.00', residual_total: '100.00', warranty_expired: 1,
        }],
        rowCount: 1,
      };
    }
    if (sql.includes('AS department, count(*)::int AS count')) {
      return { rows: [{ department: 'ICU', count: 2, purchase_total: '2000.00' }], rowCount: 1 };
    }
    if (sql.includes('AS category, count(*)::int AS count')) {
      return { rows: [{ category: '医疗设备', count: 2, purchase_total: '2000.00' }], rowCount: 1 };
    }
    if (sql.includes('SELECT price, purchase_date, useful_life_months FROM asset')) {
      const past = new Date();
      past.setMonth(past.getMonth() - 24);
      return { rows: [{ price: '1200.00', purchase_date: past.toISOString().slice(0, 10), useful_life_months: 12 }], rowCount: 1 };
    }
    // attachments
    if (sql.includes('FROM asset_attachment') && sql.startsWith('SELECT')) {
      return { rows: attachments, rowCount: attachments.length };
    }
    if (sql.includes('INSERT INTO asset_attachment')) {
      const row = { id: 'att-1', name: p[2], url: p[3], content_type: p[4], size: p[5], uploaded_by: p[6], scan_status: p[7], scan_engine: p[8] };
      attachments = [row];
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('SELECT asset_id, name FROM asset_attachment')) {
      return { rows: [{ asset_id: p[0] === 'missing' ? '' : A1, name: '说明书.pdf' }], rowCount: p[0] === 'missing' ? 0 : 1 };
    }
    if (sql.includes('DELETE FROM asset_attachment')) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 } as any;
  }) as any,
};

vi.mock('../db/pool.js', () => ({
  default: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  withTenantClient: async (_tid: string, fn: (c: unknown) => unknown) => {
    return fn(fakeClient);
  },
  assertSafeTenantId: (t: string) => t,
}));

const emitDomainEvent = vi.fn(async (..._a: unknown[]): Promise<null> => null);
vi.mock('../db/eventBus.js', () => ({ emitDomainEvent: (...a: unknown[]) => emitDomainEvent(...a) }));

import assetRouter from '../routes/asset.js';
import { errorMiddleware } from '../middleware/error.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use((_req, res, next) => {
  res.locals.auth = { tenantId: TENANT, role: authRole, userId: authUserId, requestId: 'r-1', authMode: 'dev' };
  next();
});
app.use('/api/v1', assetRouter);
app.use(errorMiddleware);

let server: Server;
let base = '';
beforeAll(async () => {
  fs.mkdirSync(path.join(UPLOAD_TMP, TENANT), { recursive: true });
  fs.writeFileSync(path.join(UPLOAD_TMP, TENANT, ATTACH_FILE), Buffer.from('%PDF-1.4 test'));
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(UPLOAD_TMP, { recursive: true, force: true });
});
beforeEach(() => {
  authRole = 'admin';
  assets = {
    [A1]: { id: A1, asset_no: 'ASSET-A1', name: '呼吸机', status: 'in_use', linked_order_ids: ['wo-1'] },
    [A2]: { id: A2, asset_no: 'ASSET-A2', name: '输液泵', status: 'disposed', linked_order_ids: [] },
    [A3]: { id: A3, asset_no: 'ASSET-A3', name: '监护仪', status: 'repairing', linked_order_ids: [] },
  };
  events = [];
  orders = [];
  attachments = [];
  reversals = [];
  pendingReversal = false;
  authUserId = 'u-1';
  fakeClient.query.mockClear();
  emitDomainEvent.mockClear();
});
const req = (method: string, p: string, body?: unknown) =>
  fetch(base + p, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const eventTypes = () => emitDomainEvent.mock.calls.map((c: any[]) => (c[1] as any).type);

describe('资产生命周期 P2 · 建档/编辑事件与字段', () => {
  it('建档写入责任人/部门/保修/折旧年限，并生成 AST- 二维码与 asset_created 事件', async () => {
    const r = await req('POST', '/assets', {
      name: '呼吸机', responsible_user: '张三', department: 'ICU',
      warranty_until: '2028-01-01', warranty_vendor: '某医疗', useful_life_months: 60,
    });
    expect(r.status).toBe(201);
    const ins = fakeClient.query.mock.calls.find((c: any[]) => String(c[0]).includes('INSERT INTO asset ('));
    // 按 SQL 列名取值，避免参数位置变化导致契约测试假红。
    const sql = String(ins![0]);
    const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((x) => x.trim());
    const row = Object.fromEntries(cols.map((c, i) => [c, (ins![1] as any[])[i]]));
    expect(row.qr_code).toMatch(/^AST-ASSET-[0-9A-F]{8}$/);
    expect(row.responsible_user).toBe('张三');
    expect(row.department).toBe('ICU');
    expect(row.warranty_until).toBe('2028-01-01');
    expect(row.warranty_vendor).toBe('某医疗');
    expect(row.useful_life_months).toBe(60);
    expect(eventTypes()).toContain('asset_created');
  });

  it('负控制：建档直接写 disposed → 400', async () => {
    const r = await req('POST', '/assets', { name: 'x', status: 'disposed' });
    expect(r.status).toBe(400);
  });

  it('编辑状态 → 同时发 asset_updated 与 asset_status_changed', async () => {
    const r = await req('PUT', `/assets/${A1}`, { status: 'standby', department: '急诊' });
    expect(r.status).toBe(200);
    expect(eventTypes()).toContain('asset_updated');
    const changed = emitDomainEvent.mock.calls.find((c: any[]) => (c[1] as any).type === 'asset_status_changed');
    expect((changed![1] as any).payload).toEqual({ from: 'in_use', to: 'standby' });
  });

  it('负控制：已处置资产不可编辑 → 409', async () => {
    const r = await req('PUT', `/assets/${A2}`, { location: '库房' });
    expect(r.status).toBe(409);
  });
});

describe('资产生命周期 P2 · 事件时间线', () => {
  it('历史 = 关联工单 + 领域事件，按时间倒序且保留工单兼容字段', async () => {
    events = [{ id: '9', type: 'asset_transfer', actor: 'admin', payload: { location: '新址' }, created_at: '2026-11-17T10:00:00.000Z' }];
    orders = [{ id: 'wo-1', order_no: 'WO-1', business_type: 'repair', status: 'processing', created_at: '2026-11-17T09:00:00.000Z' }];
    const r = await req('GET', `/assets/${A1}/history`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.items.map((x: any) => x.kind)).toEqual(['event', 'work_order']);
    expect(j.items[0].event_type).toBe('asset_transfer');
    expect(j.items[1].order_id).toBe('wo-1');
    expect(j.items[1].order_no).toBe('WO-1');
  });

  it('无关联工单但有事件时仍返回时间线（不再被短路为空）', async () => {
    assets[A1].linked_order_ids = [];
    events = [{ id: '10', type: 'asset_maintenance_added', actor: 'admin', payload: {}, created_at: '2026-11-17T10:00:00.000Z' }];
    const r = await req('GET', `/assets/${A1}/history`);
    const j = (await r.json()) as any;
    expect(j.items).toHaveLength(1);
    expect(j.items[0].event_type).toBe('asset_maintenance_added');
  });
});

describe('资产生命周期 P2 · 维保计划与到期提醒', () => {
  it('新增维保写入 next_due 并留痕', async () => {
    const r = await req('POST', `/assets/${A1}/maintenance`, { type: '保养', next_due: '2027-01-01' });
    expect(r.status).toBe(201);
    const ins = fakeClient.query.mock.calls.find((c: any[]) => String(c[0]).includes('INSERT INTO asset_maintenance'));
    expect((ins![1] as any[])[7]).toBe('2027-01-01');
    expect(eventTypes()).toContain('asset_maintenance_added');
  });

  it('负控制：资产不存在 → 404', async () => {
    const r = await req('POST', `/assets/${'99999999-9999-4999-8999-999999999999'}/maintenance`, { type: '保养' });
    expect(r.status).toBe(404);
  });

  it('到期提醒同时返回保修与维保计划', async () => {
    const r = await req('GET', '/assets/reminders?days=30');
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.days).toBe(30);
    expect(j.warranty[0].days_left).toBe(5);
    expect(j.maintenance[0].days_left).toBe(-2);
  });
});

describe('资产生命周期 P3 · 统计折旧 / 批量 / 附件', () => {
  it('统计返回状态分布、部门/分类汇总与直线折旧', async () => {
    const r = await req('GET', '/assets/stats');
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.summary.disposed).toBe(1);
    expect(j.by_department[0].department).toBe('ICU');
    expect(j.depreciation?.covered_assets, JSON.stringify(j)).toBe(1);
    expect(j.depreciation.accumulated_total).toBe(1200);
    expect(j.depreciation.net_total).toBe(0);
  });

  it('批量更新：成功的计数，已处置资产跳过', async () => {
    const r = await req('POST', '/assets/batch', { action: 'update', ids: [A1, A2], patch: { department: 'ICU' } });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.updated).toBe(1);
    expect(j.skipped[0]).toEqual({ id: A2, reason: '已处置' });
  });

  it('负控制：批量报废维修中资产跳过；缺 patch / 缺原因 → 400', async () => {
    const r = await req('POST', '/assets/batch', { action: 'dispose', ids: [A3], reason: '老化' });
    const j = (await r.json()) as any;
    expect(j.updated).toBe(0);
    expect(j.skipped[0].reason).toContain('维修中');

    expect((await req('POST', '/assets/batch', { action: 'update', ids: [A1] })).status).toBe(400);
    expect((await req('POST', '/assets/batch', { action: 'dispose', ids: [A1] })).status).toBe(400);
    expect((await req('POST', '/assets/batch', { action: 'update', ids: [A1], patch: { status: 'disposed' } })).status).toBe(400);
  });

  it('附件新增/列表/删除；不存在资产 → 404', async () => {
    const add = await req('POST', `/assets/${A1}/attachments`, { name: '说明书.pdf', url: `/uploads/${TENANT}/${ATTACH_FILE}` });
    expect(add.status).toBe(201);
    expect(eventTypes()).toContain('asset_attachment_added');

    const list = await req('GET', `/assets/${A1}/attachments`);
    expect(list.status).toBe(200);
    expect(((await list.json()) as any).items[0].name).toBe('说明书.pdf');

    expect((await req('DELETE', '/assets/attachments/att-1')).status).toBe(200);
    expect((await req('POST', '/assets/99999999-9999-4999-8999-999999999999/attachments', { name: 'x', url: `/uploads/${TENANT}/${ATTACH_FILE}` })).status).toBe(404);
  });
});

describe('CSV 导入事务契约 · 逐行 SAVEPOINT', () => {
  it('单行冲突只回滚该行，成功行仍提交，回执不虚报', async () => {
    const csv = 'asset_no,name\nOK-1,成功资产\nDUP-2,重复资产\n';
    const r = await req('POST', '/assets/import', { csv });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.inserted).toBe(1);
    expect(j.skipped).toBe(1);
    const sqls = fakeClient.query.mock.calls.map((c: any[]) => String(c[0]));
    expect(sqls).toContain('SAVEPOINT csv_row');
    expect(sqls).toContain('ROLLBACK TO SAVEPOINT csv_row');
    expect(sqls).toContain('RELEASE SAVEPOINT csv_row');
  });
});

describe('资产详情/提醒忽略/导入模板（2026-11-17 增补）', () => {
  it('GET /assets/:id 返回单资产折旧净值；未配置年限返回 null', async () => {
    const past = new Date();
    past.setMonth(past.getMonth() - 24);
    assets[A1] = {
      ...assets[A1],
      price: '1200.00',
      purchase_date: past.toISOString().slice(0, 10),
      useful_life_months: 12,
    };
    const r = await req('GET', `/assets/${A1}`);
    expect(r.status).toBe(200);
    const d = ((await r.json()) as any).item.depreciation;
    expect(d.method).toBe('straight_line');
    expect(d.accumulated).toBe(1200);
    expect(d.net).toBe(0);

    assets[A1] = { ...assets[A1], useful_life_months: null };
    const r2 = await req('GET', `/assets/${A1}`);
    expect(((await r2.json()) as any).item.depreciation).toBeNull();
  });

  it('负控制：GET /assets/:id 不存在 → 404', async () => {
    expect((await req('GET', '/assets/99999999-9999-4999-8999-999999999999')).status).toBe(404);
  });

  it('手动忽略提醒：写入 dismissal 并可重复忽略（幂等）', async () => {
    const r = await req('POST', '/assets/reminders/dismiss', { kind: 'maintenance', ref_id: '55555555-5555-4555-8555-555555555555' });
    expect(r.status).toBe(200);
    const sqls = fakeClient.query.mock.calls.map((c: any[]) => String(c[0]));
    expect(sqls.some((x: string) => x.includes('INSERT INTO asset_reminder_dismissal'))).toBe(true);
    expect((await req('POST', '/assets/reminders/dismiss', { kind: 'maintenance', ref_id: '55555555-5555-4555-8555-555555555555' })).status).toBe(200);
  });

  it('负控制：忽略不存在的维保记录 → 404', async () => {
    const r = await req('POST', '/assets/reminders/dismiss', { kind: 'maintenance', ref_id: '99999999-9999-4999-8999-999999999999' });
    expect(r.status).toBe(404);
  });

  it('到期提醒 SQL 排除已忽略项（租户内持久化）', async () => {
    await req('GET', '/assets/reminders');
    const sqls = fakeClient.query.mock.calls.map((c: any[]) => String(c[0]));
    const sql = sqls.filter((x: string) => x.includes('days_left')).join('\n');
    expect(sql).toContain('asset_reminder_dismissal');
    expect(sql).toContain("kind='warranty'");
    expect(sql).toContain("kind='maintenance'");
  });

  it('导入模板可下载，表头覆盖全部可导入字段', async () => {
    const r = await req('GET', '/assets/import-template');
    expect(r.status).toBe(200);
    const buf = new Uint8Array(await r.arrayBuffer());
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder('utf-8').decode(buf.slice(3));
    for (const h of ['资产编号', '资产名称', '责任人', '部门', '保修截止', '折旧年限(月)']) {
      expect(text).toContain(h);
    }
  });
});

describe('处置撤销审批 / 提醒恢复 / 流程预检（2026-11-20）', () => {
  it('处置撤销：申请 → 自审 409 → 另一管理员审批 → 资产恢复 in_use', async () => {
    assets[A1] = {
      ...assets[A1],
      status: 'disposed',
      disposed_at: new Date().toISOString(),
      dispose_method: '报废',
      disposal_reversed_at: null,
    };
    const reqRes = await req('POST', `/assets/${A1}/dispose/reversal`, { reason: '误报废' });
    expect(reqRes.status).toBe(201);
    const revId = ((await reqRes.json()) as any).item.id;

    const self = await req('POST', `/assets/disposal-reversals/${revId}/approve`, { note: '自审' });
    expect(self.status).toBe(409);
    expect(((await self.json()) as any).code).toBe('SELF_APPROVAL');

    authUserId = 'u-2';
    const ok = await req('POST', `/assets/disposal-reversals/${revId}/approve`, { note: '同意' });
    expect(ok.status).toBe(200);
    expect(assets[A1].status).toBe('in_use');
    expect(eventTypes()).toContain('asset_disposal_reversal_approved');
  });

  it('负控制：超过 30 天 / 变卖处置 / 非已处置资产 → 409', async () => {
    const old = new Date(Date.now() - 31 * 86400000).toISOString();
    assets[A1] = { ...assets[A1], status: 'disposed', disposed_at: old, dispose_method: '报废' };
    expect((await req('POST', `/assets/${A1}/dispose/reversal`, { reason: '超期' })).status).toBe(409);

    assets[A1] = { ...assets[A1], status: 'disposed', disposed_at: new Date().toISOString(), dispose_method: '变卖' };
    expect((await req('POST', `/assets/${A1}/dispose/reversal`, { reason: '已变卖' })).status).toBe(409);

    assets[A1] = { ...assets[A1], status: 'in_use' };
    expect((await req('POST', `/assets/${A1}/dispose/reversal`, { reason: '未处置' })).status).toBe(409);
  });

  it('已忽略提醒列表可查询并恢复', async () => {
    const list = await req('GET', '/assets/reminders/dismissed');
    expect(list.status).toBe(200);
    expect(((await list.json()) as any).items[0].kind).toBe('warranty');

    const restore = await req('POST', '/assets/reminders/restore', { kind: 'warranty', ref_id: A1 });
    expect(restore.status).toBe(200);
  });

  it('流程预检：返回可达的取消/完成路径（系统机制态也纳入可达性）', async () => {
    const ok = await req('GET', '/assets/workflow-readiness');
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as any;
    expect(okBody.ok).toBe(true);
    // 取消边可来自配置态，也可能来自系统注入的 claim_hall；关键是“初始状态可达”。
    expect(okBody.cancel_from.length).toBeGreaterThan(0);
    expect(okBody.done_from).toContain('processing->completed');
    // 负控制（NO_CANCEL_PATH）由纯函数 assetOpsRules.test.ts 覆盖，避免系统机制态干扰 HTTP 断言。
  });
});
