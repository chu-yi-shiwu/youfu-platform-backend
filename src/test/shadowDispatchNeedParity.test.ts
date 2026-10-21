// shadowDispatchNeedParity.test.ts —— 影子口径与实派口径在 skill_tags 维度上的「同源性」守卫
// ─────────────────────────────────────────────────────────────────────────────
// 【为什么必须有这份测试】
//   新口径 auto_tune_dispatch 的全部可信度，建立在一条承诺上：
//     「predicted = 复刻 autoDispatchAfterCreate 的选人链路」（k2Shadow.ts:167-171 原话）。
//   复刻成立的前提是**两条路径喂给 resolveDispatch 的 need 同源**。
//
//   当前实况（【读码】）：
//     影子侧 k2Shadow.ts:217  → resolveDispatch(workerRows, rules, { business_type, priority }, model)
//     实派侧 workOrder.ts:123 → needPayload = { business_type, skill_tags, priority }
//   两边**入参形状已经不同**：实派侧多一个 skill_tags，只是当前调用方都不传（前端建单不传、
//   公开报修 publicReportCreate.ts:304 不传、对话建单 conversationAgent.ts:183 不传），
//   所以**当前实际值一致**，结论成立。
//
//   但这个"恰好一致"没有任何机器看守。dispatch.ts:87-90 的 match.skill_tags 会**直接改变
//   规则命中结果**（本文件第 1 组用真实数据证明它有牙齿）⇒ 一旦将来任一侧带上 skill_tags
//   （例如做「catalog → fault_category.skill_tags 自动带出」），另一侧没跟，影子分数就会
//   **静默失真**：那时它测的不再是「规则派单 vs 人实际派单差多少」，而是混进了「输入差异」。
//
// 本文件锁三件事：
//   A 维度有牙齿：同一规则集下，need 带/不带 skill_tags ⇒ 命中**不同的规则**（分叉不是理论风险）；
//   B 当前同源：影子预测命中「不带 skill_tags 的实派」会命中的那条规则；
//   C 契约可机读：影子侧传给选人引擎的 need 里**不含** skill_tags，且源码注释写明了原因
//     ——任何人想改，必须同时改实派侧（改一侧则 C 红）。
//
// 【诚实边界】
//   C 组是源码级断言（防"默默改而不留痕"），会随代码格式调整而红——这是**有意为之**：
//   它要逼改的人在改的时候停下来读一遍注释，而不是悄悄改过去。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDispatch, type DispatchRule, type WorkerRow } from '../engine/dispatch.js';
import { recordAutoTuneShadow } from '../services/k2Shadow.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 规则集：R1 依赖 match.skill_tags（需要"工单带着 electric 技能需求"才命中），
//         R2 只看 business_type（任何 repair 单都命中）。R1 优先级更高。
// 两者刻意设计成"命中不同规则"，使分叉可观测——若两侧 need 不同源，选人结果直接分开。
const RULES: DispatchRule[] = [
  {
    id: 'r-skill',
    name: '带电工技能需求的维修单',
    priority: 200,
    match: { business_type: 'repair', skill_tags: ['electric'] },
    strategy: { type: 'load_balance', skill_tags: ['electric'] },
    weight: 1,
    score: 0,
  },
  {
    id: 'r-plain',
    name: '普通维修单',
    priority: 100,
    match: { business_type: 'repair' },
    strategy: { type: 'load_balance' },
    weight: 1,
    score: 0,
  },
];

// 顺序刻意：wk-plain 在前且负载相同 ⇒ 「不带 skill_tags」走 r-plain 时 least_load 选 wk-plain，
// 「带 skill_tags」走 r-skill 时候选只剩 wk-elec ⇒ 两条路径落在**不同的人**身上。
// 这样 B 组第二条（predicted 与同参实派同人）在分叉时也会红，不会因"碰巧同人"而漏检。
const WORKERS: WorkerRow[] = [
  { id: 'wk-plain', skill_tags: [], load: 0, active: true },
  { id: 'wk-elec', skill_tags: ['electric'], load: 0, active: true },
];

