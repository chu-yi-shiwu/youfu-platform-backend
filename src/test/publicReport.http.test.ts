// publicReport.http.test.ts —— C 端免登录报修入口 HTTP 测试（#930 审计补缺）。
// 背景：publicReport.ts 是零鉴权直接暴露公网的核心入口（690 行、12 端点），此前 vitest 覆盖为 0，
// 回归风险集中于此。本文件覆盖：repair-report 主流程（DMR 种子→服务端补全）、幂等重放回原
// view_token（🔴 审查修复回归护栏）、机构 404、配额 429、repair-status 查询、fault-categories。
// 模式复用 settlement.http.test.ts：vi.mock 池与重依赖，express 真 handler + errorMiddleware。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ---- 依赖打桩：pool（外层查 registry/配额）+ withTenantClient（注入 fakeClient）----
const fakeClient = {
  query: vi.fn(async (text: unknown) => {
    const sql = String(text);
    if (sql.includes('fault_category') && sql.includes('enabled = true')) {
      return { rows: [{ id: 'cat-1', name: '空调' }, { id: 'cat-2', name: '水电' }], rowCount: 2 };
    }
    return { rows: [], rowCount: 0 } as any;
  }) as any,
};
const poolQuery = vi.fn(async (text: unknown, params?: unknown[]) => {
  const sql = String(text);
  if (sql.includes('tenant_registry')) {
    const org = params?.[0];
    if (org === 't-nope') return { rows: [], rowCount: 0 };
    return { rows: [{ tenant_id: org, name: '测试机构', category: 'other', quota: null }], rowCount: 1 };
  }
  if (sql.includes('count(*)::int AS c')) return { rows: [{ c: 0 }], rowCount: 1 }; // 配额默认未超
  return { rows: [], rowCount: 0 };
});

vi.mock('../db/pool.js', () => ({
  default: { query: (...a: unknown[]) => poolQuery(...(a as [unknown, unknown[]])) },
  withTenantClient: async (_tid: string, fn: (c: unknown) => unknown) => fn(fakeClient),
  assertSafeTenantId: (t: string) => t,
}));
vi.mock('../repo/ticket.js', () => ({
  createWithIdem: vi.fn(),
}));
vi.mock('../routes/workOrder.js', () => ({
  autoDispatchAfterCreate: vi.fn(async () => null),
}));
vi.mock('../services/llm.js', () => ({
  llmInferCategory: vi.fn(async () => null),
}));
vi.mock('../repo/tenantSettings.js', () => ({
  getLlmEnabled: vi.fn(async () => false),
}));
vi.mock('../scan.js', () => ({
  resolveScanFromDb: vi.fn(async () => ({ asset: { resolved: false, qr: '' } })),
}));
vi.mock('../services/wechat.js', () => ({
  downloadMedia: vi.fn(),
}));
vi.mock('../services/wechatMp.js', () => ({
  mpConfigured: false,
  decryptPhoneCode: vi.fn(),
  genMpCode: vi.fn(),
}));

import publicReportRouter from '../routes/publicReport.js';
import { createWithIdem } from '../repo/ticket.js';
import { errorMiddleware } from '../middleware/error.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/v1', publicReportRouter);
app.use((err: unknown, _q: express.Request, _r: express.Response, n: express.NextFunction) => { console.error('[test-500]', (err as Error)?.message?.slice(0, 200)); n(err); });
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
const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const get = (p: string) => fetch(base + p);

