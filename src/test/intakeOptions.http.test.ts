// intakeOptions.http.test.ts —— FE Intake 申报页配置聚合端点（GET /api/v1/meta/intake-options，075 配套）。
// 真·express + 真 HTTP（对齐 settlement.http.test.ts 范式），mock 掉 DB 连接池（脚本化 client）。
// 覆盖：① 聚合形状（business_type_dict × fault_category 按 business_type 归组 + skill_tags jsonb 解析）
//       ② skill_tags NULL / 非法 jsonb → []（坏数据不炸端点）
//       ③ 空 business_type_dict → business_types: []（FE 回落内置兜底，预期行为）
//       ④ basicData business_type 类型 CRUD 一例（走 TYPES 通用逻辑）
//       ⑤ faultCategory 带 business_type/skill_tags 写入读出一例
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

// ---- mock 掉 DB 连接池：脚本化 SQL 响应 + 调用日志（对齐 basicData.test.ts 范式） ----
const h = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; params: unknown[] }>,
  scripted: [] as Array<{ match: RegExp; rows: any[]; rowCount?: number }>,
}));
vi.mock('../db/pool.js', () => ({
  default: {},
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tenantId: string, fn: (client: any) => Promise<any>) => {
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        h.calls.push({ sql, params });
        for (const s of h.scripted) {
          if (s.match.test(sql)) return { rows: s.rows, rowCount: s.rowCount ?? s.rows.length };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    return fn(client);
  },
}));

import intakeOptionsRouter from '../routes/intakeOptions.js';
import basicDataRouter from '../routes/basicData.js';
import faultCategoryRouter from '../routes/faultCategory.js';

