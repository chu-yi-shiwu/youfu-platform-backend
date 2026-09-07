// adminAgentTools.test.ts —— 智能体批次一只读工具执行器单测（2026-09-07）。
// 重点：sanitize 复洗 + 确定性关键词兜底 augment（live 探针 P2/P4 教训：模型丢条件，原话为准）。
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/pool.js', () => ({
  withTenantClient: (_t: string, fn: (c: unknown) => unknown) => fn(clientForTest),
}));
let clientForTest: any = {};
const listMock = vi.fn(async (_c: unknown, _t: string, _f: unknown) => ({ items: [], total: 0 }));
vi.mock('../repo/ticket.js', () => ({ list: (...a: unknown[]) => (listMock as any)(...a) }));
vi.mock('../engine/workflowDef.js', () => ({ getWorkflowDef: async () => ({ key: 'work_order', states: [] }) }));
vi.mock('../engine/stateMachine.js', () => ({ doneStates: () => ['completed', 'closed', 'evaluated'] }));

import { makeAdminToolExecutor } from '../services/adminAgentTools.js';

const executor = makeAdminToolExecutor('t-test');

beforeEach(() => {
  listMock.mockClear();
  listMock.mockImplementation(async (_c: unknown, _t: string, _f: unknown) => ({ items: [], total: 0 }));
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
});
