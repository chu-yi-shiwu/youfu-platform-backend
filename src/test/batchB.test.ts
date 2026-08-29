// 批次 B 单测：覆盖纯逻辑 + 转单幂等（防重单）。
// 不依赖真实 PG：用 fake client + mock repo 层，真跑核心分支，避免批次 A 式"假绿"。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeCheckout } from '../routes/volunteer.js';
import { generatePlanTasks } from '../routes/inspection.js';
import { createLinkedWorkOrder } from '../services/linkedWorkOrder.js';
import { createWithIdem } from '../repo/ticket.js';

vi.mock('../repo/ticket.js', () => ({ createWithIdem: vi.fn() }));

// 可控 fake client：覆盖 createLinkedWorkOrder 内部所有 query（sla/worker/dispatch_rule/派单回写）
function fakeClient() {
  return {
    query: async (text: string) => {
      if (text.includes('FROM worker')) return { rows: [] };
      if (text.includes('dispatch_rule')) return { rows: [] };
      if (text.startsWith('UPDATE') || text.startsWith('INSERT')) return { rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as any;
}

describe('志愿者积分计算（签退）', () => {
  it('0 分钟 → 0 分', () => {
    const r = computeCheckout(new Date('2026-01-01T09:00:00'), new Date('2026-01-01T09:00:00'));
    expect(r.duration_min).toBe(0);
    expect(r.points).toBe(0);
  });
  it('90 分钟 → 1 分', () => {
    const r = computeCheckout(new Date('2026-01-01T09:00:00'), new Date('2026-01-01T10:30:00'));
    expect(r.duration_min).toBe(90);
    expect(r.points).toBe(1);
  });
  it('125 分钟向下取整 → 2 分', () => {
    const r = computeCheckout(new Date('2026-01-01T09:00:00'), new Date('2026-01-01T11:05:00'));
    expect(r.duration_min).toBe(125);
    expect(r.points).toBe(2);
  });
  it('负时长（误签退）→ 0 分', () => {
    const r = computeCheckout(new Date('2026-01-01T10:00:00'), new Date('2026-01-01T09:00:00'));
    expect(r.duration_min).toBe(0);
    expect(r.points).toBe(0);
  });
});

describe('巡检计划生成', () => {
  it('按点位数量生成 pending 任务', () => {
    const rows = generatePlanTasks([{ id: 'a' }, { id: 'b' }], '2026-01-01T08:00:00');
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.status === 'pending' && r.type === 'plan')).toBe(true);
  });
  it('无点位 → 空数组', () => {
    expect(generatePlanTasks([], null).length).toBe(0);
  });
});

describe('转工单幂等（防重单）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('同一来源第二次转换不重复建单（created=false）', async () => {
    const client = fakeClient();
    (createWithIdem as any)
      .mockResolvedValueOnce({ row: { id: 'wo1', order_no: 'WO-001', auto_flow: false, assignee_id: null }, created: true })
      .mockResolvedValueOnce({ row: { id: 'wo1', order_no: 'WO-001', auto_flow: false, assignee_id: null }, created: false });
    const payload = {
      id: 'x',
      tenantId: 't1',
      businessType: 'inspection',
      catalog: 'inspection',
      priority: 'normal',
      sourceType: 'inspection',
      sourceId: 'task-1',
    } as any;
    const r1 = await createLinkedWorkOrder(client, payload);
    const r2 = await createLinkedWorkOrder(client, payload);
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r2.id).toBe('wo1');
  });
  it('无可用工人时不崩溃，降级 manual claim', async () => {
    const client = fakeClient();
    (createWithIdem as any).mockResolvedValue({
      row: { id: 'wo2', order_no: 'WO-002', auto_flow: false, assignee_id: null },
      created: true,
    });
    const r = await createLinkedWorkOrder(client, {
      id: 'y',
      tenantId: 't1',
      businessType: 'monitor',
      catalog: 'monitor',
      priority: 'urgent',
      sourceType: 'monitor',
      sourceId: 'alert-1',
    } as any);
    expect(r.created).toBe(true);
    expect(r.assignee).toBeNull();
    expect(r.reason).toBe('manual claim required');
  });
});
