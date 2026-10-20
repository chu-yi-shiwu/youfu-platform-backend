// metaTenantLabels.http.test.ts —— 展示标签「租户覆盖」端点（GET /api/v1/meta/labels/me）。
// 解跨维度冲突 #1：流程状态名租户可自定义，但 073 的 label_dict 是平台级（无租户维度）⇒
// 自定义状态显示裸 key，且「两个租户同 key 不同译」无法表达。
//
// 真·express + 真 HTTP（仿 meta.http.test.ts 范式），mock 掉 DB 连接池。
// 覆盖：① 免鉴权访问 → 401（租户字典必须鉴权，不能走公开通道）
//       ② 平台字典 ∪ 租户覆盖，覆盖优先
//       ③ 租户自定义状态（平台字典没有）也能出中文名
//       ④ 多租户缓存分槽：A/B 两租户各取各的，不串号
//       ⑤ 零回归：/meta/labels 仍返回**纯平台字典**，不含任何租户覆盖
//       ⑥ 响应头 private（租户私有数据，禁止公共缓存）
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';

type Row = { scope: string; key: string; label: string };

const h = vi.hoisted(() => ({
  platformRows: [] as Row[],
  // tenantId -> 该租户的覆盖行
  overrides: {} as Record<string, Row[]>,
  withTenantCalls: [] as string[],
  // 覆盖查询实际下发的 SQL：mock 会忽略 SQL 直接回桩数据，若不把 SQL 记下来，
  // 「WHERE tenant_id=$1 被删掉」这类**越权读数全表**的回归在本文件里会**永远绿**（假锚）。
  overrideSql: [] as string[],
  overrideParams: [] as unknown[][],
}));

vi.mock('../db/pool.js', () => ({
  withTenantClient: async (tenantId: string, fn: (c: unknown) => Promise<unknown>) => {
    h.withTenantCalls.push(tenantId);
    return fn({
      query: async (sql: string, params: unknown[] = []) => {
        h.overrideSql.push(sql);
        h.overrideParams.push(params);
        return { rows: h.overrides[tenantId] ?? [], rowCount: (h.overrides[tenantId] ?? []).length };
      },
    });
  },
  assertSafeTenantId: (t: string) => t,
  default: {
    query: async () => ({ rows: h.platformRows, rowCount: h.platformRows.length }),
  },
}));

import metaRouter from '../routes/meta.js';

// 平台字典（073 种子子集）
const PLATFORM: Row[] = [
  { scope: 'wo_status', key: 'draft', label: '草稿' },
  { scope: 'wo_status', key: 'assigned', label: '已派单' },
  { scope: 'wo_status', key: 'processing', label: '处理中' },
  { scope: 'priority', key: 'urgent', label: '加急' },
];

// A 租户：把 draft 改叫「待提交」，并自定义一个平台没有的状态 rated
const OVERRIDE_A: Row[] = [
  { scope: 'wo_status', key: 'draft', label: '待提交' },
  { scope: 'wo_status', key: 'rated', label: '已评价' },
];
// B 租户：同 key 不同译
const OVERRIDE_B: Row[] = [{ scope: 'wo_status', key: 'draft', label: '暂存' }];

let server: Server;
let baseUrl = '';

