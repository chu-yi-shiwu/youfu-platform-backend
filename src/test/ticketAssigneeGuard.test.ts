// 纵切修复批次 V1（2026-09-14）：
//   P0-5 transition() assignee 存在性校验：不存在的 worker id → 422 BAD_PARAM（此前静默落库派给幽灵工人）；
//   P0-6 显式携带 assignee 的流转追加 auto_flow = false（人工派单不再冒充自动派单）。
// 范式与 loadSymmetry.test.ts 相同：mock client + SQL 子串分流（无真实 PG）。
import { describe, it, expect } from 'vitest';

const { transition } = await import('../repo/ticket.js');

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;

function makeClient(opts: { workerExists: boolean; cur?: { status: string; assignee_id: string | null } }) {
  const calls: Array<{ text: string; params?: any[] }> = [];
  const cur = opts.cur ?? { status: 'draft', assignee_id: null };
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
      if (text.includes('SELECT 1 FROM worker')) {
        return opts.workerExists ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text.includes('UPDATE work_orders')) return { rows: [{ ...woRow, status: params?.[0] }] };
      return { rows: [] }; // ticket_event / domain_event / worker UPDATE 等
    }) as QueryFn,
  } as any;
  return { client, calls };
}

const TENANT = 't-verification';
const WO = '44444444-4444-4444-8444-444444444444';
const W1 = 'worker-001';

describe('transition assignee 守卫与 auto_flow 修正（纵切② P0-5/P0-6）', () => {
  it('P0-5：assignee 不存在/未启用 → 422 BAD_PARAM，且不发生任何 UPDATE', async () => {
    const { client, calls } = makeClient({ workerExists: false });
    await expect(
      transition(client, TENANT, WO, 'assigned', { actor: 'dispatcher', fields: { assignee: 'ghost-worker' } }),
    ).rejects.toMatchObject({ code: 'BAD_PARAM', status: 422 });
    expect(calls.find((c) => c.text.includes('UPDATE work_orders SET status'))).toBeUndefined();
    expect(calls.find((c) => c.text.includes('INSERT INTO ticket_event'))).toBeUndefined();
  });

  it('P0-5+P0-6：assignee 存在 → 通过，UPDATE 含 auto_flow = false 且写入 assignee_id', async () => {
    const { client, calls } = makeClient({ workerExists: true });
    const r = await transition(client, TENANT, WO, 'assigned', { actor: 'dispatcher', fields: { assignee: W1 } });
    expect(r.row.status).toBe('assigned');
    const upd = calls.find((c) => c.text.includes('UPDATE work_orders SET status'));
    expect(upd).toBeTruthy();
    expect(upd!.text).toContain('auto_flow = false');
    expect(upd!.text).toContain('assignee_id = $4');
    expect(upd!.params).toContain(W1);
    // 人工派单入场 load+1 行为保持（R32 回归不破坏）
    expect(calls.find((c) => c.text.includes('SET load = load + 1'))).toBeTruthy();
  });

  it('P0-6：不携带 assignee 的流转 → UPDATE 不追加 auto_flow（保持原口径）', async () => {
    const { client, calls } = makeClient({ workerExists: true });
    // draft→assigned 无 assignee（如系统流转）：DEFAULT def 合法边
    await transition(client, TENANT, WO, 'assigned', { actor: 'system' });
    const upd = calls.find((c) => c.text.includes('UPDATE work_orders SET status'));
    expect(upd).toBeTruthy();
    expect(upd!.text).not.toContain('auto_flow');
    expect(upd!.text).not.toContain('assignee_id');
  });

  it('P0-5：存在性校验按租户隔离（跨租户 worker id 视为不存在 → 422）', async () => {
    // mock 恒返回 rowCount=0 模拟"本租户查无此人"（SQL 自带 tenant_id = $2 条件）
    const { client } = makeClient({ workerExists: false });
    await expect(
      transition(client, TENANT, WO, 'assigned', { actor: 'dispatcher', fields: { assignee: 'other-tenant-worker' } }),
    ).rejects.toMatchObject({ code: 'BAD_PARAM', status: 422 });
  });
});
