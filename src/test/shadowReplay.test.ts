// 影子回放只读出口（任务 #356 解挂判据）—— 口径锚 + 达标锚 + 端点锚
//
// 【为什么必须锚住口径】
//   category 的 matched 是 INSERT 当场写好的，从不写 resolved_at；dispatch 反过来
//   只有派单回填才写 resolved_at。两条影子**消解口径不同**。曾有人（我）按
//   resolved_at 统一统计，得出「category 零消解 = 飞轮断点」的错误结论；实测按正确
//   口径 category 命中率 0.841 已达标。口径错一次，结论就反一次，所以这里用真库钉死。
//
// 【为什么空集必须判不达标】
//   没有样本 ≠ 达标。新租户上线第一天若无任何影子数据却显示"达标"，等于给开
//   MODEL_AUTO_TUNE 发绿灯——那是假绿。与仓内护栏"空集通过不算通过"同一条纪律。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import {
  getShadowReplayStats,
  summarizeShadowReplay,
  shadowTuneThresholds,
  type ShadowReplayRow,
} from '../services/k2Shadow.js';

// ---------------- A. 真库口径验证 ----------------
// 只建 065 的核心列（不建 RLS policy——它依赖 youfu_app 角色与 app_tenant_id()，PGlite 里没有）。
const DDL = `
CREATE TABLE ai_shadow_suggestions (
  id            bigserial PRIMARY KEY,
  tenant_id     text NOT NULL,
  work_order_id text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('category','dispatch')),
  suggested     text NOT NULL DEFAULT '',
  suggested_by  text NOT NULL DEFAULT 'k2',
  actual        text,
  matched       boolean,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);`;

async function freshDb() {
  const db = new PGlite();
  await db.exec(DDL);
  return db;
}

describe('影子回放 · SQL 口径（真库，不用 mock）', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await freshDb();
    // category：3 行 —— 命中 1 / 判定未命中 1 / 未判定 1（matched IS NULL）
    await db.exec(`
      INSERT INTO ai_shadow_suggestions (tenant_id, work_order_id, kind, suggested, actual, matched, created_at) VALUES
        ('t1','wo1','category','电梯故障','电梯故障',true,  now()),
        ('t1','wo2','category','电梯故障','空调故障',false, now()),
        ('t1','wo3','category','电梯故障',NULL,      NULL,  now());
      -- dispatch：3 行 —— 已消解 2（命中 1）、未消解 1
      INSERT INTO ai_shadow_suggestions (tenant_id, work_order_id, kind, suggested, actual, matched, created_at, resolved_at) VALUES
        ('t1','wo1','dispatch','w-1','w-1',true,  now(), now()),
        ('t1','wo2','dispatch','w-1','w-2',false, now(), now()),
        ('t1','wo3','dispatch','w-1',NULL, NULL,  now(), NULL);
      -- 另一租户（验证 tenant_id 过滤不是摆设）
      INSERT INTO ai_shadow_suggestions (tenant_id, work_order_id, kind, suggested, matched, created_at) VALUES
        ('t2','wo9','category','x',true, now());
    `);
  });

  afterAll(async () => {
    await db.close();
  });

  it('category 已判定 = matched IS NOT NULL（不看 resolved_at）', async () => {
    const rows = await getShadowReplayStats(db as never, 't1');
    const cat = rows.find((r) => r.kind === 'category')!;
    expect(cat.total).toBe(3);
    expect(cat.judged).toBe(2); // 第三行 matched 为 NULL → 未判定
    expect(cat.hits).toBe(1);
    expect(cat.hitRate).toBeCloseTo(0.5, 5);
  });

  it('dispatch 已判定 = resolved_at IS NOT NULL', async () => {
    const rows = await getShadowReplayStats(db as never, 't1');
    const disp = rows.find((r) => r.kind === 'dispatch')!;
    expect(disp.total).toBe(3);
    expect(disp.judged).toBe(2); // 第三行未消解
    expect(disp.hits).toBe(1);
    expect(disp.hitRate).toBeCloseTo(0.5, 5);
  });

  it('只数本租户（tenant_id 过滤生效，不是全表聚合）', async () => {
    const rows = await getShadowReplayStats(db as never, 't1');
    expect(rows.map((r) => r.kind)).toEqual(['category', 'dispatch']);
    for (const r of rows) expect(r.total).toBe(3); // t2 那一行不进来
  });

  it('days 窗口过滤旧样本', async () => {
    await db.exec(`INSERT INTO ai_shadow_suggestions (tenant_id, work_order_id, kind, suggested, matched, created_at)
                   VALUES ('t1','wo-old','category','旧单',true, now() - interval '400 days')`);
    const all = await getShadowReplayStats(db as never, 't1');
    const recent = await getShadowReplayStats(db as never, 't1', 30);
    const catAll = all.find((r) => r.kind === 'category')!;
    const cat30 = recent.find((r) => r.kind === 'category')!;
    expect(catAll.total).toBe(4);
    expect(cat30.total).toBe(3); // 400 天前那行被窗口排除
  });

  it('命中率在未判定时是 null，不是 0（0 会被误读成"全错"）', async () => {
    const db2 = await freshDb();
    await db2.exec(`INSERT INTO ai_shadow_suggestions (tenant_id, work_order_id, kind, suggested)
                    VALUES ('t9','wo1','category','a')`);
    const rows = await getShadowReplayStats(db2 as never, 't9');
    expect(rows[0].judged).toBe(0);
    expect(rows[0].hitRate).toBeNull();
    await db2.close();
  });
});

