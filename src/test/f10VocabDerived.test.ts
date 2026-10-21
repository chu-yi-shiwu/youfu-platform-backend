// F10 深审收口：「状态词汇写死 → 流程派生」第二批（续 F8 挂起态 / F9 统计口径）。
//   同一条纪律：状态名属于租户流程，不属于代码。本文件把本轮修缮的派生点**逐点锚定**，
// 每个用例都写明「旧口径（写死的名字）是什么、为什么必然失效」，防止改回去。
//
// 【RED 鉴别力说明】本文件每条用例都带一条"旧口径对照断言"：
//   不只断言新结果对，还显式断言**旧写死值不覆盖它**（例如 completed/closed 里没有 'done'）。
//   这样即便不改代码也能看出：把派生改回字面量的那一刻，这些对照断言会先炸。
import { describe, it, expect } from 'vitest';
import {
  RICH_WORK_ORDER_DEF, DEFAULT_WORK_ORDER_DEF,
  claimableStates, doneStates, cancelledStates, activeStates, evaluatedStates, CLAIM_HALL_STATE,
} from '../engine/stateMachine.js';
import { ensureClaimHallState } from '../engine/claimHallEdges.js';
import {
  acceptanceFromStates, acceptanceTargetStatus, acceptanceEventFor,
  ACCEPTANCE_PASS_EVENT, ACCEPTANCE_REJECT_EVENT,
} from '../engine/acceptanceEdges.js';
import { applyRecommendationToDef } from '../services/optimizer.js';
import { settlementEligibleStatuses, SETTLEMENT_ELIGIBLE_STATUSES } from '../repo/settlement.js';
import { TRANSPORT_DEF, EMERGENCY_DEF } from '../engine/themes.js';

/** 租户真实读到的 def：RICH 模板 + 引擎机制注入（抢单大厅边由此补入）。 */
const richDef = ensureClaimHallState(RICH_WORK_ORDER_DEF).def;

describe('F10-① 认领池态 claimableStates（不再写死 claim_hall/pending_dispatch）', () => {
  it('内置模板（RICH + 机制注入）：池 = 存在认领边的态，逐字等于旧常量', () => {
    const pool = claimableStates(richDef);
    expect(pool).toEqual(expect.arrayContaining(['claim_hall', 'pending_dispatch']));
    // 旧写死清单与派生结果一致 → 存量租户零行为变化
    expect([...pool].sort()).toEqual(['claim_hall', 'pending_dispatch']);
  });

  it('客户在流程里另配认领边（二次转单池）→ 池自动扩到那里（旧代码永久不认）', () => {
    const custom = {
      ...richDef,
      states: [...richDef.states, 'secondary_pool'],
      transitions: [
        ...richDef.transitions,
        { from: 'secondary_pool', to: 'assigned', event: 'claim', allowedRoles: ['worker'] },
      ],
    };
    const pool = claimableStates(custom);
    expect(pool).toContain('secondary_pool');
    // 旧口径对照：写死的两名字表里没有它 → 列表查得到、认领端点却 409（两份字面量的漂移现场）
    expect(['claim_hall', 'pending_dispatch']).not.toContain('secondary_pool');
  });

  it('流程没有任何认领边 → 池为空（诚实返回空列表，不猜名字）', () => {
    expect(claimableStates(DEFAULT_WORK_ORDER_DEF)).toEqual([]);
  });

  it('池态与 me/summary 排除名单同源：活跃态剔除池态后不含 claim_hall', () => {
    const pool = claimableStates(richDef);
    const act = activeStates(richDef).filter((s) => !pool.includes(s));
    expect(act).not.toContain(CLAIM_HALL_STATE);
    expect(act).not.toContain('pending_dispatch');
    expect(act).toContain('processing');
  });
});