beforeAll(async () => {
  const app = express();
  // 伪造鉴权：?tenant=T1 时注入 res.locals.auth，不传即未登录
  app.use((req, res, next) => {
    const t = (req.query.tenant as string) || '';
    if (t) (res.locals as Record<string, unknown>).auth = { tenantId: t, role: 'admin' };
    next();
  });
  app.use('/api/v1', metaRouter);
  app.use(errorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  h.platformRows = PLATFORM;
  h.overrides = { T1: OVERRIDE_A, T2: OVERRIDE_B };
  h.withTenantCalls = [];
  h.overrideSql = [];
  h.overrideParams = [];
});

async function getMe(tenant?: string) {
  const url = tenant ? `${baseUrl}/meta/labels/me?tenant=${tenant}` : `${baseUrl}/meta/labels/me`;
  const r = await fetch(url);
  const body = (await r.json()) as Record<string, unknown>;
  return { status: r.status, headers: r.headers, body };
}

async function getPublic() {
  const r = await fetch(`${baseUrl}/meta/labels`);
  const body = (await r.json()) as Record<string, unknown>;
  return { status: r.status, headers: r.headers, body };
}

describe('GET /api/v1/meta/labels/me（租户覆盖字典）', () => {
  it('未登录 → 401（租户字典不得走免鉴权通道）', async () => {
    const r = await getMe();
    expect(r.status).toBe(401);
  });

  it('200 且 平台字典 ∪ 租户覆盖，覆盖优先（draft: 草稿 → 待提交）', async () => {
    const r = await getMe('T1');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    const labels = r.body.labels as Record<string, Record<string, string>>;
    expect(labels.wo_status.draft).toBe('待提交');        // 被租户覆盖
    expect(labels.wo_status.assigned).toBe('已派单');      // 平台值保留
    expect(labels.priority.urgent).toBe('加急');           // 平台值保留
    // 覆盖查询必须带上租户身份（否则 RLS 下会拿空集，或越权读到别人的覆盖）
    expect(h.withTenantCalls).toContain('T1');
  });

  it('租户自定义状态（平台字典没有的 key）也能出中文名，不再是裸 key', async () => {
    const r = await getMe('T1');
    const labels = r.body.labels as Record<string, Record<string, string>>;
    expect(labels.wo_status.rated).toBe('已评价');
    expect(labels.wo_status.rated).not.toBe('rated');
  });

  it('多租户隔离：T1 与 T2 同 key 各取各的译名（缓存分槽，不串号）', async () => {
    const a = await getMe('T1');
    const b = await getMe('T2');
    const la = a.body.labels as Record<string, Record<string, string>>;
    const lb = b.body.labels as Record<string, Record<string, string>>;
    expect(la.wo_status.draft).toBe('待提交');
    expect(lb.wo_status.draft).toBe('暂存');
    // 反向再取一次（命中缓存路径）仍各自正确 —— 串号会在这里暴露
    const a2 = await getMe('T1');
    const la2 = a2.body.labels as Record<string, Record<string, string>>;
    expect(la2.wo_status.draft).toBe('待提交');
    expect(h.withTenantCalls).toContain('T2');
  });

  it('覆盖查询**在 SQL 里**按租户过滤（不是拉全表到内存再筛 —— 那样 RLS 形同虚设）', async () => {
    // 用**未被前面用例预热**的租户 T3：命中缓存时不会下发 SQL，那样断言会变成永远绿的假锚
    h.overrides.T3 = OVERRIDE_A;
    await getMe('T3');
    expect(h.overrideSql.length).toBeGreaterThan(0);
    for (const sql of h.overrideSql) {
      expect(sql).toMatch(/label_dict_tenant/);
      expect(sql).toMatch(/tenant_id\s*=\s*\$1/); // 服务端带租户条件
    }
    // 参数必须是**服务端取到的租户**，不是请求参数里带的（防越权读别人字典）
    expect(h.overrideParams[0]).toEqual(['T3']);
  });

  it('响应头 private（租户私有数据，禁止公共缓存共享）', async () => {
    const r = await getMe('T1');
    const cc = r.headers.get('cache-control') ?? '';
    expect(cc).toMatch(/private/i);
  });

  it('零回归：GET /meta/labels 逐值等于纯平台字典（一个 key 不多、一个 label 不改）', async () => {
    const pub = await getPublic();
    expect(pub.status).toBe(200);
    const labels = pub.body.labels as Record<string, Record<string, string>>;
    // 逐值对比：把平台行原样折成期望 map，任何混入/改写/丢失都会在这里红
    const expected: Record<string, Record<string, string>> = {};
    for (const r of PLATFORM) (expected[r.scope] ??= {})[r.key] = r.label;
    expect(labels).toEqual(expected);
    expect(labels.wo_status.draft).toBe('草稿');   // 未被 T1 的「待提交」污染
    expect(labels.wo_status.rated).toBeUndefined(); // 未混入租户自定义状态
    expect(pub.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('零回归：先访问 /meta/labels/me 再访问 /meta/labels，公开端点仍不被污染（顺序无关）', async () => {
    await getMe('T1'); // 先把租户覆盖读进内存（含缓存分槽写入）
    const pub = await getPublic();
    const labels = pub.body.labels as Record<string, Record<string, string>>;
    expect(labels.wo_status.draft).toBe('草稿');
    expect(Object.keys(labels.wo_status)).toEqual(['draft', 'assigned', 'processing']);
  });
});
