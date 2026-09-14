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

function dispatchHandler(opts: { workerRows?: any[]; ruleRows?: any[]; adminRows?: any[] } = {}): QueryFn {
  return async (text: string) => {
    if (text.includes('UPDATE work_orders SET sla_minutes')) return { rows: [] };
    if (text.includes('FROM worker WHERE tenant_id')) return { rows: opts.workerRows ?? [] };
    if (text.includes('FROM dispatch_rule WHERE')) return { rows: opts.ruleRows ?? [] }; // 无规则 → least_load 兜底
    if (text.includes('SELECT def FROM workflow_def')) return { rows: [] }; // 无自定义 def → DEFAULT
    if (text.includes('SELECT params FROM model_state')) return { rows: [] };
    if (text.includes("SELECT id FROM account_user WHERE tenant_id=$1 AND role='admin'")) {
      return { rows: opts.adminRows ?? [] }; // 纵切② P0-4：派单未命中通知管理员
    }
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

  it('无可用工人：落抢单大厅 claim_hall（enter_hall 事件），不派单给工人，但通知全部 active admin（纵切② P0-4）', async () => {
    const { client, calls } = makeClient(
      dispatchHandler({ workerRows: [], adminRows: [{ id: 'u-admin-1' }, { id: 'u-admin-2' }] }),
    );
    const r = await autoDispatchAfterCreate(client, 't-verification', row, need);
    expect(r.autoFlow).toBe(false);
    expect(r.assignee).toBeNull();
    const statusUpd = calls.find((c) => c.text.includes('UPDATE work_orders SET status'));
    expect(statusUpd?.params?.[0]).toBe('claim_hall');
    const evt = calls.find((c) => c.text.includes('INSERT INTO ticket_event'));
    expect(evt?.text).toContain("'enter_hall'");
    expect(evt?.params?.[2]).toBe('claim_hall');
    // 给工人的派单通知不出现（assignee 通知 only 在 picked 分支）
    expect(calls.filter((c) => c.text.includes('INSERT INTO notification')).length).toBe(2);
    expect(calls.find((c) => c.text.includes('UPDATE worker SET load'))).toBeUndefined();
    // 未命中通知管理员：2 名 active admin 各一条 account 通知，文案含「抢单大厅」
    const adminNotifies = calls.filter((c) => c.text.includes('INSERT INTO notification'));
    expect(adminNotifies.length).toBe(2);
    expect(JSON.stringify(adminNotifies.map((n) => n.params))).toContain('抢单大厅');
    expect(JSON.stringify(adminNotifies.map((n) => n.params))).toContain('u-admin-1');
    expect(JSON.stringify(adminNotifies.map((n) => n.params))).toContain('u-admin-2');
  });

  it('worker 全部 inactive：等同无可用工人，落 claim_hall（不误派）', async () => {
    const { client, calls } = makeClient(
      dispatchHandler({ workerRows: [{ id: WORKER_ID, skill_tags: '["electrical"]', load: 0, active: false }] }),
    );
    const r = await autoDispatchAfterCreate(client, 't-verification', row, need);
    expect(r.autoFlow).toBe(false);
    expect(calls.find((c) => c.text.includes('UPDATE work_orders SET status'))?.params?.[0]).toBe('claim_hall');
    // V2-F3：worker 全 inactive → 同口径 no_available_worker
    const evt0 = calls.find((c) => c.text.includes('INSERT INTO ticket_event'));
    expect(JSON.parse(String(evt0?.params?.[3]))).toEqual({ reason: 'no_available_worker' });
  });

  it('V2-F3：有在岗工人但技能失配（规则/兜底都没接住）→ reason=no_rule_matched（P0-8 失配观测口）', async () => {
    const { client, calls } = makeClient(
      dispatchHandler({ workerRows: [{ id: WORKER_ID, skill_tags: '["electrical"]', load: 0, active: true }] }),
    );
    const r = await autoDispatchAfterCreate(client, 't-verification', row, { ...need, skill_tags: ['plumbing'] });
    expect(r.autoFlow).toBe(false);
    expect(r.assignee).toBeNull();
    const evt = calls.find((c) => c.text.includes('INSERT INTO ticket_event'));
    expect(evt?.text).toContain("'enter_hall'");
    // 有 active 工人却没派出去 → 配置/技能失配口径 no_rule_matched
    expect(JSON.parse(String(evt?.params?.[3]))).toEqual({ reason: 'no_rule_matched' });
  });

  // 2026-09-14 纵切② P0-1：strategy:'least_load' 不再短路规则匹配。
  it('纵切② P0-1：least_load strategy + 规则命中 → 规则胜出（reason 含规则名，不再被静默废掉）', async () => {
    const rule = {
      id: 'r-electrical', name: '维修-电工优先', priority: 10,
      match_json: { business_type: 'repair' },
      strategy_json: { type: 'skill_match', skill_tags: ['electrical'] },
      weight: 1, score: 0,
    };
    const { client, calls } = makeClient(
      dispatchHandler({
        workerRows: [{ id: WORKER_ID, skill_tags: '["electrical"]', load: 0, active: true }],
        ruleRows: [rule],
      }),
    );
    const r = await autoDispatchAfterCreate(client, 't-verification', row, need);
    expect(r.autoFlow).toBe(true);
    expect(r.assignee).toBe(WORKER_ID);
    expect(r.reason).toContain('维修-电工优先');
    // 命中的是规则链路：assign 事件 + worker load+1 正常发生
    expect(calls.find((c) => c.text.includes("'assign'"))).toBeTruthy();
    expect(calls.find((c) => c.text.includes('UPDATE worker SET load'))).toBeTruthy();
  });

  it('纵切② P0-1：least_load strategy + 规则未命中 → 落 pickWorker 兜底（与旧版行为一致）', async () => {
    // 规则存在但 business_type 不匹配 → resolveDispatch 返回 null → 兜底选人（旧行为：least_load 直通兜底）
    const rule = {
      id: 'r-other', name: '保洁规则', priority: 10,
      match_json: { business_type: 'cleaning' },
      strategy_json: { type: 'load_balance' },
      weight: 1, score: 0,
    };
    const { client } = makeClient(
      dispatchHandler({
        workerRows: [{ id: WORKER_ID, skill_tags: '["electrical"]', load: 0, active: true }],
        ruleRows: [rule],
      }),
    );
    const r = await autoDispatchAfterCreate(client, 't-verification', row, need);
    expect(r.autoFlow).toBe(true);
    expect(r.assignee).toBe(WORKER_ID);
    expect(r.reason).toBe('auto dispatched by least_load fallback');
  });
});