describe('POST /public/repair-report（免登录报修主流程）', () => {
  it('①机构不存在 → 404 ORG_404', async () => {
    const r = await post('/public/repair-report', { org: 't-nope', description: '空调坏了', consent: true });
    expect(r.status).toBe(404);
    const j = (await r.json()) as any;
    expect(j.code).toBe('ORG_404');
  });

  it('②缺 org → 422（zod 校验）', async () => {
    const r = await post('/public/repair-report', { description: '空调坏了', consent: true });
    expect(r.status).toBe(422);
  });

  it('②b consent 缺失 → 422（DMR 铁律：隐私授权硬拒，schema 必填）', async () => {
    const r = await post('/public/repair-report', { org: 't-demo', description: '空调坏了' });
    expect(r.status).toBe(422);
  });

  it('③正常种子提交 → 201，服务端补全分类/标题/合规留痕（DMR 规则引擎真跑）', async () => {
    // createWithIdem 默认实现：created=true + 新 token（幂等重放的覆盖见 ④）
    (createWithIdem as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      row: { id: 'wo-new', order_no: 'WO_NEW', status: 'draft', ext: { public_view_token: 'tok-' + Math.random().toString(36).slice(2, 10) } },
      created: true, catalogName: '空调', priority: 'normal', assetName: null, scanResolved: false, location: '待核实', dispatch: null,
    }));
    const r = await post('/public/repair-report', { org: 't-demo', description: '会议室空调不制冷，热得受不了', consent: true });
    expect(r.status).toBe(201);
    const j = (await r.json()) as any;
    expect(j.ok).toBe(true);
    // storedToken 链路：优先回读 createWithIdem 返回的 ext.public_view_token（mock 值）
    expect(j.view_token).toMatch(/^tok-[0-9a-z]+$/);
    expect(j.filled.category).toBe('空调'); // resolveFaultCategory 真函数：描述含分类名精确命中
    expect(['urgent', 'normal', 'low']).toContain(j.filled.priority);
    expect(j.org_name).toBe('测试机构');
    // createWithIdem 收到的 ext 断言：consent 硬留痕 + view_token + 来源标记
    const arg = (createWithIdem as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as any;
    expect(arg.source).toBe('public_report');
    expect(arg.ext.consent).toBe(true);
    expect(arg.ext.retention.days).toBeGreaterThan(0);
    // #935 拆分后跨模块契约：route 生成的 view_token（64 hex）必须落进 createWithIdem 的 ext
    //（幂等重放回原 token 的前提——落库与响应同源；曾用变异 '' 验证此断言可抓）
    expect(arg.ext.public_view_token).toMatch(/^[0-9a-f]{48}$/); // crypto.randomBytes(24).hex = 48 字符
    
    expect(arg.ext.inferred.category).toBe('空调');
  });

  it('④幂等重放 → 200 且回原 view_token（🔴 审查修复回归：重复提交不断链）', async () => {
    (createWithIdem as ReturnType<typeof vi.fn>).mockReset();
    // 第一次：created=true
    (createWithIdem as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      row: { id: 'wo-1', order_no: 'WO_A', status: 'draft', ext: { public_view_token: 'tok-original' } },
      created: true,
      catalogName: '空调',
      priority: 'normal',
      assetName: null,
      scanResolved: false,
      location: '待核实',
      dispatch: null,
    });
    const key = 'idem-' + Math.random();
    const r1 = await post('/public/repair-report', { org: 't-demo', description: '空调坏了', consent: true }, { 'Idempotency-Key': key });
    expect(r1.status).toBe(201);
    // 第二次同 key：created=false（返回原工单）
    (createWithIdem as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      row: { id: 'wo-1', order_no: 'WO_A', status: 'draft', ext: { public_view_token: 'tok-original' } },
      created: false,
      catalogName: '空调',
      priority: 'normal',
      assetName: null,
      scanResolved: false,
      location: '待核实',
      dispatch: null,
    });
    const r2 = await post('/public/repair-report', { org: 't-demo', description: '空调坏了', consent: true }, { 'Idempotency-Key': key });
    expect(r2.status).toBe(200);
    const j2 = (await r2.json()) as any;
    expect(j2.view_token).toBe('tok-original'); // 必须回原 token，不能是新生成的
  });

  it('⑤org 级每日配额超限 → 429 QUOTA_001', async () => {
    // 覆盖两次调用：registry 校验 + 配额计数（Once 只盖一次，第二次会落到主实现 c=0）
    poolQuery.mockImplementation((async (text: unknown) => {
      if (String(text).includes('count(*)::int AS c')) return { rows: [{ c: 500 }], rowCount: 1 };
      if (String(text).includes('tenant_registry'))
        return { rows: [{ tenant_id: 't-demo', name: '测试机构', category: 'other', quota: { repair_daily: 500 } }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }) as any);
    const r = await post('/public/repair-report', { org: 't-demo', description: '空调坏了', consent: true });
    expect(r.status).toBe(429);
    const j = (await r.json()) as any;
    expect(j.code).toBe('QUOTA_001');
    poolQuery.mockImplementation(async (...a: unknown[]) => {
      const sql = String(a[0]);
      if (sql.includes('tenant_registry')) {
        const org = (a[1] as unknown[])?.[0];
        if (org === 't-nope') return { rows: [], rowCount: 0 };
        return { rows: [{ tenant_id: org, name: '测试机构', category: 'other', quota: null }], rowCount: 1 };
      }
      if (sql.includes('count(*)::int AS c')) return { rows: [{ c: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  });
});

describe('GET /public/repair-status（免登录进度查询）', () => {
  it('⑥缺参数 → 422', async () => {
    const r = await get('/public/repair-status?org=t-demo');
    expect(r.status).toBe(422);
  });

  it('⑦凭单号查到 → 200 且只回白名单字段', async () => {
    fakeClient.query.mockImplementationOnce(async (text: unknown) => {
      expect(String(text)).toContain('order_no = $2');
      return {
        rows: [{ order_no: 'WO_A', status: 'processing', title: '空调维修', location: '待核实', created_at: 't', updated_at: 't' }],
        rowCount: 1,
      };
    });
    const r = await get('/public/repair-status?org=t-demo&order_no=WO_A');
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.item.order_no).toBe('WO_A');
    expect(j.item).not.toHaveProperty('contact'); // 电话等敏感列绝不带出
  });

  it('⑧查不到 → 404 NOT_FOUND', async () => {
    const r = await get('/public/repair-status?org=t-demo&order_no=WO_NONE');
    expect(r.status).toBe(404);
    const j = (await r.json()) as any;
    expect(j.code).toBe('NOT_FOUND');
  });
});

describe('GET /public/fault-categories（报修页分类下拉）', () => {
  it('⑨返回租户分类字典', async () => {
    const r = await get('/public/fault-categories?org=t-demo');
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(JSON.stringify(j)).toContain('空调');
  });
});
