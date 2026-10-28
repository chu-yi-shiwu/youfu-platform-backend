// 纵切修复批次 V1（2026-09-14）：
//   P0-3 联动单派单未命中补 else：此前工单无声卡死 draft，现落 claim_hall + enter_hall 事件（对齐 workOrder.ts 样板）；
//   P0-4 派单未命中通知管理员（镜像 slaScheduler admin fan-out）。
// 范式与 autoDispatch.test.ts 相同：mock client + SQL 子串分流（无真实 PG）；createWithIdem mock。
import { describe, it, expect, vi, beforeEach } from 'vitest';

// F4（2026-10-19）：派中段改走 transition() 主通道——mock 必须暴露 transition；
// transition 内部的门禁/副作用/自动审核由 repo 层测试守护，本文件只管 linkedWorkOrder 编排。
vi.mock('../repo/ticket.js', () => ({ createWithIdem: vi.fn(), transition: vi.fn() }));

const { createLinkedWorkOrder } = await import('../services/linkedWorkOrder.js');
const { createWithIdem, transition } = await import('../repo/ticket.js');

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

function linkedHandler(opts: {
  workerRows?: any[];
  ruleRows?: any[];
  adminRows?: any[];
  /** 洞③-2b：fault_category 上配的 skill_tags（派生技能的数据源）。默认空 = 派生不出技能。 */
  catalogRows?: any[];
} = {}): QueryFn {
  return async (text: string) => {
    if (text.includes('FROM worker WHERE tenant_id')) return { rows: opts.workerRows ?? [] };
    if (text.includes('FROM fault_category')) return { rows: opts.catalogRows ?? [] };
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
    (transition as any).mockReset();
    (transition as any).mockResolvedValue({ row: {}, transition: null, from: 'draft' });
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
    // F8（2026-10-19）：落大厅由旁路 UPDATE 改为 transition() 主通道——
    //   ① 不再有任何旁路 UPDATE status（否则就是又开了后门）；
    //   ② transition 目标态 = claim_hall、事件类型 = enter_hall、系统 actor 跳过人类门禁；
    //   ③ 失配原因 reason 经 payloadExtra 携带（GET /stats 的 claim_hall_reasons 聚合口径保住）。
    expect(calls.find((c) => c.text.includes('UPDATE work_orders SET status'))).toBeUndefined();
    expect(calls.find((c) => c.text.includes('INSERT INTO ticket_event'))).toBeUndefined();
    expect(transition).toHaveBeenCalledTimes(1);
    const tArgs = (transition as any).mock.calls[0];
    expect(tArgs[2]).toBe(WO_ID);
    expect(tArgs[3]).toBe('claim_hall');
    expect(tArgs[4]).toMatchObject({ actor: 'auto_dispatch', autoFlow: false, systemAuto: true, eventLogType: 'enter_hall' });
    // V2-F3（派单纵切 P0-8）：无任何工人 → 容量问题口径 no_available_worker
    expect(tArgs[4].payloadExtra).toEqual({ reason: 'no_available_worker' });
  });

  it('V2-F3：有在岗工人但技能失配（规则/兜底都没接住）→ reason=no_rule_matched（P0-8 失配观测口）', async () => {
    const { client } = makeClient(
      linkedHandler({ workerRows: [{ id: 'w-linked-2', skill_tags: '["cleaning"]', load: 0, active: true }] }),
    );
    const r = await createLinkedWorkOrder(client, basePayload({ skillTags: ['inspection'] }));
    expect(r.autoFlow).toBe(false);
    expect(r.assignee).toBeNull();
    // 有 active 工人却没派出去 → 配置/技能失配口径 no_rule_matched（正是「空调单派给电工」类事故的观测口）
    expect((transition as any).mock.calls[0][4]).toMatchObject({ eventLogType: 'enter_hall' });
    expect((transition as any).mock.calls[0][4].payloadExtra).toEqual({ reason: 'no_rule_matched' });
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
    // F8：落大厅走主通道（通知段失败不影响 transition 已完成的落厅）
    expect((transition as any).mock.calls[0][3]).toBe('claim_hall');
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
    // F4：派中走 transition() 主通道（DEFAULT def：draft→assigned assign 边），
    //   系统 actor + autoFlow=true + eventLogType='assign' 钉死口径
    expect(transition).toHaveBeenCalledTimes(1);
    const tArgs = (transition as any).mock.calls[0];
    expect(tArgs[2]).toBe(WO_ID);
    expect(tArgs[3]).toBe('assigned');
    expect(tArgs[4]).toMatchObject({ actor: 'auto_dispatch', autoFlow: true, eventLogType: 'assign' });
    expect(tArgs[4].fields).toMatchObject({ assignee: WORKER_ID });
    // picked 分支无 enter_hall / 无 admin 通知
    expect(calls.find((c) => c.text.includes("'enter_hall'"))).toBeUndefined();
    expect(calls.find((c) => c.text.includes('INSERT INTO notification'))).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 洞③-2b：联动单是 4 条建单路径里最弱的一条——它连 resolveNeed 都没 import，
//   :131 自己 resolveDispatch、:132 自己 pickWorker，且兜底用的是调用方**原始**
//   p.skillTags（与 workOrder.ts 洞③-2a 同一个"假中"病灶，且更重：连派生都没有）。
// 本组断言：修完后这条路径的派中结果与批 2 修完的 workOrder.ts **同场景同结果**。
// ═══════════════════════════════════════════════════════════════════════════
describe('洞③-2b · 联动单派单口径对齐主路径（补齐 resolveNeed）', () => {
  beforeEach(() => {
    (transition as any).mockReset();
    (transition as any).mockResolvedValue({ row: {}, transition: null, from: 'draft' });
    (createWithIdem as any).mockReset();
    (createWithIdem as any).mockResolvedValue({
      row: { id: WO_ID, order_no: ORDER_NO, auto_flow: false, assignee_id: null },
      created: true,
    });
  });

  it('① 3 名在岗工人只有 1 名具备派生技能 ⇒ 派中的必须是那名有技能的（与 workOrder.ts 同场景同结果）', async () => {
    const { client } = makeClient(
      linkedHandler({
        catalogRows: [{ skill_tags: '["electrician"]' }],
        workerRows: [
          { id: 'w-clean-1', skill_tags: '["cleaning"]', load: 0, active: true },
          { id: 'w-clean-2', skill_tags: '["cleaning"]', load: 0, active: true },
          { id: 'w-electrician', skill_tags: '["electrician"]', load: 7, active: true },
        ],
      }),
    );
    // 调用方**不传** skillTags（联动单的真实形态：巡检异常转维修单），技能全靠 catalog 派生
    const r = await createLinkedWorkOrder(client, basePayload({ catalog: 'electrical', skillTags: undefined }));
    expect(r.autoFlow).toBe(true);
    expect(r.assignee, '必须与 workOrder.ts 同场景派给同一个人（唯一具备派生技能的工人）').toBe('w-electrician');
  });

  it('② 没有任何匹配工人 ⇒ 不再"必中"，落 claim_hall 且 reason=no_rule_matched', async () => {
    const { client } = makeClient(
      linkedHandler({
        catalogRows: [{ skill_tags: '["electrician"]' }],
        workerRows: [
          { id: 'w-clean-1', skill_tags: '["cleaning"]', load: 0, active: true },
          { id: 'w-clean-2', skill_tags: '["cleaning"]', load: 0, active: true },
        ],
      }),
    );
    const r = await createLinkedWorkOrder(client, basePayload({ catalog: 'electrical', skillTags: undefined }));
    expect(r.autoFlow, '没有匹配工人就不该算派中').toBe(false);
    expect(r.assignee).toBeNull();
    const tArgs = (transition as any).mock.calls[0];
    expect(tArgs[3]).toBe('claim_hall');
    expect(tArgs[4].payloadExtra).toEqual({ reason: 'no_rule_matched' });
  });
});
