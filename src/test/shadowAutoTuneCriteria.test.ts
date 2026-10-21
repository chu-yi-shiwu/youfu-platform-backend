// shadowAutoTuneCriteria.test.ts —— 双口径改造（展示层正名 + AUTO_TUNE 一致性口径 + 时间窗切分）
// ─────────────────────────────────────────────────────────────────────────────
// 【为什么必须改造】
//   影子回放此前的 dispatch 口径测的是「人工派单可预测性」（历史相似单的人工 assignee
//   多数票 vs 本单实际派单结果），生产实测 0.171 离 0.5 很远——但那只说明人的派单
//   习惯难从相似单预测，是事实描述，不是缺陷。AUTO_TUNE 上线要回答的是另一个问题：
//   「按当前生效 dispatch_rule（经 AUTO_TUNE 写回后的规则）派单 vs 现网实际派单差多少」。
//   两个问题曾被同一个 0.5 阈值绑在一起，判据与验收目标错位。
//
// 本文件锁死四件事：
//   A 展示层正名：每个 kind 有人类可读口径名（metric_name/criteria_note），旧字段一个不丢；
//   B 新口径阈值 autoTuneDispatch（env SHADOW_AUTOTUNE_HITRATE，默认值是建议值）；
//   C 达标判定：新口径同样过 minJudged 门槛 + 空集判不达标；总门公式不回潮；
//   D/E 写入与统计：predicted=规则+模型算出、actual=派单回填；时间窗切分——只计入
//     「规则版本生成时间之后创建」的影子行（被预测的单若参与过该轮规则生成，则不计入，
//     同一批数据又当教材又当考卷，分数必虚高）。
//   F 迁移 100：kind CHECK 扩容 auto_tune_dispatch 且幂等。
//   G 端点：阈值/口径名/auto_tune_criteria 出现在响应里，既有结构不变。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shadowTuneThresholds,
  summarizeShadowReplay,
  getShadowReplayStats,
  getAutoTuneRuleVersionAt,
  recordAutoTuneShadow,
  recordShadowSuggestions,
  resolveDispatchShadow,
  type ShadowReplayRow,
  type ShadowTuneThresholds,
} from '../services/k2Shadow.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 完整阈值（含新口径）。默认值全部来自 shadowTuneThresholds() 的建议值口径。
const TH: ShadowTuneThresholds = { minJudged: 200, category: 0.6, dispatch: 0.5, autoTuneDispatch: 0.5 };

const row = (kind: string, judged: number, hits: number, total?: number): ShadowReplayRow => ({
  kind,
  total: total ?? judged,
  judged,
  hits,
  hitRate: judged > 0 ? hits / judged : null,
  lastAt: null,
});

