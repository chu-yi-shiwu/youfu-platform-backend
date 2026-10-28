/**
 * 洞①「工人退回自动回派」回归护栏 —— TDD 红→绿本批的 RED 侧
 *
 * 【为什么有这份测试】
 *   审计实测（`docs/00_现行/自动派单_必经人工排查.md` V3）：
 *     `stateMachine.ts:143` 定义了 `assigned --return--> pending_dispatch`，
 *     但退回之后**没有任何自动回派**——单子停在 `pending_dispatch`，
 *     出边只有 dispatch（人工派单）/ claim（工人自己抢）/ cancel（撤销）。
 *   ⇒ 「工人一退回，这单就死在那儿等人来派」= 初一铁律正面违反。
 *
 * 【初一 2026-10-28 三条裁定，本文件逐条钉死】
 *   D-1：派不出去 ⇒ **继续挂着 + 自动升级喊人**，通知一级级升（喊多次、喊更广），
 *        **单子永不自己消失**。❌ 不引入组织架构（上级/科室）。
 *   D-2：**不自动关单**。任何情况下工单都不会因派不出而自动关闭。
 *   D-5：回派次数上限 **3 次**，超限后按 D-1 处理（落池 + 喊人）。
 *
 * 【排除口径】排除集 = 显式 opts.excludeWorkerId ∪ r.row.assignee_id。
 *   依据：审计实证——退回**不清** `assignee_id`
 *   （`repo/ticket.ts:264` 提取 → `:290` assignee 为空则该列不进 UPDATE → `:308` `assignee ?? cur.assignee_id`）
 *   ⇒ 退回后原工人仍挂在单上，这就是"要排除谁"的现成答案，无需另存"上次谁退的"。
 *
 * 【关键红线】本测试**同时**守卫主路径不被误伤：
 *   assigned → processing → completed 等主路径不得因本批改动产生任何额外写或状态偏移。
 */

import { describe, it, expect, vi } from 'vitest';
import { RICH_WORK_ORDER_DEF } from '../engine/stateMachine.js';

// RED 步骤 1：实现文件尚不存在 ⇒ 本 import 在本批首次运行时必然抛错（红）。
const { autoRedispatchAfterReturn, shouldTriggerAutoRedispatch } = await import(
  '../services/autoRedispatch.js'
);

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;

function makeClient(handler: QueryFn) {
  const calls: Array<{ text: string; params?: any[] }> = [];
  return {
    client: {
      query: vi.fn(async (text: string, params: any[] = []) => {
        calls.push({ text, params });
        return handler(text, params);
      }),
    } as any,
    calls,
  };
}

const T = 't-redispatch';

/** 三名在岗工人：A（退回人，load 最低 ⇒ 若排除失效必被选中）、B、C。 */
const W_A = 'W-A';
const W_B = 'W-B';
const W_C = 'W-C';

function workerRows(extra: any[] = []) {
  return [
    { id: W_A, skill_tags: '["electrical"]', load: 0, active: true },
    { id: W_B, skill_tags: '["electrical"]', load: 2, active: true },
    { id: W_C, skill_tags: '["electrical"]', load: 5, active: true },
    ...extra,
  ];
}

