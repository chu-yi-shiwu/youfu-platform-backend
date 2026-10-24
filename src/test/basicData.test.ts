// basicData.test.ts —— 注册制批次一 P0-2：location/reporter 两类字典 + 引擎三项修复回归。
// 用 express app + node fetch 真跑路由（mock withTenantClient 假 client，脚本化 SQL 响应），
// 覆盖：CRUD / 非法手机号 422 / 撞码 409（预检路径）/ 搜索 SQL 不含 uuid 列（防 500）/ 删除报修人置空引用。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// ---- mock DB：脚本化 query 路由 + 事务日志 ----
const calls: { sql: string; params: unknown[] }[] = [];
const txLog: string[] = [];
let scripted: { match: RegExp; rows: any[]; rowCount?: number }[] = [];
// T8 第十二批：导出租金守卫要测「角色被拒 / 授权放行」，role 与 authMode 必须可调。
// 归位值取既有用例原写死的 admin + dev（hasPerm 对 dev 与 admin 均恒放行 ⇒ 既有用例零影响）。
let authRole: string = 'admin';
let authMode: 'dev' | 'prod' = 'dev';

function push(sql: string, params: unknown[] = []) {
  calls.push({ sql, params });
}

vi.mock('../db/pool.js', () => ({
  default: {},
  withTenantClient: async (_tenantId: string, fn: (client: any) => Promise<any>) => {
    txLog.push('BEGIN');
    const client = {
      query: async (sql: string, params: unknown[] = []) => {
        push(sql, params);
        for (const s of scripted) {
          if (s.match.test(sql)) return { rows: s.rows, rowCount: s.rowCount ?? s.rows.length };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    try {
      const out = await fn(client);
      txLog.push('COMMIT');
      return out;
    } catch (e) {
      txLog.push('ROLLBACK');
      throw e;
    }
  },
}));

import express from 'express';
import type { Server } from 'node:http';
import basicDataRouter from '../routes/basicData.js';
import { errorMiddleware } from '../middleware/error.js';

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.locals.auth = { tenantId: 't1', role: authRole, authMode, userId: 'u1', requestId: 'test' };
  next();
});
app.use(basicDataRouter);
app.use(errorMiddleware);

let server: Server;
let base = '';

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  calls.length = 0;
  txLog.length = 0;
  scripted = [];
  authRole = 'admin';
  authMode = 'dev'; // 归位：T8 第十二批导出用例会切 prod + worker
});

describe('location / reporter CRUD', () => {
  it('POST location：201 建档（uuid 引用合法）', async () => {
    scripted = [
      { match: /INSERT INTO location_dict/, rows: [{ id: 'loc-1', code: '3F-A01', name: '三楼会议室' }] },
    ];
    const r = await fetch(`${base}/basic-data/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '3F-A01', name: '三楼会议室', category: '房间', default_reporter_id: '89e859b5-c822-4207-8fc9-27624bc0fd6c' }),
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.item.code).toBe('3F-A01');
    // 撞码预检先跑（uniqueCode），再 INSERT
    const sqls = calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes('SELECT 1 FROM location_dict'))).toBe(true);
    expect(sqls.some((s) => s.includes('INSERT INTO location_dict'))).toBe(true);
  });

  it('POST reporter：201；非法手机号 → 422；非法 uuid 引用 → 422', async () => {
    scripted = [{ match: /INSERT INTO reporter_dict/, rows: [{ id: 'rep-1', code: 'zhangsan', name: '张三', phone: '13800001234' }] }];
    const ok = await fetch(`${base}/basic-data/reporter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'zhangsan', name: '张三', phone: '13800001234', role: '维修工' }),
    });
    expect(ok.status).toBe(201);

    const badPhone = await fetch(`${base}/basic-data/reporter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'x1', name: '李四', phone: '12345' }),
    });
    expect(badPhone.status).toBe(422); // ZodError → errorMiddleware 422（既有口径）

    const badUuid = await fetch(`${base}/basic-data/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'X-1', name: 'X', default_reporter_id: 'not-a-uuid' }),
    });
    expect(badUuid.status).toBe(422);
  });

  it('POST location 撞码：预检命中 → 409，且不执行 INSERT', async () => {
    scripted = [{ match: /SELECT 1 FROM location_dict/, rows: [{ '?column?': 1 }] }];
    const r = await fetch(`${base}/basic-data/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '3F-A01', name: '重复编号' }),
    });
    expect(r.status).toBe(409);
    const body = (await r.json()) as any;
    expect(body.code).toBe('CONFLICT');
    expect(calls.some((c) => c.sql.includes('INSERT INTO location_dict'))).toBe(false);
  });

  it('PUT reporter 可更新 phone/role', async () => {
    scripted = [
      { match: /SELECT \* FROM reporter_dict/, rows: [{ id: 'rep-1', code: 'zhangsan', name: '张三' }] },
      { match: /UPDATE reporter_dict/, rows: [{ id: 'rep-1', phone: '13900005678' }] },
    ];
    const r = await fetch(`${base}/basic-data/reporter/rep-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '13900005678' }),
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).item.phone).toBe('13900005678');
  });
});