// ─────────────────────────────────────────────────────────────────────────────
// A. 展示层正名（纯函数）
// ─────────────────────────────────────────────────────────────────────────────
describe('A. 展示层正名：口径名人类可读，旧字段一个不丢', () => {
  it('dispatch → 人工派单可预测性；category → 分类预测一致性；auto_tune_dispatch → AUTO_TUNE 派单一致性', () => {
    const r = summarizeShadowReplay(
      [row('category', 300, 240), row('dispatch', 300, 180), row('auto_tune_dispatch', 300, 180)],
      TH,
    );
    const byKind = Object.fromEntries(r.kinds.map((k) => [k.kind, k]));
    expect(byKind.dispatch.metric_name).toBe('人工派单可预测性');
    expect(byKind.category.metric_name).toBe('分类预测一致性');
    expect(byKind.auto_tune_dispatch.metric_name).toBe('AUTO_TUNE 派单一致性');
  });

  it('criteria_note 如实说明各口径测的是什么（不把可预测性伪装成规则质量）', () => {
    const r = summarizeShadowReplay([row('dispatch', 300, 180), row('auto_tune_dispatch', 300, 180)], TH);
    const byKind = Object.fromEntries(r.kinds.map((k) => [k.kind, k]));
    expect(String(byKind.dispatch.criteria_note)).toMatch(/人工派单|可预测性/);
    // 新口径注释必须点明：规则（含写回权重）+ 只计入规则版本生成后的行
    expect(String(byKind.auto_tune_dispatch.criteria_note)).toMatch(/dispatch_rule/);
    expect(String(byKind.auto_tune_dispatch.criteria_note)).toMatch(/规则版本生成/);
  });

  it('旧字段一个不丢（kind/total/judged/hits/hitRate/lastAt/threshold/hit_rate/ready/reasons 全在）', () => {
    const r = summarizeShadowReplay([row('dispatch', 300, 180)], TH);
    const d = r.kinds[0];
    for (const key of ['kind', 'total', 'judged', 'hits', 'hitRate', 'lastAt', 'threshold', 'hit_rate', 'ready', 'reasons'] as const) {
      expect(d, `dispatch 口径缺字段 ${key}`).toHaveProperty(key);
    }
    expect(d.hitRate).toBeCloseTo(0.6, 5);
    expect(d.hit_rate).toBeCloseTo(0.6, 5);
    expect(d.threshold).toBe(0.5);
    expect(r).toHaveProperty('ready');
    expect(r).toHaveProperty('reasons');
  });

  it('顶层 auto_tune_criteria 是 AUTO_TUNE 验收的单一状态通道（有数据时与 kind 条目一致）', () => {
    const r = summarizeShadowReplay([row('auto_tune_dispatch', 300, 180)], TH);
    expect(r.auto_tune_criteria.present).toBe(true);
    expect(r.auto_tune_criteria.kind).toBe('auto_tune_dispatch');
    expect(r.auto_tune_criteria.judged).toBe(300);
    expect(r.auto_tune_criteria.hitRate).toBeCloseTo(0.6, 5);
    expect(r.auto_tune_criteria.threshold).toBe(0.5);
    expect(r.auto_tune_criteria.ready).toBe(true);
    expect(r.auto_tune_criteria.reasons).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. 新口径阈值
// ─────────────────────────────────────────────────────────────────────────────
describe('B. 阈值：autoTuneDispatch', () => {
  it('默认 0.5（与 dispatch 同量级的建议值，尚无业务确认口径）', () => {
    expect(shadowTuneThresholds().autoTuneDispatch).toBe(0.5);
  });

  it('env SHADOW_AUTOTUNE_HITRATE 可覆盖（不是写死的魔法数字）', () => {
    const saved = process.env.SHADOW_AUTOTUNE_HITRATE;
    process.env.SHADOW_AUTOTUNE_HITRATE = '0.7';
    try {
      expect(shadowTuneThresholds().autoTuneDispatch).toBe(0.7);
    } finally {
      if (saved === undefined) delete process.env.SHADOW_AUTOTUNE_HITRATE;
      else process.env.SHADOW_AUTOTUNE_HITRATE = saved;
    }
  });

  it('env 非法值 → 回退默认（不静默接受 0 或负数把门槛降到没有）', () => {
    const saved = process.env.SHADOW_AUTOTUNE_HITRATE;
    process.env.SHADOW_AUTOTUNE_HITRATE = '-1';
    try {
      expect(shadowTuneThresholds().autoTuneDispatch).toBe(0.5);
    } finally {
      if (saved === undefined) delete process.env.SHADOW_AUTOTUNE_HITRATE;
      else process.env.SHADOW_AUTOTUNE_HITRATE = saved;
    }
  });

  it('env 非数值 → 回退默认', () => {
    const saved = process.env.SHADOW_AUTOTUNE_HITRATE;
    process.env.SHADOW_AUTOTUNE_HITRATE = 'abc';
    try {
      expect(shadowTuneThresholds().autoTuneDispatch).toBe(0.5);
    } finally {
      if (saved === undefined) delete process.env.SHADOW_AUTOTUNE_HITRATE;
      else process.env.SHADOW_AUTOTUNE_HITRATE = saved;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. 达标判定：新口径的 minJudged 门槛 + 空集判不达标
// ─────────────────────────────────────────────────────────────────────────────
describe('C. 达标判定：新口径同样过 minJudged 门槛，空集判不达标', () => {
  it('样本数不够 → 不达标（哪怕命中率 100%）', () => {
    const r = summarizeShadowReplay(
      [row('category', 300, 240), row('dispatch', 300, 180), row('auto_tune_dispatch', 199, 199)],
      TH,
    );
    const at = r.kinds.find((k) => k.kind === 'auto_tune_dispatch')!;
    expect(at.ready).toBe(false);
    expect(at.reasons.join('|')).toMatch(/199 条 < 要求的 200 条/);
  });

  it('够样本够命中率 → 达标', () => {
    const r = summarizeShadowReplay(
      [row('category', 300, 240), row('dispatch', 300, 180), row('auto_tune_dispatch', 300, 180)],
      TH,
    );
    const at = r.kinds.find((k) => k.kind === 'auto_tune_dispatch')!;
    expect(at.ready).toBe(true);
    expect(at.reasons).toEqual([]);
    expect(r.ready).toBe(true); // 三类都在场且都达标 → 总门开
  });

  it('命中率不够 → 不达标，理由给出三个数位', () => {
    const r = summarizeShadowReplay(
      [row('category', 300, 240), row('dispatch', 300, 180), row('auto_tune_dispatch', 300, 100)],
      TH,
    );
    const at = r.kinds.find((k) => k.kind === 'auto_tune_dispatch')!;
    expect(at.ready).toBe(false);
    expect(at.reasons.join('|')).toMatch(/命中率 0\.333 < 要求的 0\.50/);
  });

  it('空集（有行但零判定）→ 命中率不可计算 → 不达标（没有样本 ≠ 达标）', () => {
    const r = summarizeShadowReplay([row('auto_tune_dispatch', 0, 0, 5)], TH);
    const at = r.kinds.find((k) => k.kind === 'auto_tune_dispatch')!;
    expect(at.hitRate).toBeNull();
    expect(at.ready).toBe(false);
    expect(at.reasons.join('|')).toMatch(/不可计算/);
    // 顶层通道同样如实：不达标 + 说明无样本
    expect(r.auto_tune_criteria.ready).toBe(false);
    expect(r.auto_tune_criteria.present).toBe(true);
  });

  it('一行都没有（真·空集）→ auto_tune_criteria.present=false 且不达标（不许假绿）', () => {
    const r = summarizeShadowReplay([row('category', 300, 240), row('dispatch', 300, 180)], TH);
    expect(r.auto_tune_criteria.present).toBe(false);
    expect(r.auto_tune_criteria.ready).toBe(false);
    expect(r.auto_tune_criteria.reasons.join('|')).toMatch(/无任何影子样本/);
    // 存量总门公式不回潮：两类旧口径达标仍判 ready（新口径缺席不掺和总门）
    expect(r.ready).toBe(true);
  });

  it('总门空集纪律不变：一行都没有 → 整体不达标', () => {
    const r = summarizeShadowReplay([], TH);
    expect(r.ready).toBe(false);
    expect(r.reasons.join('|')).toMatch(/无任何影子样本/);
  });

  it('新口径不达标会拖垮总门（有数据即参与总门，kinds.every 语义）', () => {
    const r = summarizeShadowReplay(
      [row('category', 300, 240), row('dispatch', 300, 180), row('auto_tune_dispatch', 300, 100)],
      TH,
    );
    expect(r.ready).toBe(false);
    expect(r.reasons.join('|')).toMatch(/auto_tune_dispatch/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. 写入路径（fake client）：predicted 按「规则 + 模型」算，actual 走既有回填
// ─────────────────────────────────────────────────────────────────────────────
type RecordedCall = { sql: string; params: unknown[] };

function makeFakeClient(routes: Record<string, () => { rows: unknown[] }>) {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params: params ?? [] });
      for (const key of Object.keys(routes)) {
        if (sql.includes(key)) return routes[key]();
      }
      return { rows: [] };
    },
  } as never;
}

// 规则 + 工人 + 模型三件套。模型臂权重明显偏向 wk-b（wk-a 负载为 0 也赢不过臂权重差），
// 以此钉死「模型评分参与 predicted」——AUTO_TUNE 写回 rule.weight 的唯一生效通道就是它。
const RULE_VERSION = new Date('2026-10-01T00:00:00.000Z');
const autoTuneRoutes = {
  'SELECT business_type': () => ({ rows: [{ business_type: '水电维修', priority: 'normal' }] }),
  'max(updated_at)': () => ({ rows: [{ rule_v: RULE_VERSION, model_v: null }] }),
  'enabled = true': () => ({
    rows: [
      {
        id: 'rule-1',
        name: '水电规则',
        priority: 100,
        match_json: { business_type: '水电维修' },
        strategy_json: { type: 'skill_match' },
        weight: 1.5,
        score: 0,
      },
    ],
  }),
  'FROM worker': () => ({
    rows: [
      { id: 'wk-a', skill_tags: [], load: 0, active: true },
      { id: 'wk-b', skill_tags: [], load: 0, active: true },
    ],
  }),
  'model_state': () => ({
    rows: [
      {
        params: {
          arms: { '水电维修::wk-a': { weight: 0.1, pulls: 100 }, '水电维修::wk-b': { weight: 0.99, pulls: 100 } },
          alpha: 0.2,
          ucbC: 1.5,
          version: 3,
        },
      },
    ],
  }),
};

describe('D. 写入路径：recordAutoTuneShadow', () => {
  it('规则+模型可算出应派工人 → 落 auto_tune_dispatch 行（suggested=模型+规则选人，detail 带规则版本标识）', async () => {
    const client = makeFakeClient(autoTuneRoutes);
    const wrote = await recordAutoTuneShadow(client, 't-verification', 'wo-1', '水电维修');
    expect(wrote).toBe(true);
    const calls = (client as never as { calls: RecordedCall[] }).calls;
    const ins = calls.find((c) => c.sql.includes("'auto_tune_dispatch'"))!;
    expect(ins).toBeDefined();
    expect(ins.sql).toContain("'auto_tune'"); // suggested_by 如实标注口径来源（非 k2 相似度）
    expect(ins.params[0]).toBe('t-verification');
    expect(ins.params[1]).toBe('wo-1');
    expect(ins.params[2]).toBe('wk-b'); // predicted：臂权重 0.99 的 wk-b 胜出
    const detail = JSON.parse(String(ins.params[3]));
    expect(detail.rule_id).toBe('rule-1');
    expect(detail.rule_name).toBe('水电规则');
    expect(detail.rule_version_at).toBe(RULE_VERSION.toISOString()); // 当时的规则版本标识
    expect(detail.model_key).toBe('dispatch_score');
  });

  it('无规则也无模型（版本标识为空）→ 不落行（无可预测对象，不制造假数据）', async () => {
    const client = makeFakeClient({ 'max(updated_at)': () => ({ rows: [{ rule_v: null, model_v: null }] }) });
    const wrote = await recordAutoTuneShadow(client, 't-verification', 'wo-1', '水电维修');
    expect(wrote).toBe(false);
    const calls = (client as never as { calls: RecordedCall[] }).calls;
    expect(calls.some((c) => c.sql.includes('INSERT INTO ai_shadow_suggestions'))).toBe(false);
  });

  it('规则不命中本单（business_type 不符）→ 不落行', async () => {
    const routes = {
      ...autoTuneRoutes,
      'SELECT business_type': () => ({ rows: [{ business_type: '空调维修', priority: 'normal' }] }),
    };
    const client = makeFakeClient(routes);
    const wrote = await recordAutoTuneShadow(client, 't-verification', 'wo-1', '空调维修');
    expect(wrote).toBe(false);
  });

  it('规则命中但无 active 工人 → 选不出人 → 不落行', async () => {
    const routes = {
      ...autoTuneRoutes,
      'FROM worker': () => ({ rows: [{ id: 'wk-x', skill_tags: [], load: 0, active: false }] }),
    };
    const client = makeFakeClient(routes);
    const wrote = await recordAutoTuneShadow(client, 't-verification', 'wo-1', '水电维修');
    expect(wrote).toBe(false);
  });

  it('旁路自我隔离：任何查询炸错只吞错返回 false，绝不向上抛（影子失败不影响主链路）', async () => {
    const bomb = {
      async query() {
        throw new Error('shadow table missing');
      },
    } as never;
    await expect(recordAutoTuneShadow(bomb, 't-verification', 'wo-1', '水电维修')).resolves.toBe(false);
  });
});

describe('D2. 与既有影子同批触发点（recordShadowSuggestions 集成）', () => {
  const candidates = {
    rows: [
      { ref_id: 'w1', category: '水电维修', embedding: [1, 0], assignee_id: 'wk-a' },
      { ref_id: 'w2', category: '水电维修', embedding: [0.9, 0.1], assignee_id: 'wk-a' },
    ],
  };

  it('有规则时：category/dispatch/auto_tune_dispatch 三条影子同批落库，自愈回填覆盖新口径', async () => {
    const client = makeFakeClient({
      'FROM ai_case_embeddings': () => candidates,
      'SELECT business_type': () => ({ rows: [{ business_type: '水电维修', priority: 'normal' }] }),
      'SELECT assignee_id': () => ({ rows: [{ assignee_id: 'wk-a' }] }),
      'max(updated_at)': () => ({ rows: [{ rule_v: RULE_VERSION, model_v: null }] }),
      'enabled = true': autoTuneRoutes['enabled = true'],
      'FROM worker': autoTuneRoutes['FROM worker'],
      'model_state': autoTuneRoutes['model_state'],
    });
    await recordShadowSuggestions(client, 't-verification', 'wo-1', [1, 0], '水电维修');
    const calls = (client as never as { calls: RecordedCall[] }).calls;
    const inserts = calls.filter((c) => c.sql.includes('INSERT INTO ai_shadow_suggestions'));
    expect(inserts.length).toBe(3); // 旧两条一条不少，新口径并行新增
    expect(inserts.some((c) => c.sql.includes("'category'"))).toBe(true);
    expect(inserts.some((c) => c.sql.includes("'dispatch'"))).toBe(true);
    const at = inserts.find((c) => c.sql.includes("'auto_tune_dispatch'"))!;
    expect(at).toBeDefined();
    expect(at.params[2]).toBe('wk-b');
    // 自愈回填（建单已派单的时序竞态消除）：一条 UPDATE 同时覆盖 dispatch 与 auto_tune_dispatch
    const backfill = calls.find((c) => c.sql.includes('UPDATE') && c.sql.includes("kind = 'dispatch'"))!;
    expect(backfill).toBeDefined();
    expect(backfill.sql).toContain("kind = 'auto_tune_dispatch'");
    expect(backfill.params).toEqual(['t-verification', 'wo-1', 'wk-a']);
  });

  it('无规则时：仍只落旧两条影子（新口径不凑数）', async () => {
    const client = makeFakeClient({
      'FROM ai_case_embeddings': () => candidates,
      'FROM work_orders': () => ({ rows: [{ assignee_id: 'wk-a' }] }),
    });
    await recordShadowSuggestions(client, 't-verification', 'wo-1', [1, 0], '水电维修');
    const calls = (client as never as { calls: RecordedCall[] }).calls;
    const inserts = calls.filter((c) => c.sql.includes('INSERT INTO ai_shadow_suggestions'));
    expect(inserts.length).toBe(2);
  });
});

describe('D3. 回填路径覆盖新口径', () => {
  it('resolveDispatchShadow 一条 UPDATE 同时回填 dispatch 与 auto_tune_dispatch，仅命中未决行', async () => {
    const client = makeFakeClient({});
    await resolveDispatchShadow(client, 't-verification', 'wo-1', 'wk-b');
    const calls = (client as never as { calls: RecordedCall[] }).calls;
    expect(calls.length).toBe(1);
    expect(calls[0].sql).toContain("kind = 'dispatch'");
    expect(calls[0].sql).toContain("kind = 'auto_tune_dispatch'");
    expect(calls[0].sql).toContain('resolved_at IS NULL');
    expect(calls[0].params).toEqual(['t-verification', 'wo-1', 'wk-b']);
  });

  it('影子回填失败吞错仅告警——绝不影响主链路事务', async () => {
    const bomb = {
      async query() {
        throw new Error('shadow table missing');
      },
    } as never;
    await expect(resolveDispatchShadow(bomb, 't-verification', 'wo-1', 'wk-b')).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. 时间窗切分（PGlite 真库）：只计入「规则版本生成时间之后创建」的影子行
// ─────────────────────────────────────────────────────────────────────────────
const DDL = `
CREATE TABLE ai_shadow_suggestions (
  id            bigserial PRIMARY KEY,
  tenant_id     text NOT NULL,
  work_order_id text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('category','dispatch','auto_tune_dispatch')),
  suggested     text NOT NULL DEFAULT '',
  suggested_by  text NOT NULL DEFAULT 'k2',
  actual        text,
  matched       boolean,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);
CREATE TABLE dispatch_rule (
  id           text PRIMARY KEY,
  tenant_id    text NOT NULL,
  name         text NOT NULL,
  priority     int NOT NULL DEFAULT 100,
  match_json   jsonb NOT NULL DEFAULT '{}'::jsonb,
  strategy_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled      boolean NOT NULL DEFAULT true,
  weight       real NOT NULL DEFAULT 1.0,
  score        real NOT NULL DEFAULT 0.0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE model_state (
  id          bigserial PRIMARY KEY,
  tenant_id   text NOT NULL,
  model_key   text NOT NULL,
  version     int NOT NULL DEFAULT 1,
  params      jsonb NOT NULL DEFAULT '{}'::jsonb,
  trained_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE work_orders (
  id            text PRIMARY KEY,
  tenant_id     text NOT NULL,
  business_type text,
  priority      text NOT NULL DEFAULT 'normal'
);
CREATE TABLE worker (
  id         text PRIMARY KEY,
  tenant_id  text NOT NULL,
  skill_tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  load       int NOT NULL DEFAULT 0,
  active     boolean NOT NULL DEFAULT true
);`;

async function freshDb() {
  const db = new PGlite();
  await db.exec(DDL);
  return db;
}

/** 造一条规则版本（updated_at 可控，模拟 AUTO_TUNE 写回时刻）。 */
async function seedRule(db: PGlite, updatedAtSql: string) {
  await db.query(
    `INSERT INTO dispatch_rule (id, tenant_id, name, priority, match_json, strategy_json, weight, updated_at)
     VALUES ('rule-1','t1','水电规则',100,'{"business_type":"repair"}','{"type":"skill_match"}',1.5,${updatedAtSql})`,
  );
}

async function seedShadow(
  db: PGlite,
  kind: string,
  workOrderId: string,
  suggested: string,
  createdAtSql: string,
  actual?: string,
) {
  await db.query(
    `INSERT INTO ai_shadow_suggestions (tenant_id, work_order_id, kind, suggested, suggested_by, actual, matched, created_at, resolved_at)
     VALUES ('t1',$1,$2,$3,'auto_tune',$4,($3 = $4),${createdAtSql}, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END)`,
    [workOrderId, kind, suggested, actual ?? null],
  );
}

describe('E. 时间窗切分（真库）', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it('规则版本生成前的单不计入；生成后的单计入（防同一批数据又当教材又当考卷）', async () => {
    await db.exec(`DELETE FROM ai_shadow_suggestions WHERE tenant_id='t1'; DELETE FROM dispatch_rule WHERE tenant_id='t1'; DELETE FROM model_state WHERE tenant_id='t1';`);
    // 规则版本生成于 20 天前（AUTO_TUNE 写回时刻）
    await seedRule(db, `now() - interval '20 days'`);
    // 版本前创建的单（可能参与过该轮规则生成的训练数据）→ 不计入。
    // 该行判"未命中"（suggested≠actual）：窗口方向一旦搞反，它会把 hits 从 1 拖成 0，
    // 断言必然红——防止"两行命中结果相同、反转也测不出来"的盲区。
    await seedShadow(db, 'auto_tune_dispatch', 'wo-old', 'wk-a', `now() - interval '25 days'`, 'wk-b');
    // 版本后创建的单（真正的新考卷）→ 计入，且判命中
    await seedShadow(db, 'auto_tune_dispatch', 'wo-new', 'wk-b', `now() - interval '10 days'`, 'wk-b');

    const version = await getAutoTuneRuleVersionAt(db as never, 't1');
    expect(version).not.toBeNull();
    const rows = await getShadowReplayStats(db as never, 't1', undefined, version);
    const at = rows.find((r) => r.kind === 'auto_tune_dispatch')!;
    expect(at).toBeDefined();
    expect(at.total).toBe(1); // 版本前那行被整行排除，不是只排除回填
    expect(at.judged).toBe(1);
    expect(at.hits).toBe(1); // 只数版本后那行（命中）；版本前那行是未命中，不许混进来
    expect(at.hitRate).toBeCloseTo(1, 5);
  });

  it('不传版本标识 → 不加时间窗（存量调用行为逐字不变）', async () => {
    await db.exec(`DELETE FROM ai_shadow_suggestions WHERE tenant_id='t1'; DELETE FROM dispatch_rule WHERE tenant_id='t1'; DELETE FROM model_state WHERE tenant_id='t1';`);
    await seedRule(db, `now() - interval '20 days'`);
    await seedShadow(db, 'auto_tune_dispatch', 'wo-old', 'wk-b', `now() - interval '25 days'`, 'wk-b');
    await seedShadow(db, 'auto_tune_dispatch', 'wo-new', 'wk-b', `now() - interval '10 days'`, 'wk-b');
    const rows = await getShadowReplayStats(db as never, 't1');
    const at = rows.find((r) => r.kind === 'auto_tune_dispatch')!;
    expect(at.total).toBe(2); // 无版本参数 = 无窗口过滤
  });

  it('AUTO_TUNE 再写回（规则 updated_at 后移）→ 版本前创建的行全部出窗（含 stale predicted）', async () => {
    await db.exec(`DELETE FROM ai_shadow_suggestions WHERE tenant_id='t1'; DELETE FROM dispatch_rule WHERE tenant_id='t1'; DELETE FROM model_state WHERE tenant_id='t1';`);
    await seedRule(db, `now() - interval '20 days'`);
    await seedShadow(db, 'auto_tune_dispatch', 'wo-new', 'wk-b', `now() - interval '10 days'`, 'wk-b');
    // 新一轮 AUTO_TUNE 写回：权重变了，updated_at 推进到 5 天前
    await db.query(`UPDATE dispatch_rule SET weight = 3, updated_at = now() - interval '5 days' WHERE tenant_id='t1'`);
    const version = await getAutoTuneRuleVersionAt(db as never, 't1');
    const rows = await getShadowReplayStats(db as never, 't1', undefined, version);
    // 10 天前创建的行早于新版本生成时间 → 出窗（它的 predicted 还是旧规则算的，stale）
    expect(rows.find((r) => r.kind === 'auto_tune_dispatch')).toBeUndefined();
    // 新版本后创建的行才计入
    await seedShadow(db, 'auto_tune_dispatch', 'wo-newest', 'wk-b', `now() - interval '1 day'`, 'wk-b');
    const rows2 = await getShadowReplayStats(db as never, 't1', undefined, await getAutoTuneRuleVersionAt(db as never, 't1'));
    const at = rows2.find((r) => r.kind === 'auto_tune_dispatch')!;
    expect(at.total).toBe(1);
    expect(at.judged).toBe(1);
  });

  it('模型重训也推进版本（predicted 的另一半输入）：模型 updated_at 更近时以它为准', async () => {
    await db.exec(`DELETE FROM ai_shadow_suggestions WHERE tenant_id='t1'; DELETE FROM dispatch_rule WHERE tenant_id='t1'; DELETE FROM model_state WHERE tenant_id='t1';`);
    await seedRule(db, `now() - interval '20 days'`);
    await db.query(
      `INSERT INTO model_state (tenant_id, model_key, params, updated_at)
       VALUES ('t1','dispatch_score','{}', now() - interval '2 days')`,
    );
    await seedShadow(db, 'auto_tune_dispatch', 'wo-m1', 'wk-a', `now() - interval '3 days'`, 'wk-b'); // 模型重训前 → 出窗（且是未命中行，方向反了会污染 hits）
    await seedShadow(db, 'auto_tune_dispatch', 'wo-m2', 'wk-b', `now() - interval '1 day'`, 'wk-b'); // 模型重训后 → 计入（命中）
    const version = await getAutoTuneRuleVersionAt(db as never, 't1');
    const rows = await getShadowReplayStats(db as never, 't1', undefined, version);
    const at = rows.find((r) => r.kind === 'auto_tune_dispatch')!;
    expect(at.total).toBe(1);
    expect(at.hits).toBe(1); // 只数重训后的命中行
    expect(rows.length).toBeGreaterThan(0);
  });

  it('时间窗只作用于新口径：category/dispatch 旧口径统计逐字不受影响', async () => {
    await db.exec(`DELETE FROM ai_shadow_suggestions WHERE tenant_id='t1'; DELETE FROM dispatch_rule WHERE tenant_id='t1'; DELETE FROM model_state WHERE tenant_id='t1';`);
    await seedRule(db, `now() - interval '20 days'`);
    // 旧口径的远古行照样计入（窗口过滤只认 kind='auto_tune_dispatch'）
    await seedShadow(db, 'category', 'wo-c', 'repair', `now() - interval '400 days'`, 'repair');
    await db.query(
      `INSERT INTO ai_shadow_suggestions (tenant_id, work_order_id, kind, suggested, actual, matched, created_at, resolved_at)
       VALUES ('t1','wo-d','dispatch','wk-a','wk-a',true, now() - interval '400 days', now() - interval '399 days')`,
    );
    const version = await getAutoTuneRuleVersionAt(db as never, 't1');
    const rows = await getShadowReplayStats(db as never, 't1', undefined, version);
    expect(rows.find((r) => r.kind === 'category')!.total).toBe(1);
    expect(rows.find((r) => r.kind === 'dispatch')!.judged).toBe(1);
    expect(rows.find((r) => r.kind === 'auto_tune_dispatch')).toBeUndefined();
  });

  it('全链路（真库）：写 predicted → 派单回填 actual → 带版本统计 judged/hits', async () => {
    await db.exec(`DELETE FROM ai_shadow_suggestions WHERE tenant_id='t1'; DELETE FROM dispatch_rule WHERE tenant_id='t1'; DELETE FROM model_state WHERE tenant_id='t1'; DELETE FROM work_orders WHERE tenant_id='t1'; DELETE FROM worker WHERE tenant_id='t1';`);
    await seedRule(db, `now() - interval '20 days'`);
    await db.query(
      `INSERT INTO model_state (tenant_id, model_key, params, updated_at)
       VALUES ('t1','dispatch_score','{"arms":{"repair::wk-a":{"weight":0.1,"pulls":100},"repair::wk-b":{"weight":0.99,"pulls":100}},"alpha":0.2,"ucbC":1.5,"version":3}', now() - interval '30 days')`,
    );
    await db.query(`INSERT INTO work_orders (id, tenant_id, business_type, priority) VALUES ('wo-1','t1','repair','normal')`);
    await db.query(`INSERT INTO work_orders (id, tenant_id, business_type, priority) VALUES ('wo-2','t1','repair','normal')`);
    await db.query(
      `INSERT INTO worker (id, tenant_id, skill_tags, load, active) VALUES
       ('wk-a','t1','[]',0,true), ('wk-b','t1','[]',0,true)`,
    );
    // 落 predicted（规则+模型算出 = wk-b）
    expect(await recordAutoTuneShadow(db as never, 't1', 'wo-1', 'repair')).toBe(true);
    expect(await recordAutoTuneShadow(db as never, 't1', 'wo-2', 'repair')).toBe(true);
    // 派单发生：wo-1 实际派了预测中的 wk-b（命中）；wo-2 实际派了 wk-a（未命中）
    await resolveDispatchShadow(db as never, 't1', 'wo-1', 'wk-b');
    await resolveDispatchShadow(db as never, 't1', 'wo-2', 'wk-a');
    const detail = (
      await db.query<{ detail: { rule_id: string; rule_version_at: string } }>(
        `SELECT detail FROM ai_shadow_suggestions WHERE work_order_id='wo-1' AND kind='auto_tune_dispatch'`,
      )
    ).rows[0].detail;
    expect(detail.rule_id).toBe('rule-1');
    expect(new Date(detail.rule_version_at).getTime()).toBeGreaterThan(0);
    // 统计：两条都已判定、命中 1 条 = 0.5
    const version = await getAutoTuneRuleVersionAt(db as never, 't1');
    const rows = await getShadowReplayStats(db as never, 't1', undefined, version);
    const at = rows.find((r) => r.kind === 'auto_tune_dispatch')!;
    expect(at.total).toBe(2);
    expect(at.judged).toBe(2);
    expect(at.hits).toBe(1);
    expect(at.hitRate).toBeCloseTo(0.5, 5);
    // 达标判定走同一通道：0.5 >= 0.5 但样本 2 < 200 → 不达标（不是假绿）
    const sum = summarizeShadowReplay(rows, TH);
    const atSum = sum.kinds.find((k) => k.kind === 'auto_tune_dispatch')!;
    expect(atSum.ready).toBe(false);
    expect(atSum.reasons.join('|')).toMatch(/2 条 < 要求的 200 条/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. 迁移 100：kind CHECK 扩容 auto_tune_dispatch 且幂等
// ─────────────────────────────────────────────────────────────────────────────
describe('F. 迁移 100_shadow_auto_tune_kind.sql', () => {
  const migrationSql = readFileSync(join(ROOT, '100_shadow_auto_tune_kind.sql'), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\\/.test(l))
    .join('\n');

  const baseTable = `CREATE TABLE ai_shadow_suggestions (
  id bigserial PRIMARY KEY, tenant_id text NOT NULL, work_order_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('category','dispatch')),
  suggested text NOT NULL DEFAULT '', suggested_by text NOT NULL DEFAULT 'k2',
  actual text, matched boolean, detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz);`;

  it('真执行两遍（幂等）后：新 kind 可落库，非法 kind 被 CHECK 挡下', async () => {
    const db = new PGlite();
    try {
      await db.exec(baseTable);
      await db.exec(migrationSql);
      await db.exec(migrationSql); // 第二遍不许炸（DROP IF EXISTS + ADD 标准幂等写法）
      await db.query(
        `INSERT INTO ai_shadow_suggestions (tenant_id, work_order_id, kind, suggested) VALUES ('t1','wo-1','auto_tune_dispatch','wk-b')`,
      );
      await expect(
        db.query(
          `INSERT INTO ai_shadow_suggestions (tenant_id, work_order_id, kind, suggested) VALUES ('t1','wo-2','bogus_kind','x')`,
        ),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. 端点（真 HTTP）：阈值/口径名/auto_tune_criteria 进响应，既有结构不变
// ─────────────────────────────────────────────────────────────────────────────
const box = vi.hoisted(() => ({
  rows: [] as Array<{ kind: string; total: number; judged: number; hits: number; last_at: null }>,
}));

vi.mock('../db/pool.js', () => ({
  default: { query: async () => ({ rows: [], rowCount: 0 }) },
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tenantId: string, fn: (c: unknown) => unknown) =>
    fn({
      query: async (sql: string) => {
        const s = String(sql);
        if (s.includes('max(updated_at)')) return { rows: [{ rule_v: new Date(), model_v: null }], rowCount: 1 };
        if (s.includes('FROM ai_shadow_suggestions')) return { rows: box.rows, rowCount: box.rows.length };
        return { rows: [], rowCount: 0 };
      },
    }),
}));

import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { errorMiddleware } from '../middleware/error.js';
import optimizeRouter from '../routes/optimize.js';
import { refreshAuthMode } from '../middleware/auth.js';

describe('G. GET /optimize/shadow-replay · 双口径端点', () => {
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
      { kind: 'auto_tune_dispatch', total: 41, judged: 41, hits: 7, last_at: null },
    ];
  });

  const call = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it('响应含新口径阈值 + 建议值来源标注（含 SHADOW_AUTOTUNE_HITRATE）', async () => {
    const r = await call('/optimize/shadow-replay');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const th = r.body.thresholds as Record<string, unknown>;
    expect(th.auto_tune_dispatch).toBe(0.5);
    expect(String(th.source)).toMatch(/SHADOW_AUTOTUNE_HITRATE/);
    expect(String(th.source)).toMatch(/建议值/);
  });

  it('kinds 带口径名；auto_tune_criteria 单独成通道；旧字段不丢', async () => {
    const r = await call('/optimize/shadow-replay');
    const kinds = r.body.kinds as Array<{ kind: string; metric_name: string; criteria_note: string; hit_rate: number | null; ready: boolean }>;
    const at = kinds.find((k) => k.kind === 'auto_tune_dispatch')!;
    expect(at.metric_name).toBe('AUTO_TUNE 派单一致性');
    expect(String(at.criteria_note)).toMatch(/dispatch_rule/);
    expect(at.hit_rate!).toBeCloseTo(7 / 41, 3);
    expect(at.ready).toBe(false); // 41 < 200
    const criteria = r.body.auto_tune_criteria as Record<string, unknown>;
    expect(criteria.present).toBe(true);
    expect(criteria.ready).toBe(false);
    expect(Array.isArray(criteria.reasons)).toBe(true);
    // 旧字段
    expect(r.body).toHaveProperty('ready');
    expect(r.body).toHaveProperty('reasons');
    expect(r.body).toHaveProperty('window_days');
    expect(kinds.find((k) => k.kind === 'dispatch')!.metric_name).toBe('人工派单可预测性');
    expect(kinds.find((k) => k.kind === 'category')!.metric_name).toBe('分类预测一致性');
  });

  it('仍为只读端点：影子回放块不写库', async () => {
    const src = readFileSync(join(ROOT, 'src/routes/optimize.ts'), 'utf8');
    const start = src.indexOf("router.get('/optimize/shadow-replay'");
    const end = src.indexOf('// 查看某业务流当前状态图定义', start);
    const block = src.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(block).not.toMatch(/INSERT INTO|UPDATE |DELETE FROM/);
  });
});