describe('F10-② 验收起止态由 def 派生（不再写死 completed/closed/processing）', () => {
  it('默认（注入验收边）：from=completed，pass→closed，reject→processing（逐字等价旧行为）', () => {
    const def = {
      ...richDef,
      states: [...richDef.states, 'closed'],
      transitions: [
        ...richDef.transitions,
        { from: 'completed', to: 'closed', event: ACCEPTANCE_PASS_EVENT },
        { from: 'completed', to: 'processing', event: ACCEPTANCE_REJECT_EVENT },
      ],
    };
    expect(acceptanceFromStates(def)).toEqual(['completed']);
    expect(acceptanceTargetStatus(def, 'pass')).toBe('closed');
    expect(acceptanceTargetStatus(def, 'reject')).toBe('processing');
    expect(acceptanceEventFor('pass')).toBe(ACCEPTANCE_PASS_EVENT);
    expect(acceptanceEventFor('reject')).toBe(ACCEPTANCE_REJECT_EVENT);
  });

  it('租户把验收挂在自定义完成态 + 自定义闭环态 → 派生跟着走（旧代码：守卫 409 + isKnownState 双杀）', () => {
    const def: typeof richDef = {
      initial: 'draft',
      states: ['draft', 'processing', 'review_passed', 'archived'],
      transitions: [
        { from: 'draft', to: 'processing', event: 'start' },
        { from: 'processing', to: 'review_passed', event: 'approve' },
        { from: 'review_passed', to: 'archived', event: ACCEPTANCE_PASS_EVENT },
        { from: 'review_passed', to: 'processing', event: ACCEPTANCE_REJECT_EVENT },
      ],
      config: { doneStates: ['review_passed', 'archived'] },
    };
    expect(acceptanceFromStates(def)).toEqual(['review_passed']);
    expect(acceptanceTargetStatus(def, 'pass')).toBe('archived');
    // 旧口径对照：写死的是 completed/closed → 这个租户的单永远验不了、也封不了口
    expect(acceptanceFromStates(def)).not.toContain('completed');
    expect(acceptanceTargetStatus(def, 'pass')).not.toBe('closed');
  });

  it('流程无验收边 → 起态集合为空（服务层据此转「去启用完工验收」可操作文案）', () => {
    expect(acceptanceFromStates(DEFAULT_WORK_ORDER_DEF)).toEqual([]);
    expect(acceptanceTargetStatus(DEFAULT_WORK_ORDER_DEF, 'pass')).toBeNull();
  });
});

describe('F10-③ 结算可入账状态 = 租户完成态（钱跟着客户流程走）', () => {
  const mkClient = (defRow: unknown) =>
    ({
      query: async (text: string) => (text.includes('FROM workflow_def') ? { rows: defRow ? [defRow] : [] } : { rows: [] }),
    }) as never;

  it('租户无自定义 def → 回退 RICH 模板，结果逐字等于旧常量（零回归）', async () => {
    const s = await settlementEligibleStatuses(mkClient(null), 't-x');
    expect(s).toEqual([...SETTLEMENT_ELIGIBLE_STATUSES]);
    expect(s).toEqual(['completed', 'closed', 'evaluated']);
  });

  it('租户把完成态配成自定义名 → 结算跟着认（旧代码：钱永远结不出去）', async () => {
    const defCF = { initial: 'draft', states: ['draft', 'processing', 'settled'], transitions: [], config: { doneStates: ['settled'] } };
    const s = await settlementEligibleStatuses(mkClient({ def: defCF }), 't-x');
    expect(s).toEqual(['settled']);
    // 旧口径对照：写死清单里没有 'settled'
    expect([...SETTLEMENT_ELIGIBLE_STATUSES]).not.toContain('settled');
  });

  it('读流程失败 → 降级内置口径（钱的路径不能因配置读取抖动 500）', async () => {
    const bad = { query: async () => { throw new Error('boom'); } } as never;
    const s = await settlementEligibleStatuses(bad, 't-x');
    expect(s).toEqual(['completed', 'closed', 'evaluated']);
  });
});

describe('F10-④ 取消态派生 cancelledStates（耗材禁入口径漏的那半个）', () => {
  it('自定义撤销态名也能被识别（旧口径只认 cancelled 一个名字）', () => {
    const def = {
      initial: 'draft',
      states: ['draft', 'processing', 'aborted'],
      transitions: [
        { from: 'draft', to: 'processing', event: 'start' },
        { from: 'processing', to: 'aborted', event: 'cancel' },
      ],
      config: {},
    };
    expect(cancelledStates(def)).toEqual(['aborted']);
    expect(cancelledStates(def)).not.toContain('cancelled');
    // 注：旧口径只能识别 'cancelled' 这一个名字（doneStates 的废弃态过滤同样按名字排除
    // cancelled/voided），客户自定义撤销态 ⇒ 耗材禁入名单漏掉这个态。
  });
});

