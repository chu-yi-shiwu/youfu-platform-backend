// adminAgentTools.test.ts —— 智能体批次一只读工具执行器单测（2026-09-07）。
// 重点：sanitize 复洗 + 确定性关键词兜底 augment（live 探针 P2/P4 教训：模型丢条件，原话为准）。
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/pool.js', () => ({
  withTenantClient: (_t: string, fn: (c: unknown) => unknown) => fn(clientForTest),
}));
let clientForTest: any = {};
const listMock = vi.fn(async (_c: unknown, _t: string, _f: unknown): Promise<{ items: any[]; total: number }> => ({ items: [], total: 0 }));
vi.mock('../repo/ticket.js', () => ({ list: (...a: unknown[]) => (listMock as any)(...a) }));
// F10：租户流程的状态集合做成可变量——"原话关键词→状态名"的翻译必须按它过滤
// T1-B M2：另加 live / versions 两个可变项，用来钉住「排除集取各版本交集」而不是只读 live 一份。
const hDef = vi.hoisted(() => ({
  states: [] as string[],
  live: null as unknown, // getWorkflowDef 的返回值；null ⇒ 沿用 legacy 形状（既有用例零改动）
  versions: [] as unknown[], // getDefsAcrossAllVersions 的返回值（各在用版本）；空 ⇒ 只有 live 一份
}));
// 【为什么 intersectStates / unionStates 用真实现】本批要钉的就是"调用点选了并集还是交集"——
//   若在 mock 里再抄一份口径，测试就变成用自己抄的答案验自己，修错也恒绿。
//   只替换两个**读库**的函数，纯函数仍走真模块（importOriginal 展开）。
vi.mock('../engine/workflowDef.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getWorkflowDef: async () => hDef.live ?? { key: 'work_order', states: hDef.states },
    getDefsAcrossAllVersions: async () =>
      hDef.versions.length > 0 ? hDef.versions : [hDef.live ?? { key: 'work_order', states: hDef.states }],
  };
});
vi.mock('../engine/stateMachine.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    // 既有用例的 def 不带 config ⇒ 保持旧的常量三态（零回归）；多版本用例走 def.config.doneStates。
    doneStates: (def: any) =>
      Array.isArray(def?.config?.doneStates) && def.config.doneStates.length > 0
        ? def.config.doneStates
        : ['completed', 'closed', 'evaluated'],
  };
});

import { makeAdminToolExecutor } from '../services/adminAgentTools.js';

const executor = makeAdminToolExecutor('t-test');

beforeEach(() => {
  listMock.mockClear();
  listMock.mockImplementation(async (_c: unknown, _t: string, _f: unknown): Promise<{ items: any[]; total: number }> => ({ items: [], total: 0 }));
});

