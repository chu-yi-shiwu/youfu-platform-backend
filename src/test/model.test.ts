import { describe, it, expect } from 'vitest';
import { StatsModelBackend } from '../engine/model/ModelBackend.js';
import { computeRewards, isSyntheticWorker, stripSyntheticArms, trainFromDb } from '../services/modelTrainer.js';

describe('StatsModelBackend（派单自适应评分）', () => {
  it('新候选给基线分，被 UCB 探索优先选中', () => {
    const m = new StatsModelBackend();
    const s = m.score({ category: 'electric', workerId: 'w-new' });
    expect(s).toBeGreaterThan(0.5); // 基线 + UCB 探索加分
  });

  it('正向奖励提升权重、负向降低；学好后评分优于学坏后', () => {
    const m = new StatsModelBackend();
    m.learn('electric', 'w-1', 1);
    m.learn('electric', 'w-1', 1);
    const goodWeight = m.toParams().arms['electric::w-1'].weight;
    const goodScore = m.score({ category: 'electric', workerId: 'w-1' });
    m.learn('electric', 'w-1', -1); // 派错
    const badWeight = m.toParams().arms['electric::w-1'].weight;
    const badScore = m.score({ category: 'electric', workerId: 'w-1' });
    expect(goodWeight).toBeGreaterThan(badWeight); // 权重方向正确（正>负）
    expect(goodScore).toBeGreaterThan(badScore); // 学好后优于学坏后
  });

  it('参数可导出再导入（持久化闭环一致）', () => {
    const m = new StatsModelBackend();
    m.learn('electric', 'w-1', 1);
    const p = m.toParams();
    const m2 = StatsModelBackend.fromParams(p);
    expect(m2.score({ category: 'electric', workerId: 'w-1' })).toBeCloseTo(
      m.score({ category: 'electric', workerId: 'w-1' }),
      5,
    );
  });
});

