// R32 拆雷三件套②（2026-08-31）：SLA 闭环回归护栏。
// 此前断链：/sla/scan 仅能手动按租户触发 + 命中只落事件不落通知。
// 修复：抽 runSlaScanForTenant 共用实现 + 进程内 cron（sla_escalation_tenants 枚举）+ 命中补通知。
// 本文件验证（db/pool 整体 mock，无真实 PG）：
//   1) 超时活跃单 → escalated_at UPDATE + worker 通知 + admin 通知；
//   2) 未超时 / 已升级 → 零命中零通知；
//   3) runSlaSchedulerOnce 经 SECURITY DEFINER 枚举租户并汇总命中数。
import { describe, it, expect, vi } from 'vitest';
// 批 7：要断言「两版终态零交集」这个前提，得用真口径函数，不能手写常量。
import { doneStates, terminalStates, activeStates, holdStates } from '../engine/stateMachine.js';

// db/pool 整体 mock：withTenantClient 直接以测试注入的 fake client 执行；
// pool.query 供跨租户枚举（sla_escalation_tenants）与 lock（connect 抛错 → 降级放行）使用。
const h = vi.hoisted(() => ({ client: null as any, tenants: [] as string[] }));
vi.mock('../db/pool.js', () => ({
  default: {
    query: vi.fn(async (text: string) =>
      text.includes('sla_escalation_tenants') ? { rows: h.tenants.map((t) => ({ tenant_id: t })) } : { rows: [] },
    ),
    connect: vi.fn(async () => {
      throw new Error('no pg in tests'); // lock 降级放行路径
    }),
  },
  withTenantClient: vi.fn(async (_tenantId: string, fn: (c: any) => Promise<any>) => fn(h.client)),
}));

const { runSlaScanForTenant, runSlaSchedulerOnce, runTransportSlaScanForTenant } = await import(
  '../scheduler/slaScheduler.js'
);

const TENANT = 't-verification';
const WO = '55555555-5555-4555-8555-555555555555';
const W1 = 'worker-001';
const ADMIN = 'admin-001';

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;

function makeClient(scanRows: any[]) {
  const calls: Array<{ text: string; params?: any[] }> = [];
  const client = {
    query: (async (text: string, params?: any[]) => {
      calls.push({ text, params });
      if (text.includes('SELECT def FROM workflow_def')) return { rows: [] }; // DEFAULT 状态机
      if (text.includes('FROM work_orders') && text.includes('status <> ALL')) return { rows: scanRows };
      if (text.includes('FROM account_user')) return { rows: [{ id: ADMIN }] };
      return { rows: [] }; // UPDATE / INSERT ticket_event / domain_event / notification / webhook_subscription
    }) as QueryFn,
  } as any;
  return { client, calls };
}

const overdueRow = {
  id: WO,
  status: 'processing',
  sla_due_at: new Date(Date.now() - 10 * 60_000),
  escalated_at: null,
  assignee_id: W1,
  order_no: 'WO-SLA-1',
};