describe('引擎修复①：搜索列收敛（uuid/numeric 列不进 ILIKE，防 500）', () => {
  it('location 搜索 SQL 只含 code/name/category，不含 default_reporter_id', async () => {
    const r = await fetch(`${base}/basic-data/location?q=%E4%BC%9A%E8%AE%AE%E5%AE%A4`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).items).toEqual([]);
    const searchSql = calls.find((c) => c.sql.includes('ILIKE'))!.sql;
    expect(searchSql).toContain('name ILIKE');
    expect(searchSql).toContain('code ILIKE');
    expect(searchSql).toContain('category ILIKE');
    expect(searchSql).not.toContain('default_reporter_id ILIKE');
  });

  it('reporter 搜索含 phone；priority_dict 搜索不含 numeric 列 sort', async () => {
    await fetch(`${base}/basic-data/reporter?q=zhang`);
    const repSql = calls.find((c) => c.sql.includes('ILIKE'))!.sql;
    expect(repSql).toContain('phone ILIKE');

    await fetch(`${base}/basic-data/priority_dict?q=urgent`);
    const priSql = calls.find((c) => c.sql.includes('ILIKE') && c.sql.includes('FROM priority_dict'))!.sql;
    expect(priSql).toContain('name ILIKE');
    expect(priSql).not.toContain('sort ILIKE');
  });
});

describe('引擎修复③：删除报修人联动置空引用', () => {
  it('DELETE reporter 成功后同事务 UPDATE location_dict 置 NULL', async () => {
    scripted = [{ match: /DELETE FROM reporter_dict/, rows: [], rowCount: 1 }];
    const r = await fetch(`${base}/basic-data/reporter/rep-1`, { method: 'DELETE' });
    expect(r.status).toBe(200);
    const upd = calls.find((c) => c.sql.includes('UPDATE location_dict SET default_reporter_id = NULL'));
    expect(upd).toBeDefined();
    expect(upd!.params[1]).toBe('rep-1');
    expect(txLog).toEqual(['BEGIN', 'COMMIT']); // 同事务，无回滚
  });

  it('DELETE location 不触发联动 UPDATE', async () => {
    scripted = [{ match: /DELETE FROM location_dict/, rows: [], rowCount: 1 }];
    const r = await fetch(`${base}/basic-data/location/loc-1`, { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(calls.some((c) => c.sql.includes('UPDATE location_dict'))).toBe(false);
  });

  it('DELETE 不存在的 id → 404 且无联动', async () => {
    scripted = [{ match: /DELETE FROM reporter_dict/, rows: [], rowCount: 0 }];
    const r = await fetch(`${base}/basic-data/reporter/nope`, { method: 'DELETE' });
    expect(r.status).toBe(404);
    expect(calls.some((c) => c.sql.includes('UPDATE location_dict'))).toBe(false);
  });
});

describe('T8 第十二批 · 基础数据 CSV 导出权限收敛（requireConfigRole → basicdata.edit）', () => {
  // 改前：requireConfigRole 是同步角色白名单（admin/operator），**不查 role_permission**
  //      ⇒ 租户授不授权都一个样。改后走 requirePermission ⇒ 可配置。
  it('A 组：worker（prod · 无授权）→ GET /basic-data/location/export 403', async () => {
    authMode = 'prod'; // 🔴 dev 下 requirePermission 恒放行 ⇒ 不切 prod 这条 403 是恒绿的假绿
    authRole = 'worker';
    const r = await fetch(`${base}/basic-data/location/export`);
    expect(r.status).toBe(403);
  });

  // B 组 = 收敛的全部价值：改前授 basicdata.edit 给 worker 也放不了行（守卫根本不查权限表）。
  it('B 组：worker 经 role_permission 授 basicdata.edit → 200（BOM + 真查 location_dict）', async () => {
    authMode = 'prod';
    authRole = 'worker';
    scripted = [
      { match: /SELECT perm FROM role_permission/, rows: [{ perm: 'basicdata.edit' }] },
      { match: /SELECT \* FROM location_dict/, rows: [{ id: 'loc-1', code: '3F-A01', name: '三楼会议室', category: '房间' }] },
    ];
    const r = await fetch(`${base}/basic-data/location/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    // BOM 必须看原始字节：text() 的 UTF-8 解码会剥掉 BOM
    const buf = new Uint8Array(await r.arrayBuffer());
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]);
    // 守卫移入 withTenantClient 后，同连接查询序列变了 ⇒ 按 SQL 定位，不写死下标（骨架 §2.3 坑三）
    expect(calls.some((c) => c.sql.includes('SELECT * FROM location_dict'))).toBe(true);
  });
});