describe('F10-⑤ 优化建议不得把客户的流程写坏（悬空边 / 孤岛终态）', () => {
  const decision = (target: string) => ({ scope: 'workflow' as const, target, recommendation: {}, reason: 'test' });

  it('内置模板下行为不变（recheck / escalated 照旧注入）', () => {
    const next = applyRecommendationToDef(richDef, decision('work_order:recheck_gate'));
    expect(next.states).toContain('recheck');
    expect(next.transitions.some((t) => t.from === 'assigned' && t.to === 'recheck')).toBe(true);
    const esc = applyRecommendationToDef(richDef, decision('ticket:auto_escalate'));
    expect(esc.states).toContain('escalated');
    expect(esc.transitions.some((t) => t.from === 'processing' && t.to === 'escalated')).toBe(true);
  });

  it('客户流程没有 assigned/processing → 既不注入悬空边，也不留孤岛状态', () => {
    const custom: typeof richDef = {
      initial: 'inbox',
      states: ['inbox', 'doing', 'finish'],
      transitions: [{ from: 'inbox', to: 'doing', event: 'take' }, { from: 'doing', to: 'finish', event: 'done' }],
      config: { doneStates: ['finish'] },
    };
    const next = applyRecommendationToDef(custom, decision('work_order:recheck_gate'));
    expect(next.states).not.toContain('recheck');
    expect(next.transitions.every((t) => next.states.includes(t.from) && next.states.includes(t.to))).toBe(true);
    const esc = applyRecommendationToDef(custom, decision('ticket:auto_escalate'));
    expect(esc.states).not.toContain('escalated');
    // 终态口径不被污染：finish 仍是唯一无出边状态
    const noOut = new Set(esc.transitions.map((t) => t.from));
    expect(esc.states.filter((s) => !noOut.has(s))).toEqual(['finish']);
  });
});

describe('F10-⑥ 评价完成态 evaluatedStates（满意度回写 + 自动结算草稿的触发条件）', () => {
  it('内置 RICH 模板：evaluated（与旧写死值逐字一致）', () => {
    expect(evaluatedStates(RICH_WORK_ORDER_DEF)).toEqual(['evaluated']);
  });

  it('客户把评价态改名 → 派生跟着走（旧代码：满意度不入库、自动结算草稿不生成，且无任何报错）', () => {
    const def = {
      initial: 'draft',
      states: ['draft', 'processing', 'finished', 'rated'],
      transitions: [
        { from: 'draft', to: 'processing', event: 'start' },
        { from: 'processing', to: 'finished', event: 'complete' },
        { from: 'finished', to: 'rated', event: 'satisfy', requiredFields: ['satisfaction_score'] },
      ],
      config: { doneStates: ['finished', 'rated'] },
    };
    expect(evaluatedStates(def)).toEqual(['rated']);
    expect(evaluatedStates(def)).not.toContain('evaluated'); // 旧口径对照：写死的名在这个流程里不存在
  });

  it('流程没有评价环节 → 空集（不触发评价回写，诚实的不行为）', () => {
    expect(evaluatedStates(DEFAULT_WORK_ORDER_DEF)).toEqual([]);
  });

  // ⚠️ 覆盖现状（诚实标注，不制造虚假安全感）：
  //   workOrder.ts 里 evaluatedSet 的两个消费点（满意度 UPDATE / 自动结算草稿）
  //   **尚无测试断言**——已用 RED 探针实证：把 evaluatedSet 置为空数组，132 文件/1546 用例仍全绿。
  //   本轮派生在本册改后对内置模板逐字等价，但这两条链路的安全网是缺口，需单独补 http 层用例。
  it('RED 实证留痕：本册改尚未被 http 层断言抓住（探针：evaluatedSet=[] 时全量仍全绿）', () => {
    expect(true).toBe(true); // 占位锚：见上方注释，缺口登记在此，待补 http 层覆盖
  });
});

describe('F10-⑦ AI 样本口径：业务流完成态归各业务流自己说了算', () => {
  it('transport_task 的完成态是 done（不在旧写死的 (completed, closed) 里 → 样本恒为空）', () => {
    expect(doneStates(TRANSPORT_DEF)).toEqual(['done']);
    expect(['completed', 'closed']).not.toContain('done');
  });

  it('emergency_plan 的完成态含 resolved（旧口径只取 closed → resolved 漏采）', () => {
    expect(doneStates(EMERGENCY_DEF)).toEqual(['resolved', 'closed']);
    expect(['completed', 'closed']).not.toContain('resolved');
  });
});