describe('runSlaScanForTenant（SLA 闭环回归护栏）', () => {
  it('🔴 核心回归：超时活跃单 → 标记升级 + 在身 assignee 通知 + 租户管理员通知', async () => {
    const { client, calls } = makeClient([overdueRow]);
    h.client = client;
    const hits = await runSlaScanForTenant(TENANT);
    expect(hits).toHaveLength(1);
    expect(hits[0].workOrderId).toBe(WO);
    expect(hits[0].escalMinutes).toBeGreaterThanOrEqual(10);
    expect(calls.find((c) => c.text.includes('UPDATE work_orders SET escalated_at'))).toBeTruthy();
    const notes = calls.filter((c) => c.text.includes('INSERT INTO notification'));
    expect(notes).toHaveLength(2);
    // 第一条：worker（在身 assignee）；第二条：account（租户管理员）
    expect(notes[0].params).toEqual(expect.arrayContaining([W1, 'worker']));
    expect(notes[1].params).toEqual(expect.arrayContaining([ADMIN, 'account']));
  });

  it('未超时 → 零命中、零通知、不动 escalated_at', async () => {
    const { client, calls } = makeClient([{ ...overdueRow, sla_due_at: new Date(Date.now() + 60 * 60_000) }]);
    h.client = client;
    const hits = await runSlaScanForTenant(TENANT);
    expect(hits).toHaveLength(0);
    expect(calls.find((c) => c.text.includes('UPDATE work_orders SET escalated_at'))).toBeUndefined();
    expect(calls.find((c) => c.text.includes('INSERT INTO notification'))).toBeUndefined();
  });

  it('已升级过（escalated_at 非空）→ 不重复命中', async () => {
    const { client, calls } = makeClient([{ ...overdueRow, escalated_at: new Date() }]);
    h.client = client;
    const hits = await runSlaScanForTenant(TENANT);
    expect(hits).toHaveLength(0);
    expect(calls.find((c) => c.text.includes('INSERT INTO notification'))).toBeUndefined();
  });

  // ===================== 批 7 · 运送线二道过滤（独立评审 M1） =====================
  /**
   * 【洞】运送线的排除集直接进 `status <> ALL($2)`，**没有二道过滤**
   *   （slaScheduler.ts:128 注释自己写着"运送线无二道过滤"，与工单线的 slaScan+activeStates 不对称）。
   *   多版本并存时排除集取**交集**，若两版终态名完全不重叠（v1='done' / v2='finished'）
   *   ⇒ 交集为空 ⇒ `status <> ALL('{}')` **恒真** ⇒ 所有 `sla_due_at<now AND escalated_at IS NULL`
   *   的历史单（含已完成、已取消）全部被升级 + 通知 carrier 和**全部 admin** + 写 escalated_at
   *   （不可逆，无自动回滚）。
   * 【修法】与工单线对齐：补一道「状态必须属于各版本活跃态并集」的过滤。
   *   ⇒ 空集时只会对活跃单升级，不会把已完成的历史单全炸一遍。
   */
  const V1_DONE: any = {
    initial: 'draft',
    states: ['draft', 'doing', 'done'],
    transitions: [
      { from: 'draft', to: 'doing', event: 'start' },
      { from: 'doing', to: 'done', event: 'finish' },
    ],
    config: {},
  };
  /** v2（live）：客户把完成态改名叫 finished，done 变成中间态（有出边）⇒ 两版终态零交集。 */
  const V2_FINISHED: any = {
    initial: 'draft',
    states: ['draft', 'doing', 'done', 'finished'],
    transitions: [
      { from: 'draft', to: 'doing', event: 'start' },
      { from: 'doing', to: 'done', event: 'finish' },
      { from: 'done', to: 'finished', event: 'close' },
    ],
    config: {},
  };

  function makeTransportClient(rows: any[]) {
    const calls: Array<{ text: string; params?: any[] }> = [];
    const client = {
      query: (async (text: string, params?: any[]) => {
        calls.push({ text, params });
        if (text.includes('SELECT DISTINCT def_version')) return { rows: [{ def_version: 1 }, { def_version: 2 }] };
        if (text.includes('SELECT version FROM workflow_def')) return { rows: [{ version: 2 }] };
        if (text.includes('FROM workflow_def_history')) {
          const d = Number(params?.[2]) === 1 ? V1_DONE : V2_FINISHED;
          return { rows: [{ def: JSON.stringify(d) }] };
        }
        // 本租户的**当前（live）**流程就是 v2（与上面 workflow_def.version=2 一致）。
        // 此前这条没有分支、落到兜底 `{ rows: [] }` ⇒ 被读作"该租户没配流程" ⇒ 退化到内置
        //   TRANSPORT_DEF ⇒ v0/v2 两路都拿到内置模板 ⇒ 排除集交集恒含 'done'
        //   ⇒ 老单被 SQL 直接挡掉，本洞呈现**假绿**（用例没动就已通过）。
        //   必须让 live = V2_FINISHED，才能复现"两版终态零交集"。
        if (text.includes('SELECT def FROM workflow_def')) return { rows: [{ def: JSON.stringify(V2_FINISHED) }] };
        // 批 8-2：SQL 预过滤回到 `status <> ALL($2::text[])`。**必须真的模拟这个谓词**
        //   ——否则 fake client 会把 rows 原样吐回，`<> ALL` 写成交集还是并集都看不出来，
        //   那道 SQL 闸等于没人看着（这正是当初把判定留在 JS 层的理由）。
        //   忠实行为：空数组 ⇒ 恒真（全放行）；否则要求 status 与每个元素都不等。
        if (text.includes('FROM transport_order') && text.includes('sla_due_at IS NOT NULL')) {
          const exclude = (params?.[1] ?? []) as string[];
          return { rows: exclude.length === 0 ? rows : rows.filter((r) => !exclude.includes(String(r.status))) };
        }
        if (text.includes('FROM account_user')) return { rows: [{ id: ADMIN }] };
        return { rows: [] };
      }) as QueryFn,
    } as any;
    return { client, calls };
  }

  /** 真口径的 dead 判定（与产品侧 deadStatesOf 同表达式）：done ∪ terminal ∪ hold。 */
  const isDeadIn = (d: any, s: string) =>
    new Set([...doneStates(d), ...terminalStates(d), ...holdStates(d)]).has(s);

  const transportRow = {
    id: 'TR-1',
    code: 'TR-CODE-1',
    status: 'doing',
    carrier: 'carrier-001',
    sla_due_at: new Date(Date.now() - 30 * 60_000),
    // T1-B：行上锁着的流程版本。0 = 哨兵（建单时没记录）⇒ 走 live（本 mock 里 live = v2）。
    def_version: 0,
  };

  it('🔴 运送线：排除集为空时不得把已完成单误升级（交集空 ⇒ <> ALL 恒真）', async () => {
    // —— 先证明排除集确实为空（否则本例是假绿）
    expect(
      doneStates(V1_DONE).concat(terminalStates(V1_DONE)).includes('done'),
      'v1 的终态是 done',
    ).toBe(true);
    expect(
      doneStates(V2_FINISHED).concat(terminalStates(V2_FINISHED)).includes('finished'),
      'v2 的终态是 finished',
    ).toBe(true);

    // 已完成单（status = v2 的完成态 finished），逾期但**已完成** ⇒ 不该升级
    const { client, calls } = makeTransportClient([{ ...transportRow, status: 'finished' }]);
    h.client = client;
    const hits = await runTransportSlaScanForTenant(TENANT);
    expect(hits, '已完成单不得被升级（空排除集 ⇒ <> ALL 恒真 ⇒ 会误炸）').toHaveLength(0);
    expect(calls.find((c) => c.text.includes('UPDATE transport_order SET escalated_at'))).toBeUndefined();
    expect(calls.find((c) => c.text.includes('INSERT INTO notification'))).toBeUndefined();
  });

  it('运送线二道过滤不能反过来漏告警：真活跃的逾期单仍要命中', async () => {
    // status='doing' 在两个版本里都是活跃态 ⇒ 必须照常升级、照常通知
    const { client, calls } = makeTransportClient([transportRow]);
    h.client = client;
    const hits = await runTransportSlaScanForTenant(TENANT);
    expect(hits, '真活跃 + 真逾期 ⇒ 不能因为加了二道过滤就漏告警').toHaveLength(1);
    expect(calls.find((c) => c.text.includes('UPDATE transport_order SET escalated_at'))).toBeTruthy();
  });

  // ===== 批 8 · 根治（独立评审 M1 第二轮）：并集二道过滤挡不住"跨版本活跃态" =====
  /**
   * 【为什么批 7 的并集二道过滤不够】
   *   二道过滤是 `status ∈ 各版本 activeStates 的并集`。而 activeStates 是
   *   `全态 − done − terminal − hold`，**跨版本后不再互斥**：
   *   'done' 在 v1 是终态（无出边），在 v2 因为客户加了 `done --close--> finished` 这条边
   *   变成**中间态 ⇒ 活跃** ⇒ 并集里就含 'done'。
   *   于是一张锁着 v1、status='done' 的单（按它自己那版流程**早已终结**），
   *   却因为"在 v2 里是活跃态"被判成在途 ⇒ 照样升级 + 通知 carrier 和全部 admin
   *   + 写 escalated_at（不可逆）。
   *   并集这个方向天然是"宁可多算"，用在**二道放行闸**上就是把误报面放大，方向反了。
   * 【根治】transport_order 表上**本来就有 def_version 列**（102 迁移 :55）
   *   ⇒ 这里根本不属于"手上没行只能读 live 猜"的场景。直接把 def_version 查出来，
   *   用 getDefsForVersions 按行取它自己锁的那一版 def 来判定，不猜。
   */
  it('🔴 运送线：锁 v1 的单（status=done，在 v1 是终态）不得被升级（并集二道过滤会放行它）', async () => {
    // —— 先证明 'done' 在两版里的角色确实相反（否则本例是假绿）
    expect(terminalStates(V1_DONE).includes('done'), 'v1 里 done 是终态').toBe(true);
    expect(terminalStates(V2_FINISHED).includes('done'), 'v2 里 done 有出边 ⇒ 不是终态').toBe(false);
    expect(
      activeStates(V2_FINISHED),
      "v2 里 done 是活跃态 ⇒ 并集二道过滤会放行 'done'",
    ).toContain('done');

    const { client, calls } = makeTransportClient([{ ...transportRow, status: 'done', def_version: 1 }]);
    h.client = client;
    const hits = await runTransportSlaScanForTenant(TENANT);
    expect(hits, "锁着 v1 的单 status='done'：按 v1 它已终结 ⇒ 不得升级").toHaveLength(0);
    expect(calls.find((c) => c.text.includes('UPDATE transport_order SET escalated_at'))).toBeUndefined();
    expect(calls.find((c) => c.text.includes('INSERT INTO notification'))).toBeUndefined();
  });

  // ===== 批 8-2 · 变异守卫：SQL 预过滤必须是**交集**，写成并集就会漏告警 =====
  /**
   * 【守的是什么】SQL 预过滤是 `status <> ALL(各版本 dead 集的 X)`。
   *   X = 交集 ⇒ 只挡"在每个版本里都 dead"的状态，保守侧、不漏告警；
   *   X = 并集 ⇒ 把"只在某些版本里 dead"的状态也挡掉 ⇒ **漏告警**（违反 E3，比误升级更隐蔽）。
   *   'done' 正好是那个分水岭：v1 里 dead、v2 里活跃。
   *   锁 v2 的单 status='done' 必须命中——交集放行它，并集挡掉它。
   */
  it('🔴 运送线：SQL 预过滤写成并集会漏告警（锁 v2 的 status=done 必须照常命中）', async () => {
    // —— 先证明 'done' 确实横跨两侧（否则本例是假绿）
    expect(isDeadIn(V1_DONE, 'done'), "v1 里 done 是 dead ⇒ 并集会把它挡掉").toBe(true);
    expect(isDeadIn(V2_FINISHED, 'done'), "v2 里 done 不是 dead ⇒ 交集不会挡它").toBe(false);
    expect(activeStates(V2_FINISHED).includes('done'), "v2 里 done 是活跃态 ⇒ 按行判定会放行").toBe(true);

    const { client, calls } = makeTransportClient([{ ...transportRow, status: 'done', def_version: 2 }]);
    h.client = client;
    const hits = await runTransportSlaScanForTenant(TENANT);
    expect(hits, "锁着 v2 的单 status='done'：按 v2 它在途 ⇒ 必须命中（并集挡掉 ⇒ 漏告警）").toHaveLength(1);
    expect(calls.find((c) => c.text.includes('UPDATE transport_order SET escalated_at'))).toBeTruthy();
  });
});

describe('runSlaScanForTenant（续）', () => {
  it('runSlaSchedulerOnce：枚举租户逐个扫描并汇总命中数', async () => {
    const { client } = makeClient([overdueRow]);
    h.client = client;
    h.tenants = [TENANT, 't-other'];
    const total = await runSlaSchedulerOnce();
    expect(total).toBe(2); // 两个租户各命中同一 overdue 种子（fake client 复用）
  });
});
