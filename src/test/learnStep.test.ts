// R31-F2（2026-08-31 全维度审查）：SAVEPOINT 学习段隔离修复（063/T-A）此前零回归护栏。
// runIncrementalLearnStep 自 workOrder.ts 抽取后可单测；本文件验证：
//   1) 首次进入学习触发态 → SAVEPOINT + RELEASE，learn_error=null；
//   2) incrementalLearn 抛错 → ROLLBACK TO SAVEPOINT（主流转保真）+ learn_error 诚实回传；
//   3) ticket_learn_log 唯一键守卫拦截（rowCount=0）→ 不调用学习、无 SAVEPOINT；
//   4) 非触发态 → 直接短路。
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 拦截 incrementalLearn（真实实现会查库写库，此处按用例注入成功/失败行为）
vi.mock('../services/modelTrainer.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, incrementalLearn: vi.fn() };
});

const { runIncrementalLearnStep } = await import('../routes/workOrder.js');
const { incrementalLearn } = await import('../services/modelTrainer.js');
const learnMock = incrementalLearn as unknown as ReturnType<typeof vi.fn>;

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;

function makeClient(opts: { guardRowCount?: number } = {}) {
  const calls: Array<{ text: string; params?: any[] }> = [];
  const client = {
    query: vi.fn(async (text: string, params?: any[]) => {
      calls.push({ text, params });
      if (text.includes('SELECT def FROM workflow_def')) return { rows: [] }; // 无自定义 def → DEFAULT（learningTriggers 缺省 = doneStates = completed）
      if (text.includes('INSERT INTO ticket_learn_log')) return { rows: [], rowCount: opts.guardRowCount ?? 1 };
      return { rows: [] }; // SAVEPOINT / RELEASE / ROLLBACK 等
    }),
  } as any;
  return { client, calls };
}

const TENANT = 't-verification';
const WO = '33333333-3333-4333-8333-333333333333';

describe('runIncrementalLearnStep（SAVEPOINT 学习段回归护栏）', () => {
  beforeEach(() => {
    learnMock.mockReset();
    delete process.env.MODEL_AUTO_TUNE; // 与线上设计态一致（false）
  });

  it('首次进入 completed：SAVEPOINT + 学习 + RELEASE，learn_error=null', async () => {
    learnMock.mockResolvedValueOnce(undefined);
    const { client, calls } = makeClient({ guardRowCount: 1 });
    const r = await runIncrementalLearnStep(client, TENANT, WO, 'completed', 'processing');
    expect(r.triggered).toBe(true);
    expect(r.learnError).toBeNull();
    expect(learnMock).toHaveBeenCalledTimes(1);
    expect(learnMock.mock.calls[0][3]).toBe(false); // MODEL_AUTO_TUNE 未开 → 写回关闭
    expect(calls.find((c) => c.text.includes('SAVEPOINT incremental_learn_sp'))).toBeTruthy();
    expect(calls.find((c) => c.text.includes('RELEASE SAVEPOINT incremental_learn_sp'))).toBeTruthy();
    expect(calls.find((c) => c.text.includes('ROLLBACK TO SAVEPOINT'))).toBeUndefined();
  });

  it('🔴 核心回归：学习抛错 → ROLLBACK TO SAVEPOINT（主流转保真）+ learn_error 诚实回传', async () => {
    learnMock.mockRejectedValueOnce(new Error('no_match violates check'));
    const { client, calls } = makeClient({ guardRowCount: 1 });
    const r = await runIncrementalLearnStep(client, TENANT, WO, 'completed', 'processing');
    expect(r.learnError).toBe('no_match violates check');
    expect(calls.find((c) => c.text.includes('ROLLBACK TO SAVEPOINT incremental_learn_sp'))).toBeTruthy();
    expect(calls.find((c) => c.text.includes('RELEASE SAVEPOINT'))).toBeUndefined();
    // 学习段失败绝不触碰主流转：无任何 UPDATE work_orders 调用
    expect(calls.find((c) => c.text.includes('UPDATE work_orders'))).toBeUndefined();
  });

  it('结构性幂等守卫拦截（guard rowCount=0）：不调用学习、无 SAVEPOINT', async () => {
    const { client, calls } = makeClient({ guardRowCount: 0 });
    const r = await runIncrementalLearnStep(client, TENANT, WO, 'completed', 'processing');
    expect(r.triggered).toBe(true);
    expect(r.learnError).toBeNull();
    expect(learnMock).not.toHaveBeenCalled();
    expect(calls.find((c) => c.text.includes('SAVEPOINT'))).toBeUndefined();
  });

  it('非学习触发态（processing→processing 不在触发集）：直接短路', async () => {
    const { client, calls } = makeClient({ guardRowCount: 1 });
    const r = await runIncrementalLearnStep(client, TENANT, WO, 'processing', 'assigned');
    expect(r.triggered).toBe(false);
    expect(r.learnError).toBeNull();
    expect(learnMock).not.toHaveBeenCalled();
    expect(calls.find((c) => c.text.includes('INSERT INTO ticket_learn_log'))).toBeUndefined();
  });
});