describe('query_tickets（sanitize 复洗 + 关键词兜底）', () => {
  it('模型丢条件时原话兜底：「今天有多少urgent工单」→ priority=urgent + today_only', async () => {
    await executor('query_tickets', {}, '今天有多少urgent工单');
    const f = listMock.mock.calls[0][2] as any;
    expect(f.priority).toBe('urgent');
    expect(f.createdSince).toBeInstanceOf(Date);
  });

  it('模型 args 与原话冲突时以原话为准：args.normal + 消息含「紧急」→ urgent', async () => {
    await executor('query_tickets', { priority: 'normal' }, '查紧急单');
    const f = listMock.mock.calls[0][2] as any;
    expect(f.priority).toBe('urgent');
  });

  it('「处理中的单」→ status=assigned,processing（P4 回归）', async () => {
    await executor('query_tickets', {}, '查一下处理中的单');
    const f = listMock.mock.calls[0][2] as any;
    expect(f.status).toBe('assigned,processing');
  });

  it('F10：租户流程没有 assigned/processing 时，不再硬翻成这两个名字去查（旧口径必然查 0 单）', async () => {
    hDef.states = ['inbox', 'doing', 'finish'];
    listMock.mockClear();
    await executor('query_tickets', {}, '查一下处理中的单');
    const f = listMock.mock.calls[0][2] as any;
    expect(f.status).toBeUndefined(); // 不再臆造状态名；查全量由 list 自己按可见范围给
    hDef.states = [];
  });

  it('F10：租户流程含 assigned/processing 时行为逐字不变（零回归）', async () => {
    hDef.states = ['draft', 'assigned', 'processing', 'completed'];
    listMock.mockClear();
    await executor('query_tickets', {}, '查一下处理中的单');
    const f = listMock.mock.calls[0][2] as any;
    expect(f.status).toBe('assigned,processing');
    hDef.states = [];
  });

  // ===================== T1-B：关键词→状态名的白名单（包含判定）不得只读 live 一份 =====================
  /**
   * 【洞】`augmentArgsFromMessage` 的 `keep()` 是**包含**判定（候选状态名必须在 def.states 里才保留），
   *   但白名单只读了 live 一份 ⇒ 客户改过流程后，老单所在版本（v1）独有的状态名 live 不认
   *   ⇒ 这个状态名**翻译不出来** ⇒ 那批锁着 v1 的老单查不出来（不误翻，只是不命中，退化成漏翻）。
   *   按 T1-B 兜底原则：包含判定取各版本**并集**（unionStates）。
   *
   * 【fixture 为什么这么排】两版必须"各只认一个候选名"，否则「live 一份」与「并集」结果相同 ⇒ 修前也绿（假绿）：
   *   - v1（老流程，存量单锁它）只认 X='assigned'
   *   - v2（当前 live）只认 Y='processing'
   *   ⇒ live 一份只能翻出 Y；并集才能同时翻出 X 和 Y。
   */
  const X = 'assigned'; // 只有老版本 v1 认这个名字
  const Y = 'processing'; // 只有当前 live 的 v2 认这个名字
  const V1_OLD = { key: 'work_order', states: ['draft', X, 'completed'], config: { doneStates: ['completed'] } };
  const V2_LIVE = { key: 'work_order', states: ['draft', Y, 'completed'], config: { doneStates: ['completed'] } };

  it('🔴 关键词→状态名的白名单取各版本并集：老版本独有的状态名也要能翻出来', async () => {
    // —— 假绿防护 1：两版的候选状态名确实不同（一个含 X 不含 Y，另一个含 Y 不含 X）
    expect(V1_OLD.states).toContain(X);
    expect(V1_OLD.states).not.toContain(Y);
    expect(V2_LIVE.states).toContain(Y);
    expect(V2_LIVE.states).not.toContain(X);
    // —— 假绿防护 2：本题与完成态口径无关（两版 config 逐字相同 ⇒ doneStates 不可能造成差异）
    expect(JSON.stringify(V1_OLD.config)).toBe(JSON.stringify(V2_LIVE.config));

    hDef.live = V2_LIVE;
    hDef.versions = [V1_OLD, V2_LIVE];
    listMock.mockClear();
    try {
      await executor('query_tickets', {}, '查一下处理中的单');
      const f = listMock.mock.calls[0][2] as any;
      expect(f, 'query_tickets 必须真的去查了库（否则下面断言空转）').toBeTruthy();
      const got = String(f.status ?? '').split(',').filter(Boolean);
      expect(got, '并集 ⇒ 只有老版本认的 assigned 也要能翻出来').toContain(X);
      expect(got, '并集 ⇒ live 认的 processing 也不能丢').toContain(Y);
      expect(got, '只读 live 一份 ⇒ 只翻得出 processing（这正是要修掉的旧行为）').not.toEqual([Y]);
    } finally {
      hDef.live = null;
      hDef.versions = [];
    }
  });

  it('模型给了合法条件则不覆盖：args.status=pending + 消息含「处理中」→ 不追加', async () => {
    await executor('query_tickets', { status: 'pending' }, '处理中的单');
    const f = listMock.mock.calls[0][2] as any;
    expect(f.status).toBe('pending');
  });

  it('limit 钳位 10；结果卡条数封顶 5、total 真实；超 5 条话术带提示', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      id: `wo-${i}`, order_no: `WO-${i}`, status: 'pending', priority: 'urgent', assignee_name: null, created_at: '2026-09-07T00:00:00Z',
    }));
    listMock.mockImplementation(async (_c: unknown, _t: string, f: any) => ({ items: rows.slice(0, f.limit), total: 99 }));
    const out = await executor('query_tickets', { limit: 50 }, '');
    expect(out).not.toBeNull();
    const f = listMock.mock.calls[0][2] as any;
    expect(f.limit).toBe(10);
    const card = out!.card as any;
    expect(card.type).toBe('ticket_result');
    expect(card.total).toBe(99);
    expect(card.items.length).toBeLessThanOrEqual(5);
    expect(out!.reply).toContain('99');
  });

  it('未知工具 → null', async () => {
    expect(await executor('drop_table', {})).toBeNull();
  });
});