function redispatchHandler(opts: { workerRows?: any[]; adminRows?: any[] } = {}): QueryFn {
  return async (text: string, params?: any[]) => {
    if (text.includes('FROM worker WHERE tenant_id')) return { rows: opts.workerRows ?? [] };
    if (text.includes('FROM dispatch_rule WHERE')) return { rows: [] };
    // 富 13 态模板（生产可达：pilot/phasea_seed.sql:28 的 def 含 pending_dispatch）
    if (text.includes('SELECT def FROM workflow_def')) {
      return { rows: [{ def: JSON.stringify(RICH_WORK_ORDER_DEF) }] };
    }
    if (text.includes('SELECT params FROM model_state')) return { rows: [] };
    if (text.includes('FOR UPDATE')) {
      return {
        rows: [
          {
            id: 'WO-1',
            tenant_id: T,
            status: 'pending_dispatch',
            assignee_id: W_A,
            ext: {},
            priority: 'normal',
            catalog: 'electrical',
            business_type: 'repair',
          },
        ],
        rowCount: 1,
      };
    }
    if (text.includes('SELECT 1 FROM worker WHERE')) return { rows: [{ ok: 1 }], rowCount: 1 };
    if (text.includes('UPDATE work_orders SET status')) {
      return { rows: [{ id: 'WO-1', status: params?.[0], assignee_id: params?.[3] ?? null }], rowCount: 1 };
    }
    if (text.includes('FROM account_user WHERE tenant_id=$1 AND active=true')) {
      return { rows: opts.adminRows ?? [] };
    }
    if (text.includes("FROM role_permission WHERE tenant_id=$1 AND perm='dispatch.override'")) {
      return { rows: [] }; // 无额外授权角色 ⇒ 接收面 = admin
    }
    if (text.includes('UPDATE worker SET load')) return { rows: [] };
    if (text.includes('INSERT INTO ticket_event')) return { rows: [] };
    if (text.includes('INSERT INTO domain_event')) return { rows: [] };
    if (text.includes('INSERT INTO notification')) return { rows: [] };
    return { rows: [] };
  };
}

const baseRow = {
  id: 'WO-1',
  order_no: 'WO_20261028_0001',
  assignee_id: W_A as string | null,
  business_type: 'repair',
  priority: 'normal' as string | null,
  catalog: 'electrical' as string | null,
  status: 'pending_dispatch',
};

/** 工单已回派过 n 次的形态（计数存在 work_orders.ext jsonb 里）。 */
const withRedispatchCount = (n: number) => ({ ...baseRow, ext: { redispatch_count: n } });