describe('computeRewards（数据反训奖励计算）', () => {
  it('一次派单即完成 → reward +1', () => {
    const ev = [
      { type: 'assign', to_status: 'assigned', actor: 'auto_dispatch', payload: { worker_id: 'w-1' }, created_at: 't' },
      { type: 'transition', to_status: 'completed', actor: 'system', payload: {}, created_at: 't2' },
    ];
    const r = computeRewards(ev as any);
    expect(r).toHaveLength(1);
    expect(r[0].reward).toBe(1);
    expect(r[0].workerId).toBe('w-1');
  });

  it('转派（assign>=2）→ reward -0.5', () => {
    const ev = [
      { type: 'assign', to_status: 'assigned', actor: 'auto_dispatch', payload: { worker_id: 'w-1' }, created_at: 't' },
      { type: 'assign', to_status: 'assigned', actor: 'auto_dispatch', payload: { worker_id: 'w-2' }, created_at: 't2' },
      { type: 'transition', to_status: 'completed', actor: 'system', payload: {}, created_at: 't3' },
    ];
    const r = computeRewards(ev as any);
    expect(r[0].reward).toBe(-0.5);
  });

  it('超时升级 → reward -1', () => {
    const ev = [
      { type: 'assign', to_status: 'assigned', actor: 'auto_dispatch', payload: { worker_id: 'w-1' }, created_at: 't' },
      { type: 'sla_escalated', to_status: 'assigned', actor: 'system', payload: {}, created_at: 't2' },
    ];
    const r = computeRewards(ev as any);
    expect(r[0].reward).toBe(-1);
  });

  it('无派单事件 → 空', () => {
    const ev = [{ type: 'create', to_status: 'draft', actor: 'system', payload: {}, created_at: 't' }];
    expect(computeRewards(ev as any)).toHaveLength(0);
  });

  // 飞轮断链 1 修复：满意度信号（sat_bonus=(score-3)/2 叠加到最终 assign）
  it('满意度 5 分 → 最终 assign reward +1（1 + 1 = 2）', () => {
    const ev = [
      { type: 'assign', to_status: 'assigned', actor: 'auto_dispatch', payload: { worker_id: 'w-1' }, created_at: 't' },
      { type: 'transition', to_status: 'completed', actor: 'system', payload: {}, created_at: 't2' },
    ];
    const r = computeRewards(ev as any, 5);
    expect(r[0].reward).toBe(2);
  });

  it('满意度 1 分 → 最终 assign reward 归零（1 - 1 = 0）', () => {
    const ev = [
      { type: 'assign', to_status: 'assigned', actor: 'auto_dispatch', payload: { worker_id: 'w-1' }, created_at: 't' },
      { type: 'transition', to_status: 'completed', actor: 'system', payload: {}, created_at: 't2' },
    ];
    const r = computeRewards(ev as any, 1);
    expect(r[0].reward).toBe(0);
  });

  it('满意度只叠加到最终 assign（转派场景历史工人不受当前满意度影响）', () => {
    const ev = [
      { type: 'assign', to_status: 'assigned', actor: 'auto_dispatch', payload: { worker_id: 'w-1' }, created_at: 't' },
      { type: 'assign', to_status: 'assigned', actor: 'auto_dispatch', payload: { worker_id: 'w-2' }, created_at: 't2' },
      { type: 'transition', to_status: 'completed', actor: 'system', payload: {}, created_at: 't3' },
    ];
    const r = computeRewards(ev as any, 5);
    expect(r[0].reward).toBe(-0.5); // 历史工人：转派信号 -0.5，无满意度加成
    expect(r[1].reward).toBe(0.5); // 最终工人：转派 -0.5 + 满意度 +1 = +0.5
  });

  it('满意度缺失（null）→ 不影响事件信号', () => {
    const ev = [
      { type: 'assign', to_status: 'assigned', actor: 'auto_dispatch', payload: { worker_id: 'w-1' }, created_at: 't' },
      { type: 'transition', to_status: 'completed', actor: 'system', payload: {}, created_at: 't2' },
    ];
    const r = computeRewards(ev as any, null);
    expect(r[0].reward).toBe(1);
  });

  // A1 派单止血：合成工人（SYN-W-xx 幽灵臂，93.7% 合成污染源）不产生奖励信号
  it('A1止血1：合成工人 assign 事件 → 不产生奖励信号', () => {
    const ev = [
      { type: 'assign', to_status: 'assigned', actor: 'seed', payload: { worker_id: 'SYN-W-01' }, created_at: 't' },
      { type: 'transition', to_status: 'completed', actor: 'system', payload: {}, created_at: 't2' },
    ];
    expect(computeRewards(ev as any)).toHaveLength(0);
  });

  it('A1止血1：混合场景只保留真实工人信号', () => {
    const ev = [
      { type: 'assign', to_status: 'assigned', actor: 'seed', payload: { worker_id: 'SYN-W-03' }, created_at: 't' },
      { type: 'assign', to_status: 'assigned', actor: 'auto_dispatch', payload: { worker_id: 'w-real' }, created_at: 't2' },
      { type: 'transition', to_status: 'completed', actor: 'system', payload: {}, created_at: 't3' },
    ];
    const r = computeRewards(ev as any);
    expect(r).toHaveLength(1);
    expect(r[0].workerId).toBe('w-real');
  });

  it('A1止血3：stripSyntheticArms 剥离幽灵臂、保留真实臂', () => {
    const p = {
      arms: {
        'electric::SYN-W-01': { weight: 0.9, pulls: 40 },
        'electric::w-real': { weight: 0.7, pulls: 5 },
        'hvac::SYN-W-08': { weight: 0.1, pulls: 3 },
      },
      alpha: 0.2,
      ucbC: 1.5,
      version: 7,
    };
    const s = stripSyntheticArms(p);
    expect(Object.keys(s.arms).sort()).toEqual(['electric::w-real']);
    expect(s.version).toBe(7); // 其余字段原样保留
  });

  it('A1边界：isSyntheticWorker 只匹配 SYN-W-数字', () => {
    expect(isSyntheticWorker('SYN-W-01')).toBe(true);
    expect(isSyntheticWorker('SYN-W-123')).toBe(true);
    expect(isSyntheticWorker('w-1')).toBe(false);
    expect(isSyntheticWorker('SYN-X-01')).toBe(false);
    expect(isSyntheticWorker('SYN-W-')).toBe(false);
  });

  it('A1边界：全合成 assigns → computeRewards 返回空，不喂模型', () => {
    const ev = [
      { type: 'assign', to_status: 'assigned', actor: 'auto_dispatch', payload: { worker_id: 'SYN-W-01' }, created_at: 't' },
      { type: 'transition', to_status: 'completed', actor: 'system', payload: {}, created_at: 't2' },
    ];
    expect(computeRewards(ev as any, 5)).toEqual([]);
  });

  it('A1边界：混合 assign（SYN-W-01 + 真实工人）→ 只出真实工人奖励且不算重派', () => {
    const ev = [
      { type: 'assign', to_status: 'assigned', actor: 'auto_dispatch', payload: { worker_id: 'SYN-W-01' }, created_at: 't1' },
      { type: 'assign', to_status: 'assigned', actor: 'auto_dispatch', payload: { worker_id: 'w-real' }, created_at: 't2' },
      { type: 'transition', to_status: 'completed', actor: 'system', payload: {}, created_at: 't3' },
    ];
    const r = computeRewards(ev as any, 5);
    expect(r).toHaveLength(1);
    expect(r[0].workerId).toBe('w-real');
    // 过滤后 assigns.length===1 → reassigned 不触发：reward = 1(完成) + 1(满意5)，而非 -0.5(重派)+1
    expect(r[0].reward).toBe(2);
  });

  it('A1边界：stripSyntheticArms 保留畸形 key（无 :: 分隔），只剥确认的幽灵臂', () => {
    const p = { arms: { 'weird-key': { weight: 0.5, pulls: 1 }, 'electric::SYN-W-02': { weight: 0.9, pulls: 9 } }, version: 3 };
    const s = stripSyntheticArms(p as any);
    expect(Object.keys(s.arms).sort()).toEqual(['weird-key']);
  });
});

