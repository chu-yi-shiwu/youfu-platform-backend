// R32 拆雷三件套①（2026-08-31 评估报告三条业务断链之一）：worker.load 只增不减回归护栏。
// 此前全库仅 3 处 load+1（workOrder.ts:79/:824、linkedWorkOrder.ts:106，均不走 transition），
// 完成/取消/改派路径无任何 -1——「load 回正」全靠清理时手工 SQL 掩盖缺陷。
// 修复：transition() 内按「活跃态进出 + assignee 变化」做净变化结算。本文件验证：
//   1) processing→completed（在身→离场）→ 旧 assignee GREATEST(load-1,0)，且无 +1；
//   2) assigned→processing（同活跃同 assignee）→ 不动 load；
//   3) draft→assigned 携带 assignee（人工派单入场）→ 新 assignee load+1；
//   4) -1 一律走 GREATEST 防负数护栏。
import { describe, it, expect } from 'vitest';

const { transition } = await import('../repo/ticket.js');

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;

function makeClient(cur: { status: string; assignee_id: string | null }) {
  const calls: Array<{ text: string; params?: any[] }> = [];
  const woRow = {
    id: '44444444-4444-4444-8444-444444444444',
    tenant_id: 't-verification',
    order_no: 'WO-TEST-1',
    status: cur.status,
    assignee_id: cur.assignee_id,
  };
  const client = {
    query: (async (text: string, params?: any[]) => {
      calls.push({ text, params });
      if (text.includes('FOR UPDATE')) return { rows: [woRow] };
      if (text.includes('SELECT def FROM workflow_def')) return { rows: [] }; // 无自定义 def → DEFAULT（4 态 3 转移）
      if (text.includes('UPDATE work_orders')) return { rows: [{ ...woRow, status: params?.[0] }] };
      return { rows: [] }; // ticket_event / domain_event / worker UPDATE 等
    }) as QueryFn,
  } as any;
  return { client, calls };
}

const TENANT = 't-verification';
const WO = '44444444-4444-4444-8444-444444444444';
const W1 = 'worker-001';

describe('transition worker.load 对称结算（R32 拆雷①回归护栏）', () => {
  it('🔴 核心回归：processing→completed → 旧 assignee load-1（GREATEST 防负），无 +1', async () => {
    const { client, calls } = makeClient({ status: 'processing', assignee_id: W1 });
    await transition(client, TENANT, WO, 'completed', { actor: 'worker' });
    const decs = calls.filter((c) => c.text.includes('GREATEST(load - 1, 0)'));
    expect(decs).toHaveLength(1);
    expect(decs[0].params).toEqual([W1, TENANT]);
    expect(calls.find((c) => c.text.includes('SET load = load + 1'))).toBeUndefined();
  });

  it('assigned→processing（同活跃同 assignee）→ 不触碰 load', async () => {
    const { client, calls } = makeClient({ status: 'assigned', assignee_id: W1 });
    await transition(client, TENANT, WO, 'processing', { actor: 'worker' });
    expect(calls.find((c) => c.text.includes('UPDATE worker'))).toBeUndefined();
  });

  it('draft→assigned 携带 assignee（人工派单入场）→ 新 assignee load+1', async () => {
    const { client, calls } = makeClient({ status: 'draft', assignee_id: null });
    await transition(client, TENANT, WO, 'assigned', { actor: 'dispatcher', fields: { assignee: W1 } });
    const incs = calls.filter((c) => c.text.includes('SET load = load + 1'));
    expect(incs).toHaveLength(1);
    expect(incs[0].params).toEqual([W1, TENANT]);
    expect(calls.find((c) => c.text.includes('GREATEST(load - 1, 0)'))).toBeUndefined();
  });

  it('无 assignee 的流转（如 draft 内部）→ 不触碰 load', async () => {
    const { client, calls } = makeClient({ status: 'draft', assignee_id: null });
    await transition(client, TENANT, WO, 'assigned', { actor: 'system' });
    expect(calls.find((c) => c.text.includes('UPDATE worker'))).toBeUndefined();
  });
});