// ---- 真实 express + 真 HTTP（鉴权上下文直注入，替代 authMiddleware） ----
const T = 't-intake-http';
let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.auth = { tenantId: T, role: 'admin', authMode: 'dev', userId: 'u1', requestId: 'test' };
    next();
  });
  app.use('/api/v1', intakeOptionsRouter);
  app.use('/api/v1', basicDataRouter);
  app.use('/api/v1', faultCategoryRouter);
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  h.calls.length = 0;
  h.scripted = [];
});

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`);
  const text = await r.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { body = { raw: text }; }
  return { status: r.status, body };
}

async function send(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(`${base}${path}`, init);
  const text = await r.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
}

describe('GET /api/v1/meta/intake-options（FE Intake 申报页配置聚合 · 租户级）', () => {
  it('聚合形状正确：业务类型 + 目录归组 + skill_tags jsonb 数组透传', async () => {
    h.scripted = [
      {
        match: /FROM business_type_dict/,
        rows: [
          { code: 'repair', name: '维修', sort: 10 },
          { code: 'transport', name: '运送', sort: 20 },
        ],
      },
      {
        match: /FROM fault_category/,
        rows: [
          { business_type: 'transport', code: 'specimen', name: '标本运送', skill_tags: ['标本', '冷藏'] },
          { business_type: 'repair', code: 'ac_fault', name: '空调故障', skill_tags: ['电工证'] },
          { business_type: 'repair', code: 'door_fault', name: '门禁故障', skill_tags: null }, // NULL → []
        ],
      },
    ];
    const r = await get('/meta/intake-options');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.code).toBe(0);
    const bts = r.body.business_types as Array<{ code: string; name: string; sort: number; enabled: boolean; catalogs: Array<{ code: string; name: string; skill_tags: string[] }> }>;
    expect(bts).toHaveLength(2);
    // 排序跟随 sort ASC
    expect(bts[0].code).toBe('repair');
    expect(bts[0].enabled).toBe(true);
    expect(bts[1].code).toBe('transport');
    // repair 挂两个目录，sort ASC；NULL skill_tags → []
    expect(bts[0].catalogs).toEqual([
      { code: 'ac_fault', name: '空调故障', skill_tags: ['电工证'] },
      { code: 'door_fault', name: '门禁故障', skill_tags: [] },
    ]);
    expect(bts[1].catalogs).toEqual([{ code: 'specimen', name: '标本运送', skill_tags: ['标本', '冷藏'] }]);
    // 两条查询都按租户过滤（RLS 之上的应用层铁底线）
    const params = h.calls.map((c) => c.params[0]);
    expect(params).toEqual([T, T]);
  });

  it('skill_tags 非法 jsonb（对象/标量/含非字符串元素）→ []，不炸端点', async () => {
    h.scripted = [
      { match: /FROM business_type_dict/, rows: [{ code: 'repair', name: '维修', sort: 0 }] },
      {
        match: /FROM fault_category/,
        rows: [
          { business_type: 'repair', code: 'bad1', name: '坏数据1', skill_tags: { not: 'array' } },
          { business_type: 'repair', code: 'bad2', name: '坏数据2', skill_tags: 'plain-string' },
          { business_type: 'repair', code: 'bad3', name: '坏数据3', skill_tags: ['ok', 123, null] },
        ],
      },
    ];
    const r = await get('/meta/intake-options');
    expect(r.status).toBe(200);
    const bts = r.body.business_types as Array<{ catalogs: Array<{ skill_tags: string[] }> }>;
    expect(bts[0].catalogs.map((c) => c.skill_tags)).toEqual([[], [], ['ok']]);
  });

  it('空配置（无业务类型）→ business_types: []（FE 回落内置兜底，预期行为）', async () => {
    h.scripted = []; // 全部查询落空 rows: []
    const r = await get('/meta/intake-options');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.business_types).toEqual([]);
  });
});

describe('basicData business_type 类型（走 TYPES 通用逻辑，075）', () => {
  it('POST → 201；GET 列表可搜；PUT 可改 enabled；DELETE 可删', async () => {
    // POST（admin + dev 模式：requirePermission 恒放行，无 role_permission 查询）
    h.scripted = [
      { match: /INSERT INTO business_type_dict/, rows: [{ id: 'bt-1', code: 'escort', name: '陪检', sort: 30, enabled: true }] },
    ];
    const created = await send('POST', '/basic-data/business_type', { code: 'escort', name: '陪检', sort: 30 });
    expect(created.status).toBe(201);
    expect((created.body.item as any).code).toBe('escort');
    const ins = h.calls.find((c) => c.sql.includes('INSERT INTO business_type_dict'))!;
    // enabled 未提供 → 不写该列，让 DB DEFAULT true 生效（INSERT 语义干净）
    expect(ins.sql).not.toMatch(/enabled/);
    expect(ins.params).toContain('escort');

    // GET 列表（q 搜索只落 name/code/remark 三个文本列，不含 numeric sort）
    h.scripted = [{ match: /FROM business_type_dict/, rows: [{ id: 'bt-1', code: 'escort', name: '陪检' }] }];
    const list = await get('/basic-data/business_type?q=%E9%99%AA%E6%A3%80');
    expect(list.status).toBe(200);
    expect((list.body.items as any[]).length).toBe(1);
    const sel = h.calls.find((c) => c.sql.includes('FROM business_type_dict'))!;
    expect(sel.sql).toMatch(/name ILIKE/);
    expect(sel.sql).not.toMatch(/sort ILIKE/);

    // PUT 改 enabled（insertCols 含 enabled → 可更新；先命中 SELECT 当前行，再 UPDATE）
    h.scripted = [
      { match: /SELECT \* FROM business_type_dict/, rows: [{ id: 'bt-1', code: 'escort', name: '陪检', enabled: true }] },
      { match: /UPDATE business_type_dict/, rows: [{ id: 'bt-1', enabled: false }] },
    ];
    const updated = await send('PUT', '/basic-data/business_type/bt-1', { enabled: false });
    expect(updated.status).toBe(200);
    expect((updated.body.item as any).enabled).toBe(false);

    // DELETE
    h.scripted = [{ match: /DELETE FROM business_type_dict/, rows: [], rowCount: 1 }];
    const del = await send('DELETE', '/basic-data/business_type/bt-1');
    expect(del.status).toBe(200);
    expect((del.body as any).deleted).toBe(1);
  });

  it('DELETE 不存在 id → 404（通用逻辑 NOT_FOUND 分支）', async () => {
    h.scripted = []; // DELETE 落空 rowCount=0
    const del = await send('DELETE', '/basic-data/business_type/nope');
    expect(del.status).toBe(404);
    expect(del.body.ok).toBe(false);
  });

  it('name 缺失 → 422（schema：name 必填）', async () => {
    const r = await send('POST', '/basic-data/business_type', { code: 'x' });
    expect(r.status).toBe(422);
  });
});

describe('faultCategory 业务类型/技能标签扩展（075）', () => {
  it('POST 带 business_type/skill_tags → 写入并读出；GET 列表新列自然带出', async () => {
    h.scripted = [
      {
        match: /INSERT INTO fault_category/,
        rows: [{ id: 'fc-1', code: 'specimen', name: '标本运送', business_type: 'transport', skill_tags: ['标本', '冷藏'] }],
      },
    ];
    const created = await send('POST', '/fault-categories', {
      code: 'specimen', name: '标本运送', business_type: 'transport', skill_tags: ['标本', '冷藏'],
    });
    expect(created.status).toBe(201);
    expect((created.body.item as any).business_type).toBe('transport');
    expect((created.body.item as any).skill_tags).toEqual(['标本', '冷藏']);
    const ins = h.calls.find((c) => c.sql.includes('INSERT INTO fault_category'))!;
    expect(ins.sql).toMatch(/business_type/);
    expect(ins.sql).toMatch(/skill_tags/);
    // jsonb 以 JSON 字符串参数下发
    expect(ins.params).toContain(JSON.stringify(['标本', '冷藏']));

    // 不带新列 → 动态列不出现（undefined=不写该列）
    h.scripted = [{ match: /INSERT INTO fault_category/, rows: [{ id: 'fc-2' }] }];
    await send('POST', '/fault-categories', { code: 'plain', name: '普通目录' });
    const ins2 = h.calls.filter((c) => c.sql.includes('INSERT INTO fault_category'))[1]; // 取第二次 INSERT
    expect(ins2.sql).not.toMatch(/business_type/);
    expect(ins2.sql).not.toMatch(/skill_tags/);

    // GET 列表 SELECT *（新列自然带出，列表逻辑不改）
    h.scripted = [{
      match: /FROM fault_category/,
      rows: [{ id: 'fc-1', code: 'specimen', business_type: 'transport', skill_tags: ['标本'] }],
    }];
    const list = await get('/fault-categories');
    expect(list.status).toBe(200);
    expect((list.body.items as any[])[0].business_type).toBe('transport');
  });

  it('PUT 更新 skill_tags → COALESCE 语义带上两列', async () => {
    h.scripted = [
      { match: /SELECT \* FROM fault_category WHERE id/, rows: [{ id: 'fc-1' }] },
      { match: /UPDATE fault_category/, rows: [{ id: 'fc-1', skill_tags: ['新标签'] }] },
    ];
    const updated = await send('PUT', '/fault-categories/fc-1', { skill_tags: ['新标签'] });
    expect(updated.status).toBe(200);
    expect((updated.body.item as any).skill_tags).toEqual(['新标签']);
    const upd = h.calls.find((c) => c.sql.includes('UPDATE fault_category'))!;
    expect(upd.sql).toMatch(/business_type=COALESCE/);
    expect(upd.sql).toMatch(/skill_tags=COALESCE/);
  });
});
