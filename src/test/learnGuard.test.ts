import { describe, it, expect, vi } from 'vitest';

// 结构性幂等守卫（027_ticket_learn_log）的本地分支验证。
// 真实 DB 唯一键幂等由 ECS 真验负责（双轨纪律）；此处用 mock client 验证：
// shouldTriggerLearning 命中后，仅 INSERT ... ON CONFLICT 的 rowCount===1（首插）才调用 incrementalLearn，
// 重复命中（rowCount=0，唯一键已存在）被结构性拦截，不调用、不报错。

// 复刻 workOrder.ts transition 学习块的核心决策，便于本地断言分支。
async function decideAndLearn(opts: {
  client: { query: (sql: string, p: unknown[]) => Promise<{ rowCount: number | null }> };
  tenantId: string;
  workOrderId: string;
  to: string;
  shouldLearn: boolean;
  incrementalLearn: ReturnType<typeof vi.fn>;
}) {
  const { client, tenantId, workOrderId, to, shouldLearn, incrementalLearn } = opts;
  if (!shouldLearn) return { learned: false, skipped: false };
  const guard = await client.query(
    `INSERT INTO ticket_learn_log (tenant_id, work_order_id, trigger_state, model_version)
     VALUES ($1,$2,$3,(SELECT version FROM model_state WHERE tenant_id=$1 AND model_key='dispatch_score'))
     ON CONFLICT (tenant_id, work_order_id, trigger_state) DO NOTHING`,
    [tenantId, workOrderId, to],
  );
  if (guard.rowCount === 1) {
    await incrementalLearn(client, tenantId, workOrderId, false);
    return { learned: true, skipped: false };
  }
  return { learned: false, skipped: true };
}

describe('结构性幂等守卫（ticket_learn_log）', () => {
  it('首次命中触发态：INSERT rowCount=1 → 调用 incrementalLearn', async () => {
    const incrementalLearn = vi.fn().mockResolvedValue(undefined);
    const client = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    const r = await decideAndLearn({
      client, tenantId: 't1', workOrderId: 'wo1', to: 'completed',
      shouldLearn: true, incrementalLearn,
    });
    expect(r.learned).toBe(true);
    expect(r.skipped).toBe(false);
    expect(incrementalLearn).toHaveBeenCalledTimes(1);
    // 守卫 INSERT 用到了唯一键三元组
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (tenant_id, work_order_id, trigger_state)'), expect.any(Array));
  });

  it('重复命中触发态：INSERT rowCount=0（唯一键冲突）→ 被拦截，不调用 incrementalLearn', async () => {
    const incrementalLearn = vi.fn().mockResolvedValue(undefined);
    const client = { query: vi.fn().mockResolvedValue({ rowCount: 0 }) };
    const r = await decideAndLearn({
      client, tenantId: 't1', workOrderId: 'wo1', to: 'completed',
      shouldLearn: true, incrementalLearn,
    });
    expect(r.learned).toBe(false);
    expect(r.skipped).toBe(true);
    expect(incrementalLearn).not.toHaveBeenCalled();
  });

  it('shouldTriggerLearning 判定为假时直接不学（不插入、不调用）', async () => {
    const incrementalLearn = vi.fn().mockResolvedValue(undefined);
    const client = { query: vi.fn() };
    const r = await decideAndLearn({
      client, tenantId: 't1', workOrderId: 'wo1', to: 'processing',
      shouldLearn: false, incrementalLearn,
    });
    expect(r).toEqual({ learned: false, skipped: false });
    expect(client.query).not.toHaveBeenCalled();
    expect(incrementalLearn).not.toHaveBeenCalled();
  });
});