describe('get_stats（今日概览）', () => {
  it('返回 usage_stats 卡：今日按状态 + 未完成总数（排除 done 状态）', async () => {
    clientForTest = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('GROUP BY status')) return { rows: [{ status: 'pending', c: 2 }, { status: 'completed', c: 1 }] };
        return { rows: [{ c: 7 }] };
      }),
    };
    const out = await executor('get_stats', {});
    expect(out).not.toBeNull();
    const card = out!.card as any;
    expect(card.type).toBe('usage_stats');
    expect(card.total_today).toBe(3);
    expect(card.open_total).toBe(7);
    expect(out!.reply).toContain('今日新增 3 单');
    expect(out!.reply).toContain('未完成 7 单');
  });

  // ===================== T1-B · M2（独立评审）：排除判定不得只读 live 一份 =====================
  /**
   * 【洞】`status <> ALL($2::text[])` 是**排除**判定，但 done 只从 live def 派生 ⇒
   *   客户改过流程后，老单（锁 v1）的状态在 v1 里算未完成、在 v2(live) 里被算成完成
   *   ⇒ 这批老单被 `status <> ALL` 静默排掉 ⇒ 「当前未完成 N 单」**少报**。
   * 【修法】排除集取各版本**交集**（只排除每个版本都认是完成态的状态）。
   *
   * 【fixture 为什么这么排】三口径必须两两不同，否则用例没有判别力：
   *   交集=['done'] ／ live 一份=['done','Y'] ／ 并集=['done','X','Y']。
   *   ⇒ 必须让"多出来的那个态"落在 **live** 那版（X 在 v1、Y 在 v2）；
   *     若照"老版多一个态"排（v1=['done','X']、v2=['done']），交集恰好等于 live ⇒ 修前也绿（假绿）。
   */
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

  it('🔴 未完成排除集取各版本交集：既不是 live 一份，也不是并集', async () => {
    // —— 假绿防护：两版完成态确实不同（否则"交集 vs 并集"无从判别）
    expect(V1_OLD.config.doneStates).toEqual(['done', 'X']);
    expect(V2_LIVE.config.doneStates).toEqual(['done', 'Y']);

    const calls: Array<{ sql: string; params: unknown[] }> = [];
    hDef.live = V2_LIVE;
    hDef.versions = [V1_OLD, V2_LIVE];
    clientForTest = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('GROUP BY status')) return { rows: [{ status: 'pending', c: 2 }] };
        return { rows: [{ c: 7 }] };
      },
    };
    try {
      const out = await executor('get_stats', {});
      // 前提成立：排除查询真的发了（否则下面的 params 断言是空转）
      expect(out, 'get_stats 必须返回结果卡').not.toBeNull();
      const openCall = calls.find((c) => c.sql.includes('status <> ALL'));
      expect(openCall, '未完成计数必须真的走排除查询').toBeTruthy();
      const exclude = openCall!.params[1] as string[];
      expect(exclude, '交集 = 只排除每版都认是完成态的状态 ⇒ 只有 done').toEqual(['done']);
      expect(exclude, 'Y 只被 live 认作完成 ⇒ 不得排除（否则老单被丢）').not.toContain('Y');
      expect(exclude, 'X 只被 v1 认作完成 ⇒ 不得排除（并集才会带它）').not.toContain('X');
    } finally {
      hDef.live = null;
      hDef.versions = [];
    }
  });
});
