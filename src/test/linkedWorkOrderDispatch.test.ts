// 纵切修复批次 V1（2026-09-14）：
//   P0-3 联动单派单未命中补 else：此前工单无声卡死 draft，现落 claim_hall + enter_hall 事件（对齐 workOrder.ts 样板）；
//   P0-4 派单未命中通知管理员（镜像 slaScheduler admin fan-out）。
// 范式与 autoDispatch.test.ts 相同：mock client + SQL 子串分流（无真实 PG）；createWithIdem mock。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../repo/ticket.js', () => ({ createWithIdem: vi.fn() }));

const { createLinkedWorkOrder } = await import('../services/linkedWorkOrder.js');
const { createWithIdem } = await import('../repo/ticket.js');

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

const WO_ID = 'wo-linked-1';
const ORDER_NO = 'WO_20260914_0000000001';

function linkedHandler(opts: { workerRows?: any[]; ruleRows?: any[]; adminRows?: any[] } = {}): QueryFn {
  return async (text: string) => {
    if (text.includes('FROM worker WHERE tenant_id')) return { rows: opts.workerRows ?? [] };
    if (text.includes('FROM dispatch_rule WHERE')) return { rows: opts.ruleRows ?? [] };
    if (text.includes('SELECT def FROM workflow_def')) return { rows: [] }; // 无自定义 def → DEFAULT（initial=draft）
    if (text.includes("SELECT id FROM account_user WHERE tenant_id=$1 AND role='admin'")) {
      return { rows: opts.adminRows ?? [] };
    }
    if (text.includes('UPDATE work_orders SET status')) return { rows: [] };
    if (text.includes('UPDATE worker SET load')) return { rows: [] };
    if (text.includes('INSERT INTO ticket_event')) return { rows: [] };
    if (text.includes('INSERT INTO domain_event')) return { rows: [] };
    if (text.includes('INSERT INTO notification')) return { rows: [] };
    return { rows: [] };
  };
}

function basePayload(over: Record<string, unknown> = {}) {
  return {
    id: WO_ID,
    tenantId: 't-verification',
    businessType: 'inspection',
    catalog: 'inspection',
    priority: 'normal',
    sourceType: 'inspection',
    sourceId: 'task-1',
    ...over,
  } as any;
}

describe('linkedWorkOrder 派单未命中兜底（纵切② P0-3/P0-4）', () => {
  beforeEach(() => {
    (createWithIdem as any).mockReset();
    (createWithIdem as any).mockResolvedValue({
      row: { id: WO_ID, order_no: ORDER_NO, auto_flow: false, assignee_id: null },
      created: true,
    });
  });

  it('P0-3：picked=null → UPDATE status=claim_hall + enter_hall 事件（from=initial draft, to=claim_hall）', async () => {
    const { client, calls } = makeClient(linkedHandler({ workerRows: [] }));
    const r = await createLinkedWorkOrder(client, basePayload());
    expect(r.created).toBe(true);
    expect(r.autoFlow).toBe(false);
    expect(r.assignee).toBeNull();
    // 状态落抢单大厅（auto_flow=false）
    const statusUpd = calls.find((c) => c.text.includes('UPDATE work_orders SET status'));
    expect(statusUpd).toBeTruthy();
    expect(statusUpd?.params?.[0]).toBe('claim_hall');
    expect(statusUpd?.params?.[1]).toBe(WO_ID);
    // enter_hall 事件：type/actor 内联，from=initial(draft) → to=claim_hall，payload reason 逐字对齐样板
    const evt = calls.find((c) => c.text.includes('INSERT INTO ticket_event'));
    expect(evt?.text).toContain("'enter_hall'");
    expect(evt?.text).toContain("'system'");
    expect(evt?.params?.[2]).toBe('draft');
    expect(evt?.params?.[3]).toBe('claim_hall');
    expect(JSON.parse(String(evt?.params?.[4]))).toEqual({ reason: 'linked order no worker auto-matched' });
  });

  it('P0-4：picked=null + 有 active admin → 账号通知落库（文案含「抢单大厅」）', async () => {
    const { client, calls } = makeClient(
      linkedHandler({ workerRows: [], adminRows: [{ id: 'u-admin-1' }, { id: 'u-admin-2' }] }),
    );
    await createLinkedWorkOrder(client, basePayload());
    const notifies = calls.filter((c) => c.text.includes('INSERT INTO notification'));
    expect(notifies.length).toBe(2);
    const allParams = JSON.stringify(notifies.map((n) => n.params));
    expect(allParams).toContain('u-admin-1');
    expect(allParams).toContain('u-admin-2');
    expect(allParams).toContain('抢单大厅');
    expect(allParams).toContain(ORDER_NO);
    // QA-P1：成功路径——SAVEPOINT 建立并 RELEASE，事务干净提交
    expect(calls.find((c) => c.text.includes('SAVEPOINT dispatch_notify_sp'))).toBeTruthy();
    expect(calls.find((c) => c.text.includes('RELEASE SAVEPOINT dispatch_notify_sp'))).toBeTruthy();
    expect(calls.find((c) => c.text.includes('ROLLBACK TO SAVEPOINT dispatch_notify_sp'))).toBeUndefined();
  });

  it('P0-4：管理员通知失败不阻断主流程（best-effort 吞错，claim_hall 照常落）', async () => {
    const { client, calls } = makeClient(async (text: string) => {
      if (text.includes("SELECT id FROM account_user WHERE tenant_id=$1 AND role='admin'")) {
        throw new Error('db hiccup');
      }
      return linkedHandler({ workerRows: [] })(text);
    });
    const r = await createLinkedWorkOrder(client, basePayload());
    expect(r.created).toBe(true); // 主流程未被通知故障阻断
    expect(calls.find((c) => c.text.includes('UPDATE work_orders SET status'))?.params?.[0]).toBe('claim_hall');
    expect(calls.filter((c) => c.text.includes('INSERT INTO notification')).length).toBe(0);
    // QA-P1：SAVEPOINT 隔离——失败段被 ROLLBACK TO 回滚（事务恢复可用），且不误发 RELEASE
    expect(calls.find((c) => c.text.includes('SAVEPOINT dispatch_notify_sp'))).toBeTruthy();
    expect(calls.find((c) => c.text.includes('ROLLBACK TO SAVEPOINT dispatch_notify_sp'))).toBeTruthy();
    expect(calls.find((c) => c.text.includes('RELEASE SAVEPOINT dispatch_notify_sp'))).toBeUndefined();
  });

  it('回归：有可用工人 → 照常自动派单（不走 claim_hall 分支）', async () => {
    const WORKER_ID = 'w-linked-1';
    const { client, calls } = makeClient(
      linkedHandler({ workerRows: [{ id: WORKER_ID, skill_tags: '["inspection"]', load: 0, active: true }] }),
    );
    const r = await createLinkedWorkOrder(client, basePayload({ skillTags: ['inspection'] }));
    expect(r.autoFlow).toBe(true);
    expect(r.assignee).toBe(WORKER_ID);
    expect(calls.find((c) => c.text.includes('UPDATE work_orders SET status'))?.params?.[0]).not.toBe('claim_hall');
    // picked 分支无 enter_hall / 无 admin 通知
    expect(calls.find((c) => c.text.includes("'enter_hall'"))).toBeUndefined();
    expect(calls.find((c) => c.text.includes('INSERT INTO notification'))).toBeUndefined();
  });
});