// ---------------- B. 达标判定（纯函数） ----------------
const TH = { minJudged: 200, category: 0.6, dispatch: 0.5 };
const row = (kind: string, judged: number, hits: number, total?: number): ShadowReplayRow => ({
  kind,
  total: total ?? judged,
  judged,
  hits,
  hitRate: judged > 0 ? hits / judged : null,
  lastAt: null,
});

describe('影子回放 · 达标判定', () => {
  it('空集一律判不达标（新租户第一天不许显示达标）', () => {
    const r = summarizeShadowReplay([], TH);
    expect(r.ready).toBe(false);
    expect(r.reasons.join('|')).toMatch(/无任何影子样本/);
  });

  it('只有 category 达标、dispatch 缺席 → 整体不达标', () => {
    const r = summarizeShadowReplay([row('category', 300, 240)], TH);
    expect(r.ready).toBe(false);
    expect(r.reasons.join('|')).toMatch(/dispatch/);
  });

  it('两类都够样本够命中率 → 达标，且无理由', () => {
    const r = summarizeShadowReplay([row('category', 300, 240), row('dispatch', 300, 180)], TH);
    expect(r.ready).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('样本数不够 → 不达标（哪怕命中率 100%，200 条以下不作数）', () => {
    const r = summarizeShadowReplay([row('category', 10, 10), row('dispatch', 300, 180)], TH);
    expect(r.ready).toBe(false);
    expect(r.reasons.join('|')).toMatch(/10 条 < 要求的 200 条/);
  });

  it('命中率不够 → 不达标，理由给出三个数位（便于人读）', () => {
    const r = summarizeShadowReplay([row('category', 300, 100), row('dispatch', 300, 180)], TH);
    expect(r.ready).toBe(false);
    expect(r.reasons.join('|')).toMatch(/命中率 0\.333 < 要求的 0\.60/);
  });

  it('阈值来自 env（不是写死的魔法数字）', () => {
    const saved = process.env.SHADOW_MIN_JUDGED;
    process.env.SHADOW_MIN_JUDGED = '50';
    try {
      expect(shadowTuneThresholds().minJudged).toBe(50);
    } finally {
      if (saved === undefined) delete process.env.SHADOW_MIN_JUDGED;
      else process.env.SHADOW_MIN_JUDGED = saved;
    }
  });

  it('env 给非法值 → 回退默认（不静默接受 0 或负数把门槛降到没有）', () => {
    const saved = process.env.SHADOW_MIN_JUDGED;
    process.env.SHADOW_MIN_JUDGED = '-1';
    try {
      expect(shadowTuneThresholds().minJudged).toBe(200);
    } finally {
      if (saved === undefined) delete process.env.SHADOW_MIN_JUDGED;
      else process.env.SHADOW_MIN_JUDGED = saved;
    }
  });
});

// ---------------- C. 端点（真 HTTP） ----------------
const box = vi.hoisted(() => ({ rows: [] as Array<{ kind: string; total: number; judged: number; hits: number; last_at: null }> }));

vi.mock('../db/pool.js', () => ({
  default: { query: async () => ({ rows: [], rowCount: 0 }) },
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) =>
    fn({
      query: async (sql: string) => {
        const s = String(sql);
        if (s.includes('FROM ai_shadow_suggestions')) return { rows: box.rows, rowCount: box.rows.length };
        return { rows: [], rowCount: 0 };
      },
    }),
}));

import { errorMiddleware } from '../middleware/error.js';
import optimizeRouter from '../routes/optimize.js';
import { refreshAuthMode } from '../middleware/auth.js';

describe('GET /optimize/shadow-replay · 端点', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    process.env.AUTH_MODE = 'dev';
    refreshAuthMode();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { res: { locals: Record<string, unknown> } }).res = { locals: {} } as never;
      next();
    });
    // 与既有测试同款：直接注入 auth（本文件聚焦统计与端点结构，不测鉴权链路）
    app.use((req, res, next) => {
      res.locals.auth = { tenantId: 't-http', role: 'admin', userId: 'u1', requestId: 'r-1', authMode: 'dev' };
      next();
    });
    app.use('/api/v1', optimizeRouter);
    app.use(errorMiddleware);
    await new Promise<void>((r) => {
      server = app.listen(0, () => r());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    box.rows = [
      { kind: 'category', total: 132, judged: 132, hits: 111, last_at: null },
      { kind: 'dispatch', total: 83, judged: 45, hits: 8, last_at: null },
    ];
  });

  const call = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('200 且结构完整（kinds / ready / thresholds / reasons 都在）', async () => {
    const r = await call('/optimize/shadow-replay');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(Array.isArray(r.body.kinds)).toBe(true);
    expect(r.body.ready).toBe(false); // dispatch 45 条 < 200
    expect(Array.isArray(r.body.reasons)).toBe(true);
    expect((r.body.reasons as string[]).length).toBeGreaterThan(0);
  });

  it('如实标注阈值是建议值（不许把建议值伪装成既定标准）', async () => {
    const r = await call('/optimize/shadow-replay');
    const th = r.body.thresholds as Record<string, unknown>;
    expect(th.min_judged).toBe(200);
    expect(String(th.source)).toMatch(/建议值/);
  });

  it('窗口参数回显，days 非法 → 422（不是静默忽略）', async () => {
    const ok = await call('/optimize/shadow-replay?days=30');
    expect(ok.status).toBe(200);
    expect(ok.body.window_days).toBe(30);
    for (const bad of ['0', '-1', '9999', '1.5', 'abc']) {
      const r = await call(`/optimize/shadow-replay?days=${bad}`);
      expect(r.status, `days=${bad} 应被拒`).toBe(422);
    }
  });

  it('生产实测同款数据：category 0.841 达标 / dispatch 0.178 不达标', async () => {
    const r = await call('/optimize/shadow-replay');
    const kinds = r.body.kinds as Array<{ kind: string; hit_rate: number | null; judged: number; ready: boolean }>;
    const cat = kinds.find((k) => k.kind === 'category')!;
    const disp = kinds.find((k) => k.kind === 'dispatch')!;
    expect(cat.hit_rate!).toBeCloseTo(111 / 132, 3);
    expect(cat.ready).toBe(false); // 132 < 200，样本量不够
    expect(disp.hit_rate!).toBeCloseTo(8 / 45, 3);
    expect(disp.ready).toBe(false);
  });

  it('只读端点：不写库（SQL 里不出现 INSERT/UPDATE/DELETE）', async () => {
    const src = (await import('node:fs')).readFileSync('src/routes/optimize.ts', 'utf8');
    const start = src.indexOf("router.get('/optimize/shadow-replay'");
    const end = src.indexOf('// 查看某业务流当前状态图定义', start);
    const block = src.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(block).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/);
  });
});