// ─────────────────────────────────────────────────────────────────────────────
// A. skill_tags 维度有牙齿：带与不带 ⇒ 命中不同的规则
// ─────────────────────────────────────────────────────────────────────────────
describe('A. skill_tags 是真维度：need 带与不带 ⇒ 命中不同规则（分叉不是理论风险）', () => {
  it('need 不带 skill_tags → 依赖技能匹配的 r-skill 不命中，落到 r-plain', () => {
    const r = resolveDispatch(WORKERS, RULES, { business_type: 'repair' });
    expect(r).not.toBeNull();
    expect(r!.ruleId).toBe('r-plain');
  });

  it('need 带 skill_tags=["electric"] → r-skill 命中（优先级更高，压过 r-plain）', () => {
    const r = resolveDispatch(WORKERS, RULES, { business_type: 'repair', skill_tags: ['electric'] });
    expect(r).not.toBeNull();
    expect(r!.ruleId).toBe('r-skill');
  });

  it('两侧 need 不同源 ⇒ 命中规则确实不同（这就是影子失真的样子）', () => {
    const noTags = resolveDispatch(WORKERS, RULES, { business_type: 'repair' })!;
    const withTags = resolveDispatch(WORKERS, RULES, { business_type: 'repair', skill_tags: ['electric'] })!;
    expect(noTags.ruleId).not.toBe(withTags.ruleId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. 当前同源：影子预测命中「建单不带 skill_tags 时实派会命中的那条规则」
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

const RULE_VERSION = new Date('2026-10-01T00:00:00.000Z');

const routes = {
  'SELECT business_type': () => ({ rows: [{ business_type: 'repair', priority: 'normal' }] }),
  'max(updated_at)': () => ({ rows: [{ rule_v: RULE_VERSION, model_v: null }] }),
  'enabled = true': () => ({
    rows: RULES.map((r) => ({
      id: r.id,
      name: r.name,
      priority: r.priority,
      match_json: r.match,
      strategy_json: r.strategy,
      weight: r.weight ?? 1,
      score: r.score ?? 0,
    })),
  }),
  'FROM worker': () => ({
    rows: WORKERS.map((w) => ({ id: w.id, skill_tags: w.skill_tags, load: w.load, active: w.active })),
  }),
  // 无 model_state ⇒ StatsModelBackend(undefined)：predicted 由规则命中 + least_load 决定，
  // 本文件只断言「命中哪条规则」（规则命中与模型无关），不受模型随机性干扰。
  model_state: () => ({ rows: [] }),
};

describe('B. 当前同源：影子预测与「不带 skill_tags 的实派」命中同一条规则', () => {
  it('recordAutoTuneShadow 不带 skill_tags → 命中 r-plain（与实派同参结果一致）', async () => {
    const client = makeFakeClient(routes);
    const wrote = await recordAutoTuneShadow(client, 't-verification', 'wo-1', 'repair');
    expect(wrote).toBe(true);
    const calls = (client as never as { calls: RecordedCall[] }).calls;
    const ins = calls.find((c) => c.sql.includes("'auto_tune_dispatch'"))!;
    expect(ins).toBeDefined();
    const detail = JSON.parse(String(ins.params[3]));
    // 关键断言：影子不能因为"少传一个维度"而命中与实派不同的规则。
    // 实派在三条建单路径（后台/公开报修/对话）当前都不传 skill_tags ⇒ 应命中 r-plain。
    expect(detail.rule_id).toBe('r-plain');
    expect(detail.rule_name).toBe('普通维修单');
  });

  it('同源的另一半：predicted 工人 = 同参 resolveDispatch 选出的工人（影子真的在复刻）', async () => {
    const client = makeFakeClient(routes);
    await recordAutoTuneShadow(client, 't-verification', 'wo-1', 'repair');
    const calls = (client as never as { calls: RecordedCall[] }).calls;
    const ins = calls.find((c) => c.sql.includes("'auto_tune_dispatch'"))!;
    const predicted = String(ins.params[2]);
    // 实派侧同参（不带 skill_tags）应选出同一人
    const sameNeed = resolveDispatch(WORKERS, RULES, { business_type: 'repair', priority: 'normal' })!;
    expect(predicted).toBe(sameNeed.worker.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. 契约可机读：影子侧 need 不含 skill_tags，且源码写明原因
// ─────────────────────────────────────────────────────────────────────────────
describe('C. 契约守卫：影子侧 need 不含 skill_tags 且留有说明（改一侧必须改另一侧）', () => {
  const src = readFileSync(join(ROOT, 'src/services/k2Shadow.ts'), 'utf8');

  it('传给 resolveDispatch 的 need 字面量里不含 skill_tags', () => {
    const m = src.match(/resolveDispatch\(\s*workerRows\s*,\s*rules\s*,\s*\{([\s\S]*?)\}\s*,\s*model\s*\)/);
    expect(m, '未找到影子侧 resolveDispatch 调用——若已重构，请同步更新本守卫').not.toBeNull();
    expect(m![1]).not.toMatch(/skill_tags/);
  });

  it('源码注释如实写明「skill_tags 不落工单表，诚实留空」——不装作维度齐全', () => {
    expect(src).toMatch(/skill_tags\s*不落工单表/);
  });

  it('契约说明：若将来建单侧带上 skill_tags，影子必须同步（注释里写明这条约束）', () => {
    // 与 autoDispatchAfterCreate 同口径的承诺写在 recordAutoTuneShadow 的文档注释里
    expect(src).toMatch(/与\s*autoDispatchAfterCreate\s*同一条/);
  });
});