describe('StatsModelBackend arms 上限（R17-003 防内存膨胀）', () => {
  it('学习远超上限的不同臂后，arms 数量被收敛、不无限增长', () => {
    const m = new StatsModelBackend();
    const N = 6000; // 超过 MAX_ARMS(5000)
    for (let i = 0; i < N; i++) {
      m.learn(`cat-${i}`, `w-${i}`, i % 2 === 0 ? 1 : -1);
    }
    const size = Object.keys(m.toParams().arms).length;
    expect(size).toBeLessThanOrEqual(5000);
    expect(size).toBeGreaterThan(0);
  });
});

// ===================== T1-B · m3（独立评审）：训练样本口径必须取各版本并集 =====================
/**
 * 【洞】`status = ANY($2::text[])` 是**包含**判定，但 done 只从 live def 派生 ⇒
 *   客户改过流程后，锁着 v1 的老单走到 v1 的完成态（X），而 v2(live) 不认 X 是完成态
 *   ⇒ 这批老单**进不了训练样本**（模型学不到它们，且无任何报错，属静默丢样本）。
 * 【修法】包含判定取各版本**并集**（宁可多训一单，不可静默漏样本）。
 *
 * 【fixture】v1(老)=['done','X'] ／ v2(live)=['done','Y'] ⇒
 *   并集=['done','X','Y'] ／ live 一份=['done','Y'] ／ 交集=['done'] —— 三口径两两不同，用例有判别力。
 */
describe('trainFromDb（训练样本口径）', () => {
  const SHAPE = {
    initial: 'draft',
    states: ['draft', 'doing', 'done', 'X', 'Y'],
    transitions: [
      { from: 'draft', to: 'doing', event: 'start' },
      { from: 'doing', to: 'done', event: 'finish' },
      { from: 'doing', to: 'X', event: 'finish_x' },
      { from: 'doing', to: 'Y', event: 'finish_y' },
    ],
  };
  const V1_OLD = { ...SHAPE, config: { doneStates: ['done', 'X'] } }; // 老版本（存量单锁它）
  const V2_LIVE = { ...SHAPE, config: { doneStates: ['done', 'Y'] } }; // 当前 live

  /** 假 PoolClient：只响应 trainFromDb + getDefsAcrossAllVersions 真正会发的那几条 SQL。 */
  function trainerClient(calls: Array<{ sql: string; params: unknown[] }>): any {
    return {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('SELECT params FROM model_state')) return { rows: [], rowCount: 0 };
        if (sql.includes('SELECT DISTINCT def_version')) return { rows: [{ def_version: 1 }, { def_version: 2 }], rowCount: 2 };
        if (sql.includes('SELECT version FROM workflow_def')) return { rows: [{ version: 2 }], rowCount: 1 };
        // ⚠️ history 必须先判：`SELECT def FROM workflow_def_history ...` 也含 "SELECT def FROM workflow_def"
        if (sql.includes('FROM workflow_def_history')) return { rows: [{ def: JSON.stringify(V1_OLD) }], rowCount: 1 };
        if (sql.includes('SELECT def FROM workflow_def')) return { rows: [{ def: JSON.stringify(V2_LIVE) }], rowCount: 1 };
        if (sql.includes('FROM work_orders')) return { rows: [{ id: 'wo-1', business_type: 'electric', satisfaction_score: 5 }], rowCount: 1 };
        if (sql.includes('FROM ticket_event')) {
          return {
            rows: [
              { type: 'assign', to_status: 'assigned', actor: 'auto_dispatch', payload: { worker_id: 'w-1' }, created_at: 't1' },
              { type: 'transition', to_status: 'done', actor: 'system', payload: {}, created_at: 't2' },
            ],
            rowCount: 2,
          };
        }
        if (sql.includes('INSERT INTO model_state')) return { rows: [], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    };
  }

  it('🔴 训练样本取各版本完成态并集：锁旧版本的完成态工单不漏训', async () => {
    // —— 假绿防护：两版完成态确实不同（否则"并集 vs live 一份"无从判别）
    expect(V1_OLD.config.doneStates).toEqual(['done', 'X']);
    expect(V2_LIVE.config.doneStates).toEqual(['done', 'Y']);

    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const model = await trainFromDb(trainerClient(calls), 't-train');

    // 前提成立：真的扫到样本并学到了臂（否则下面的 params 断言在空转）
    expect(Object.keys(model.toParams().arms).length, '必须真的学到一条臂').toBeGreaterThan(0);

    const sampleCall = calls.find((c) => c.sql.includes('status = ANY'));
    expect(sampleCall, '训练样本查询必须真的执行').toBeTruthy();
    const done = new Set(sampleCall!.params[1] as string[]);
    expect(done, '并集必须含 v1 独有的完成态 X（否则老单漏训）').toEqual(new Set(['done', 'X', 'Y']));
    expect(done.has('X'), 'X 只被 v1 认作完成 ⇒ 并集必须带上它').toBe(true);
    expect(done.has('Y'), 'Y 只被 live 认作完成 ⇒ 并集必须带上它').toBe(true);
  });
});
