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

function makeClient(opts: { guardRowCount?: number; autoTuneRow?: any } = {}) {
  const calls: Array<{ text: string; params?: any[] }> = [];
  const client = {
    query: vi.fn(async (text: string, params?: any[]) => {
      calls.push({ text, params });
      if (text.includes('SELECT def FROM workflow_def')) return { rows: [] }; // 无自定义 def → DEFAULT（learningTriggers 缺省 = doneStates = completed）
      // V2-F4（派单纵切 P0-10/11）：isAutoTuneEffective(client) 走同连接读租户持久化开关
      if (text.includes('SELECT auto_tune FROM tenant_settings')) {
        return { rows: opts.autoTuneRow !== undefined ? [opts.autoTuneRow] : [] };
      }
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

  // V2-F4（派单纵切 P0-10/11）：写回开关判定统一收敛到 isAutoTuneEffective——
  // env 未设（生产常态）时以租户持久化开关为准，修复「unset 恒 false ⇒ 界面开关死开关」。
  it('V2-F4：env 未设 + 租户开关 auto_tune=true → 学习写回开启（界面开关可恢复生效）', async () => {
    learnMock.mockResolvedValueOnce(undefined);
    const { client, calls } = makeClient({ guardRowCount: 1, autoTuneRow: { auto_tune: true } });
    const r = await runIncrementalLearnStep(client, TENANT, WO, 'completed', 'processing');
    expect(r.triggered).toBe(true);
    expect(r.learnError).toBeNull();
    expect(learnMock).toHaveBeenCalledTimes(1);
    expect(learnMock.mock.calls[0][3]).toBe(true); // 租户持久化开关=true → 写回开启
    expect(calls.find((c) => c.text.includes('RELEASE SAVEPOINT incremental_learn_sp'))).toBeTruthy();
  });

  it('V2-F4：env=false 为紧急熔断——即使租户开关=true 也强制关闭（fail-safe，生产行为不变）', async () => {
    process.env.MODEL_AUTO_TUNE = 'false';
    learnMock.mockResolvedValueOnce(undefined);
    const { client } = makeClient({ guardRowCount: 1, autoTuneRow: { auto_tune: true } });
    await runIncrementalLearnStep(client, TENANT, WO, 'completed', 'processing');
    expect(learnMock).toHaveBeenCalledTimes(1);
    expect(learnMock.mock.calls[0][3]).toBe(false); // env 熔断压过租户开关
  });
});
