// V2-F2（派单纵切 P0-5，2026-09-14）：抢单大厅停留超时扫描回归护栏。
// 此前 claim_hall 单无任何专属超时——SLA 到期也仅打标记，工单可在大厅静置到被遗忘。
// 修复：slaScheduler 新增 runClaimHallTimeoutScanForTenant（只通知不自动改派）：
//   命中 = status='claim_hall' 且 updated_at 超阈值 且尚无 'claim_hall_timeout' 事件（结构性防重）；
//   动作 = ticket_event('claim_hall_timeout') + domain_event + 通知全部 active admin/dispatcher。
// 范式与 slaScheduler.test.ts 相同：db/pool 整体 mock（无真实 PG）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ client: null as any }));
vi.mock('../db/pool.js', () => ({
  default: {
    query: vi.fn(async () => ({ rows: [] })),
    connect: vi.fn(async () => {
      throw new Error('no pg in tests');
    }),
  },
  withTenantClient: vi.fn(async (_tenantId: string, fn: (c: any) => Promise<any>) => fn(h.client)),
}));

const { claimHallTimeoutMinutes, runClaimHallTimeoutScanForTenant } = await import('../scheduler/slaScheduler.js');

const TENANT = 't-verification';
const WO = '66666666-6666-4666-8666-666666666666';
const ADMIN = 'admin-001';
const DISPATCHER = 'dispatcher-001';

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;

function makeClient(scanRows: any[]) {
  const calls: Array<{ text: string; params?: any[] }> = [];
  const client = {
    query: (async (text: string, params?: any[]) => {
      calls.push({ text, params });
      if (text.includes("w.status = 'claim_hall'") && text.includes('make_interval')) return { rows: scanRows };
      if (text.includes("role IN ('admin','dispatcher')")) {
        return { rows: [{ id: ADMIN }, { id: DISPATCHER }] };
      }
      return { rows: [] }; // INSERT ticket_event / domain_event / notification
    }) as QueryFn,
  } as any;
  return { client, calls };
}

// 40 分钟前进入大厅（> 默认阈值 30 分钟）
const staleHallRow = {
  id: WO,
  order_no: 'WO-HALL-1',
  updated_at: new Date(Date.now() - 40 * 60_000).toISOString(),
};

describe('claimHallTimeoutMinutes（env 阈值口径）', () => {
  const saved = process.env.CLAIM_HALL_TIMEOUT_MIN;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAIM_HALL_TIMEOUT_MIN;
    else process.env.CLAIM_HALL_TIMEOUT_MIN = saved;
  });

  it('env 未设 → 缺省 30 分钟', () => {
    delete process.env.CLAIM_HALL_TIMEOUT_MIN;
    expect(claimHallTimeoutMinutes()).toBe(30);
  });
  it('env 合法正数 → 原样生效', () => {
    process.env.CLAIM_HALL_TIMEOUT_MIN = '45';
    expect(claimHallTimeoutMinutes()).toBe(45);
  });
  it('env 非法（非数字 / 0 / 负数）→ 降级回 30，不抛错', () => {
    for (const bad of ['abc', '0', '-5']) {
      process.env.CLAIM_HALL_TIMEOUT_MIN = bad;
      expect(claimHallTimeoutMinutes()).toBe(30);
    }
  });
});

describe('runClaimHallTimeoutScanForTenant（P0-5 大厅超时感知闭环）', () => {
  beforeEach(() => {
    delete process.env.CLAIM_HALL_TIMEOUT_MIN;
  });

  it('🔴 核心回归：超时大厅单 → claim_hall_timeout 事件 + domain_event + admin/dispatcher 双通知', async () => {
    const { client, calls } = makeClient([staleHallRow]);
    h.client = client;
    const hits = await runClaimHallTimeoutScanForTenant(TENANT);
    expect(hits).toHaveLength(1);
    expect(hits[0].workOrderId).toBe(WO);
    expect(hits[0].waitMinutes).toBeGreaterThanOrEqual(40);
    // 事件：type 内联 'claim_hall_timeout'，payload 带实测等待与阈值
    const evt = calls.find((c) => c.text.includes('INSERT INTO ticket_event'));
    expect(evt?.text).toContain("'claim_hall_timeout'");
    const evtPayload = JSON.parse(String(evt?.params?.[3]));
    expect(evtPayload.threshold_minutes).toBe(30);
    expect(evtPayload.wait_minutes).toBeGreaterThanOrEqual(40);
    // domain_event 闭环（过程挖掘数据源）
    expect(calls.find((c) => c.text.includes('INSERT INTO domain_event'))).toBeTruthy();
    // 通知面：admin + dispatcher 各一条（V2-F2 扩展——大厅积压是调度职责）
    const notes = calls.filter((c) => c.text.includes('INSERT INTO notification'));
    expect(notes).toHaveLength(2);
    const allParams = JSON.stringify(notes.map((n) => n.params));
    expect(allParams).toContain(ADMIN);
    expect(allParams).toContain(DISPATCHER);
    expect(allParams).toContain('抢单大厅工单超时');
    expect(allParams).toContain('WO-HALL-1');
  });

  it('无超时命中 → 返回空数组，零事件零通知', async () => {
    const { client, calls } = makeClient([]);
    h.client = client;
    const hits = await runClaimHallTimeoutScanForTenant(TENANT);
    expect(hits).toEqual([]);
    expect(calls.find((c) => c.text.includes('INSERT INTO ticket_event'))).toBeUndefined();
    expect(calls.find((c) => c.text.includes('INSERT INTO notification'))).toBeUndefined();
  });

  it('结构性防重口径写进 SQL：NOT EXISTS claim_hall_timeout 事件（60s cron 不重复轰炸）', async () => {
    const { calls } = makeClient([]);
    h.client = clientOf(calls);
    await runClaimHallTimeoutScanForTenant(TENANT);
    const scan = calls.find((c) => c.text.includes('make_interval'));
    expect(scan?.text).toContain('NOT EXISTS');
    expect(scan?.text).toContain("'claim_hall_timeout'");
  });

  it('阈值 env 透传：CLAIM_HALL_TIMEOUT_MIN=10 → make_interval 参数为 10', async () => {
    process.env.CLAIM_HALL_TIMEOUT_MIN = '10';
    const { client, calls } = makeClient([]);
    h.client = client;
    await runClaimHallTimeoutScanForTenant(TENANT);
    const scan = calls.find((c) => c.text.includes('make_interval'));
    expect(scan?.params?.[1]).toBe(10);
  });
});

// 便于「只取 calls 不重复建 client」的辅助
function clientOf(calls: Array<{ text: string; params?: any[] }>): any {
  return {
    query: async (text: string, params?: any[]) => {
      calls.push({ text, params });
      if (text.includes("w.status = 'claim_hall'") && text.includes('make_interval')) return { rows: [] };
      if (text.includes("role IN ('admin','dispatcher')")) return { rows: [] };
      return { rows: [] };
    },
  };
}
