// R31-F2（2026-08-31 全维度审查）：autoDispatchAfterCreate 此前零测试引用——
// 这是「公开报修单卡 draft、无派单、无通知」用户报障的修复点，必须有回归护栏。
// 用与 notify.test.ts 相同的 mock client + SQL 子串分流范式（无真实 PG）。
import { describe, it, expect, vi } from 'vitest';

const { autoDispatchAfterCreate } = await import('../routes/workOrder.js');

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;

function makeClient(handler: QueryFn) {
  const calls: Array<{ text: string; params?: any[] }> = [];
  return {
    client: {
      query: vi.fn(async (text: string, params?: any[]) => {
        calls.push({ text, params });
        return handler(text, params);
      }),
    } as any,
    calls,
  };
}

const WORKER_ID = '11111111-1111-4111-8111-111111111111';

function dispatchHandler(opts: { workerRows?: any[] } = {}): QueryFn {
  return async (text: string) => {
    if (text.includes('UPDATE work_orders SET sla_minutes')) return { rows: [] };
    if (text.includes('FROM worker WHERE tenant_id')) return { rows: opts.workerRows ?? [] };
    if (text.includes('FROM dispatch_rule WHERE')) return { rows: [] }; // 无规则 → least_load 兜底
    if (text.includes('SELECT def FROM workflow_def')) return { rows: [] }; // 无自定义 def → DEFAULT
    if (text.includes('SELECT params FROM model_state')) return { rows: [] };
    if (text.includes('UPDATE work_orders SET status')) return { rows: [] };
    if (text.includes('UPDATE worker SET load')) return { rows: [] };
    if (text.includes('INSERT INTO ticket_event')) return { rows: [] };
    if (text.includes('INSERT INTO domain_event')) return { rows: [] };
    if (text.includes('INSERT INTO notification')) return { rows: [] };
    return { rows: [] };
  };
}

const row = { id: '22222222-2222-4222-8222-222222222222', order_no: 'WO_20260831_0000000001' };
const need = { business_type: 'repair', skill_tags: null, priority: 'normal', catalog: 'electrical' };

describe('autoDispatchAfterCreate（R31-F2 回归护栏）', () => {
  it('有可用工人：SLA 起算 + 流转 assigned + worker load+1 + 事件 + 派单通知', async () => {
    const { client, calls } = makeClient(
      dispatchHandler({ workerRows: [{ id: WORKER_ID, skill_tags: '["electrical"]', load: 0, active: true }] }),
    );
    const r = await autoDispatchAfterCreate(client, 't-verification', row, need);
    expect(r.autoFlow).toBe(true);
    expect(r.assignee).toBe(WORKER_ID);
    expect(r.dispatchTarget).toBe('assigned');
    // SLA 起算（draft 态即计时）
    expect(calls.find((c) => c.text.includes('UPDATE work_orders SET sla_minutes'))).toBeTruthy();
    // 流转到 assigned 且写 assignee
    const statusUpd = calls.find((c) => c.text.includes('UPDATE work_orders SET status'));
    expect(statusUpd?.params).toEqual(['assigned', WORKER_ID, row.id]);
    // worker load +1
    expect(calls.find((c) => c.text.includes('UPDATE worker SET load'))?.params).toEqual([WORKER_ID]);
    // assign 事件（事件流；事件类型 'assign' 内联在 SQL 文本中，from=initial(draft)→to=assigned）
    const evt = calls.find((c) => c.text.includes('INSERT INTO ticket_event'));
    expect(evt?.text).toContain("'assign'");
    expect(evt?.params?.[2]).toBe('draft');
    expect(evt?.params?.[3]).toBe('assigned');
    // domain_event（结果状态口径 = dispatchTarget）
    const dom = calls.find((c) => c.text.includes('INSERT INTO domain_event'));
    expect(dom?.params).toContain('assigned');
    // 派单通知 fan-out（含 task-detail 深链 payload）
    const notify = calls.find((c) => c.text.includes('INSERT INTO notification'));
    expect(notify).toBeTruthy();
    expect(JSON.stringify(notify?.params)).toContain('task-detail');
  });

  it('无可用工人：落抢单大厅 claim_hall（enter_hall 事件），不派单不发通知', async () => {
    const { client, calls } = makeClient(dispatchHandler({ workerRows: [] }));
    const r = await autoDispatchAfterCreate(client, 't-verification', row, need);
    expect(r.autoFlow).toBe(false);
    expect(r.assignee).toBeNull();
    const statusUpd = calls.find((c) => c.text.includes('UPDATE work_orders SET status'));
    expect(statusUpd?.params?.[0]).toBe('claim_hall');
    const evt = calls.find((c) => c.text.includes('INSERT INTO ticket_event'));
    expect(evt?.text).toContain("'enter_hall'");
    expect(evt?.params?.[2]).toBe('claim_hall');
    expect(calls.find((c) => c.text.includes('INSERT INTO notification'))).toBeUndefined();
    expect(calls.find((c) => c.text.includes('UPDATE worker SET load'))).toBeUndefined();
  });

  it('worker 全部 inactive：等同无可用工人，落 claim_hall（不误派）', async () => {
    const { client, calls } = makeClient(
      dispatchHandler({ workerRows: [{ id: WORKER_ID, skill_tags: '["electrical"]', load: 0, active: false }] }),
    );
    const r = await autoDispatchAfterCreate(client, 't-verification', row, need);
    expect(r.autoFlow).toBe(false);
    expect(calls.find((c) => c.text.includes('UPDATE work_orders SET status'))?.params?.[0]).toBe('claim_hall');
  });
});
