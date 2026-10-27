// R32 拆雷三件套②（2026-08-31）：SLA 闭环回归护栏。
// 此前断链：/sla/scan 仅能手动按租户触发 + 命中只落事件不落通知。
// 修复：抽 runSlaScanForTenant 共用实现 + 进程内 cron（sla_escalation_tenants 枚举）+ 命中补通知。
// 本文件验证（db/pool 整体 mock，无真实 PG）：
//   1) 超时活跃单 → escalated_at UPDATE + worker 通知 + admin 通知；
//   2) 未超时 / 已升级 → 零命中零通知；
//   3) runSlaSchedulerOnce 经 SECURITY DEFINER 枚举租户并汇总命中数。
import { describe, it, expect, vi } from 'vitest';
// 批 7：要断言「两版终态零交集」这个前提，得用真口径函数，不能手写常量。
import { doneStates, terminalStates } from '../engine/stateMachine.js';

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
        if (text.includes('FROM transport_order') && text.includes('status <> ALL')) return { rows };
        if (text.includes('FROM account_user')) return { rows: [{ id: ADMIN }] };
        return { rows: [] };
      }) as QueryFn,
    } as any;
    return { client, calls };
  }

  const transportRow = {
    id: 'TR-1',
    code: 'TR-CODE-1',
    status: 'doing',
    carrier: 'carrier-001',
    sla_due_at: new Date(Date.now() - 30 * 60_000),
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