describe('洞①：工人退回自动回派', () => {
  // —— R1：正常回派，且必须排除退回人 ——
  it('R1 退回后自动回派给其他人，且绝不派回给退回人（A load 最低仍被排除）', async () => {
    const { client, calls } = makeClient(redispatchHandler({ workerRows: workerRows() }));
    const r = await autoRedispatchAfterReturn(client, T, baseRow, { event: 'return' });
    expect(r.attempted).toBe(true);
    expect(r.redispatch).toBe(true);
    expect(r.assignee).not.toBeNull();
    expect(r.assignee).not.toBe(W_A); // 🔴 核心：A 是退回人 + load 最低 ⇒ 排除失效就会派回给 A
    const statusUpd = calls.find((c) => c.text.includes('UPDATE work_orders SET status'));
    expect(statusUpd?.params?.[0]).toBe('assigned');
    expect(statusUpd?.params).toContain(r.assignee);
  });

  // —— R2：排除后无人可派 ⇒ 落池 + 喊人（D-1），且不关单（D-2）——
  it('R2 租户只有退回人一人在岗 ⇒ 不回派、留在池态、写失败事件、通知 admin，且不自动关单', async () => {
    const { client, calls } = makeClient(
      redispatchHandler({
        workerRows: [{ id: W_A, skill_tags: '["electrical"]', load: 0, active: true }],
        adminRows: [{ id: 'u-admin-1' }, { id: 'u-admin-2' }],
      }),
    );
    const r = await autoRedispatchAfterReturn(client, T, baseRow, { event: 'return' });
    expect(r.attempted).toBe(true);
    expect(r.redispatch).toBe(false);
    expect(r.assignee).toBeNull();
    expect(r.reason).toBe('no_available_worker');
    // 🔴 D-2：绝不自动关单 —— 不得出现任何往 cancelled 的写入
    const statusUpds = calls.filter((c) => c.text.includes('UPDATE work_orders SET status'));
    expect(statusUpds.length).toBe(0); // 本批只在回派成功时写状态；失败不写 ⇒ 单子原地挂着
    // 🔴 D-1：继续挂着 + 升级喊人 ⇒ 必须写失败事件 + 通知 admin
    const evt = calls.find((c) => c.text.includes('INSERT INTO ticket_event'));
    expect(evt).toBeTruthy();
    expect(JSON.parse(String(evt?.params?.[5]))).toMatchObject({ reason: 'no_available_worker' });
    const notifies = calls.filter((c) => c.text.includes('INSERT INTO notification'));
    expect(notifies.length).toBe(2); // 两名 active admin 各一条
  });

  // —— R3：非 return 事件不触发 ——
  it('R3 非 return 事件（如 receive / complete）不触发自动回派（主路径零干扰）', async () => {
    for (const ev of ['receive', 'start', 'complete', 'accept', 'forward', 'claim']) {
      const { client, calls } = makeClient(redispatchHandler({ workerRows: workerRows() }));
      const r = await autoRedispatchAfterReturn(client, T, baseRow, { event: ev });
      expect(r.attempted).toBe(false);
      expect(r.redispatch).toBe(false);
      expect(calls.filter((c) => c.text.includes('UPDATE work_orders SET status')).length).toBe(0);
    }
  });

  it('R3b 事件为空（未传 event）不触发', async () => {
    const { client } = makeClient(redispatchHandler({ workerRows: workerRows() }));
    const r = await autoRedispatchAfterReturn(client, T, baseRow, {});
    expect(r.attempted).toBe(false);
    expect(r.redispatch).toBe(false);
  });

  // —— R4：次数上限 3 次 ——
  it('R4 已达上限（ext.redispatch_count >= 3）⇒ 不再自动回派，按 D-1 处理', async () => {
    const { client, calls } = makeClient(redispatchHandler({ workerRows: workerRows() }));
    const r = await autoRedispatchAfterReturn(client, T, withRedispatchCount(3), { event: 'return' });
    expect(r.attempted).toBe(true);
    expect(r.redispatch).toBe(false);
    expect(r.reason).toBe('limit_reached');
    expect(calls.filter((c) => c.text.includes('UPDATE work_orders SET status')).length).toBe(0);
    // 超限也要喊人（D-1：永不静默）
    const evt = calls.find((c) => c.text.includes('INSERT INTO ticket_event'));
    expect(JSON.parse(String(evt?.params?.[5]))).toMatchObject({ reason: 'limit_reached' });
  });

  it('R4b 未达上限（count = 2）⇒ 仍可回派', async () => {
    const { client } = makeClient(redispatchHandler({ workerRows: workerRows() }));
    const r = await autoRedispatchAfterReturn(client, T, withRedispatchCount(2), { event: 'return' });
    expect(r.redispatch).toBe(true);
    expect(r.assignee).not.toBe(W_A);
  });

  // —— R5：回派成功要 +1 计数 ——
  it('R5 回派成功后 ext.redispatch_count 递增（首次 ⇒ 1）', async () => {
    const { client, calls } = makeClient(redispatchHandler({ workerRows: workerRows() }));
    await autoRedispatchAfterReturn(client, T, baseRow, { event: 'return' });
    const extUpd = calls.find((c) => c.text.includes('UPDATE work_orders SET ext'));
    expect(extUpd).toBeTruthy();
    expect(Number(extUpd?.params?.[0])).toBe(1);
  });

  it('R5b 已有 count = 2 ⇒ 递增为 3', async () => {
    const { client, calls } = makeClient(
      redispatchHandler({ workerRows: workerRows(), adminRows: [{ id: 'u-admin-1' }] }),
    );
    await autoRedispatchAfterReturn(client, T, withRedispatchCount(2), { event: 'return' });
    const extUpd = calls.find((c) => c.text.includes('UPDATE work_orders SET ext'));
    expect(Number(extUpd?.params?.[0])).toBe(3);
  });

  // —— R6：排除集 = 显式 excludeWorkerId ∪ assignee_id ——
  it('R6 显式 excludeWorkerId 与 assignee_id 都进排除集（两个人都不会被选中）', async () => {
    const { client } = makeClient(redispatchHandler({ workerRows: workerRows() }));
    const r = await autoRedispatchAfterReturn(client, T, baseRow, {
      event: 'return',
      excludeWorkerId: W_B,
    });
    expect(r.redispatch).toBe(true);
    expect(r.assignee).toBe(W_C); // A（assignee_id）与 B（显式）都被排除 ⇒ 只剩 C
    expect(r.excludeWorkerIds.sort()).toEqual([W_A, W_B].sort());
  });

  // —— R7：走 transition() 主通道，非旁路 UPDATE ——
  it('R7 回派走 transition() 主通道：assign 事件 + actor=auto_dispatch + systemAuto 生效', async () => {
    const { client, calls } = makeClient(redispatchHandler({ workerRows: workerRows() }));
    await autoRedispatchAfterReturn(client, T, baseRow, { event: 'return' });
    const evt = calls.find((c) => c.text.includes('INSERT INTO ticket_event'));
    expect(evt?.text).toContain("'assign'");
    expect(evt?.params?.[4]).toBe('auto_dispatch');
    // 走主通道 ⇒ 必过 assignee 存在性校验（:269-277）
    expect(calls.find((c) => c.text.includes('SELECT 1 FROM worker WHERE'))).toBeTruthy();
  });

  // —— R8：D-2 硬约束 —— 任何分支都不许自动关单 ——
  it('R8 D-2 硬约束：即使零在岗工人也不得写入 cancelled / 任何终态', async () => {
    const { client, calls } = makeClient(
      redispatchHandler({ workerRows: [], adminRows: [{ id: 'u-admin-1' }] }),
    );
    await autoRedispatchAfterReturn(client, T, { ...baseRow, assignee_id: null }, { event: 'return' });
    const allSql = calls.map((c) => String(c.text)).join('\n');
    expect(allSql).not.toMatch(/cancelled/);
    expect(allSql).not.toMatch(/UPDATE work_orders SET status/);
  });

  // —— R10：回派自身出错绝不许拖垮"退回"这个动作 ——
  //   起因：withTenantClient 是 BEGIN→fn→COMMIT。回派段 SQL 一旦真出错，PG 事务进入
  //   aborted 态，外层 COMMIT 实为 ROLLBACK ⇒ 用户点的"退回"静默消失但 API 谎报成功。
  //   （同源事故与修法见 workOrder.ts:256-260 的 dispatch_notify_sp 注释。）
  it('R10 回派段抛错 ⇒ 被 SAVEPOINT 隔离，不向上抛，reason=redispatch_error', async () => {
    const handler = redispatchHandler({ workerRows: workerRows() });
    const { client, calls } = makeClient(async (text, params) => {
      // 让回派路径上的读 def 直接炸（模拟脏 jsonb / 权限 / 快照缺失）
      if (text.includes('SELECT def FROM workflow_def')) throw new Error('boom: def read failed');
      return handler(text, params);
    });
    const r = await autoRedispatchAfterReturn(client, T, baseRow, { event: 'return' });
    expect(r.attempted).toBe(true);
    expect(r.redispatch).toBe(false);
    expect(r.reason).toBe('redispatch_error');
    // 必须留了下 SAVEPOINT 回滚的痕迹（证明走了隔离，不是裸 try/catch 吞错）
    expect(calls.some((c) => String(c.text).includes('ROLLBACK TO SAVEPOINT'))).toBe(true);
  });

  // —— R9：主路径零误伤（守卫本批改动的边界）——
  it('R9 主路径守卫：event 非 return 时本函数不产生任何写操作', async () => {
    const { client, calls } = makeClient(redispatchHandler({ workerRows: workerRows() }));
    const r = await autoRedispatchAfterReturn(client, T, baseRow, { event: 'complete' });
    expect(r.attempted).toBe(false);
    // 除了一次可选的现状读取，不得有 INSERT/UPDATE
    const writes = calls.filter((c) => /^\s*(INSERT|UPDATE)/i.test(String(c.text)));
    expect(writes.length).toBe(0);
  });
});

describe('洞①：触发器判定（纯函数，可单测）', () => {
  it('T1 return 事件 ⇒ 触发', () => {
    expect(shouldTriggerAutoRedispatch({ event: 'return' })).toBe(true);
  });

  it('T2 其他事件 ⇒ 不触发', () => {
    for (const ev of ['receive', 'start', 'complete', 'accept', 'forward', 'claim', 'cancel']) {
      expect(shouldTriggerAutoRedispatch({ event: ev })).toBe(false);
    }
  });

  it('T3 事件缺失/空 ⇒ 不触发（保守，宁可不派也不误派）', () => {
    expect(shouldTriggerAutoRedispatch({})).toBe(false);
    expect(shouldTriggerAutoRedispatch({ event: '' })).toBe(false);
    expect(shouldTriggerAutoRedispatch({ event: undefined })).toBe(false);
  });
});
