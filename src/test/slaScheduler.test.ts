// R32 拆雷三件套②（2026-08-31）：SLA 闭环回归护栏。
// 此前断链：/sla/scan 仅能手动按租户触发 + 命中只落事件不落通知。
// 修复：抽 runSlaScanForTenant 共用实现 + 进程内 cron（sla_escalation_tenants 枚举）+ 命中补通知。
// 本文件验证（db/pool 整体 mock，无真实 PG）：
//   1) 超时活跃单 → escalated_at UPDATE + worker 通知 + admin 通知；
//   2) 未超时 / 已升级 → 零命中零通知；
//   3) runSlaSchedulerOnce 经 SECURITY DEFINER 枚举租户并汇总命中数。
import { describe, it, expect, vi } from 'vitest';

// db/pool 整体 mock：withTenantClient 直接以测试注入的 fake client 执行；
// pool.query 供跨租户枚举（sla_escalation_tenants）与 lock（connect 抛错 → 降级放行）使用。
const h = vi.hoisted(() => ({ client: null as any, tenants: [] as string[] }));
vi.mock('../db/pool.js', () => ({
  default: {
    query: vi.fn(async (text: string) =>
      text.includes('sla_escalation_tenants') ? { rows: h.tenants.map((t) => ({ tenant_id: t })) } : { rows: [] },
    ),
    connect: vi.fn(async () => {
      throw new Error('no pg in tests'); // lock 降级放行路径
    }),
  },
  withTenantClient: vi.fn(async (_tenantId: string, fn: (c: any) => Promise<any>) => fn(h.client)),
}));

const { runSlaScanForTenant, runSlaSchedulerOnce } = await import('../scheduler/slaScheduler.js');

const TENANT = 't-verification';
const WO = '55555555-5555-4555-8555-555555555555';
const W1 = 'worker-001';
const ADMIN = 'admin-001';

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;

function makeClient(scanRows: any[]) {
  const calls: Array<{ text: string; params?: any[] }> = [];
  const client = {
    query: (async (text: string, params?: any[]) => {
      calls.push({ text, params });
      if (text.includes('SELECT def FROM workflow_def')) return { rows: [] }; // DEFAULT 状态机
      if (text.includes('FROM work_orders') && text.includes('status <> ALL')) return { rows: scanRows };
      if (text.includes('FROM account_user')) return { rows: [{ id: ADMIN }] };
      return { rows: [] }; // UPDATE / INSERT ticket_event / domain_event / notification / webhook_subscription
    }) as QueryFn,
  } as any;
  return { client, calls };
}

const overdueRow = {
  id: WO,
  status: 'processing',
  sla_due_at: new Date(Date.now() - 10 * 60_000),
  escalated_at: null,
  assignee_id: W1,
  order_no: 'WO-SLA-1',
};

describe('runSlaScanForTenant（SLA 闭环回归护栏）', () => {
  it('🔴 核心回归：超时活跃单 → 标记升级 + 在身 assignee 通知 + 租户管理员通知', async () => {
    const { client, calls } = makeClient([overdueRow]);
    h.client = client;
    const hits = await runSlaScanForTenant(TENANT);
    expect(hits).toHaveLength(1);
    expect(hits[0].workOrderId).toBe(WO);
    expect(hits[0].escalMinutes).toBeGreaterThanOrEqual(10);
    expect(calls.find((c) => c.text.includes('UPDATE work_orders SET escalated_at'))).toBeTruthy();
    const notes = calls.filter((c) => c.text.includes('INSERT INTO notification'));
    expect(notes).toHaveLength(2);
    // 第一条：worker（在身 assignee）；第二条：account（租户管理员）
    expect(notes[0].params).toEqual(expect.arrayContaining([W1, 'worker']));
    expect(notes[1].params).toEqual(expect.arrayContaining([ADMIN, 'account']));
  });

  it('未超时 → 零命中、零通知、不动 escalated_at', async () => {
    const { client, calls } = makeClient([{ ...overdueRow, sla_due_at: new Date(Date.now() + 60 * 60_000) }]);
    h.client = client;
    const hits = await runSlaScanForTenant(TENANT);
    expect(hits).toHaveLength(0);
    expect(calls.find((c) => c.text.includes('UPDATE work_orders SET escalated_at'))).toBeUndefined();
    expect(calls.find((c) => c.text.includes('INSERT INTO notification'))).toBeUndefined();
  });

  it('已升级过（escalated_at 非空）→ 不重复命中', async () => {
    const { client, calls } = makeClient([{ ...overdueRow, escalated_at: new Date() }]);
    h.client = client;
    const hits = await runSlaScanForTenant(TENANT);
    expect(hits).toHaveLength(0);
    expect(calls.find((c) => c.text.includes('INSERT INTO notification'))).toBeUndefined();
  });

  it('runSlaSchedulerOnce：枚举租户逐个扫描并汇总命中数', async () => {
    const { client } = makeClient([overdueRow]);
    h.client = client;
    h.tenants = [TENANT, 't-other'];
    const total = await runSlaSchedulerOnce();
    expect(total).toBe(2); // 两个租户各命中同一 overdue 种子（fake client 复用）
  });
});
