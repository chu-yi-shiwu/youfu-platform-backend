// 洞②（运送单接自动派单）—— TDD 红→绿护栏。
//
// 为什么有这个文件：
//   产品负责人铁律「流程里不能硬生生加一个人进来，非得让人去派单」。现状运送单建完停在
//   pending，只有「人来派」和「人来撤」两条路，没有第三条（生产上确有 1 条单卡了 56 天）。
//   本文件钉死第三条路：**建单即自动派**，且派单走 transitionOrder 主通道（不是旁路 UPDATE）。
//
// 【先查实再动手的结论（E7 留痕）】
//   TRANSPORT_DEF（engine/themes.ts:22-36）的 states =
//     pending / assigned / transporting / done / exception / cancelled
//   ⇒ **没有池态**（无 claim_hall 之类可落的"等待池"）。
//   ⇒ 派不到人时按工单线 else 分支的**可移植部分**执行：保持 pending + 通知本租户 active admin，
//     不发明新状态、不改状态机定义（YAGNI，也算新增变量）。
//
// 范式：与 linkedWorkOrderDispatch.test.ts 同源——fake client + SQL 子串分流（无真实 PG）。
import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';

import { createOrder, transitionOrder, type TransportOrderInput } from '../routes/transport.js';

const T = 't-transport-autodispatch';
const ORDER_ID = 'to-auto-1';

type QueryFn = (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>;

function makeClient(handler: QueryFn) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const client = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      return handler(text, params);
    }),
  } as unknown as PoolClient;
  return { client, calls };
}

/** 建单入参（只填必填项 item_name；刻意**不传** carrier ⇒ 触发自动派单）。 */
function input(over: Partial<TransportOrderInput> = {}): TransportOrderInput {
  return { item_name: '标本', priority: 'normal', order_type: 'scheduled', ...over } as TransportOrderInput;
}

interface HandlerOpts {
  /** worker 表返回行（skill_tags 与生产一致：jsonb 字符串）。 */
  workerRows?: any[];
  adminRows?: any[];
  /** 建单 INSERT 的返回行。 */
  inserted?: any;
  /** transitionOrder 内部 `SELECT *` 读到的行。 */
  current?: any;
  /** transitionOrder 的 UPDATE ... RETURNING 返回行。 */
  updated?: any;
}

function handler(o: HandlerOpts = {}): QueryFn {
  return async (text: string, p?: unknown[]) => {
    if (text.includes('FROM workflow_def')) return { rows: [{ version: 0 }], rowCount: 1 };
    if (text.includes('INSERT INTO transport_order')) {
      return {
        rows: [o.inserted ?? { id: ORDER_ID, code: 'T-1', status: 'pending', carrier: null, def_version: 0 }],
        rowCount: 1,
      };
    }
    if (text.includes('SELECT id, skill_tags, load, active FROM worker')) {
      return { rows: o.workerRows ?? [], rowCount: (o.workerRows ?? []).length };
    }
    if (text.includes('SELECT * FROM transport_order WHERE id')) {
      return {
        rows: [o.current ?? { id: ORDER_ID, status: 'pending', carrier: null, def_version: 0 }],
        rowCount: 1,
      };
    }
    if (text.includes('UPDATE transport_order')) {
      return {
        rows: [o.updated ?? { id: ORDER_ID, status: 'assigned', carrier: String((p ?? [])[3] ?? null) }],
        rowCount: 1,
      };
    }
    if (text.includes('INSERT INTO transport_track_point')) return { rows: [], rowCount: 1 };
    if (text.includes('INSERT INTO domain_event')) return { rows: [], rowCount: 1 };
    if (text.includes('INSERT INTO notification')) return { rows: [], rowCount: 1 };
    if (text.includes("SELECT id FROM account_user WHERE tenant_id=$1 AND role='admin'")) {
      return { rows: o.adminRows ?? [], rowCount: (o.adminRows ?? []).length };
    }
    if (text.includes('SAVEPOINT')) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  };
}

/** domain_event 的 type 序列（参数序见 db/eventBus.ts：$4 = type）。 */
function domainEventTypes(calls: Array<{ text: string; params?: unknown[] }>): string[] {
  return calls
    .filter((c) => c.text.includes('INSERT INTO domain_event'))
    .map((c) => String((c.params ?? [])[3]));
}

/** 捕获「拒绝 vs 成功」两态，让**失败是断言失败而不是抛异常**——红的时候看得见错误码。 */
async function settle<T>(p: Promise<T>): Promise<{ ok: boolean; code: string; row: any }> {
  try {
    const row = await p;
    return { ok: true, code: '', row };
  } catch (e: any) {
    return { ok: false, code: String(e?.code ?? e), row: null };
  }
}

describe('洞② · 运送单建单后自动派单', () => {
  it('① 建单不传承运人 ⇒ 自动派出去了（carrier 非空、status 不再是 pending）', async () => {
    // 两名在岗工人：wt-1 手上 3 个活、wt-2 手上 1 个活 ⇒ 按「手上活最少」必须选中 wt-2
    const { client, calls } = makeClient(
      handler({
        workerRows: [
          { id: 'wt-1', skill_tags: '[]', load: 3, active: true },
          { id: 'wt-2', skill_tags: '[]', load: 1, active: true },
        ],
      }),
    );

    const outcome = await settle(createOrder(client, T, input()));
    expect(outcome.ok, `建单自动派单必须成功（失败码：${outcome.code}）`).toBe(true);
    expect(outcome.row.carrier, '必须挑中「手上活最少」的在岗工人 wt-2').toBe('wt-2');
    expect(outcome.row.status, '自动派单后状态不再是 pending').toBe('assigned');

    // 派单必须走 transitionOrder 主通道（UPDATE transport_order），不是旁路裸写
    const upd = calls.find((c) => c.text.includes('UPDATE transport_order'));
    expect(upd, '没有 UPDATE transport_order ⇒ 没走主通道，或根本没派').toBeTruthy();
    expect(upd!.text).toContain('carrier');
    expect(upd!.params).toContain('wt-2');
    // 事件留痕：dispatch 事件（人工派单与自动派单同口径）
    // 参数序见 db/eventBus.ts：(tenant_id, entity_type, entity_id, type, actor, payload) ⇒ type 是 $4
    expect(domainEventTypes(calls)).toContain('dispatch');
    // 被派中的工人收到通知（与工单线 A5 fan-out 同口径；entity_type 标 transport_order）
    const notifies = calls.filter((c) => c.text.includes('INSERT INTO notification'));
    expect(notifies.length).toBe(1);
    expect(JSON.stringify(notifies[0].params)).toContain('wt-2');
    expect(JSON.stringify(notifies[0].params)).toContain('transport_order');
  });

  it('② 无在岗工人 ⇒ 不报错、保持 pending + 通知本租户 active admin（运送线无池态，不发明新状态）', async () => {
    const { client, calls } = makeClient(
      handler({
        // 有工人档案但无一在岗 ⇒ 无人可派
        workerRows: [{ id: 'wt-off', skill_tags: '[]', load: 0, active: false }],
        adminRows: [{ id: 'u-admin-1' }],
      }),
    );

    const outcome = await settle(createOrder(client, T, input()));
    expect(outcome.ok, `派不到人不得报错（失败码：${outcome.code}）`).toBe(true);
    expect(outcome.row.status, '无池态 ⇒ 保持 pending，不发明新状态').toBe('pending');
    expect(outcome.row.carrier ?? null).toBeNull();
    // 不许偷偷把单推进 assigned
    expect(calls.find((c) => c.text.includes('UPDATE transport_order'))).toBeUndefined();
    // 与工单线 else 分支同口径：通知本租户 active admin
    const notifies = calls.filter((c) => c.text.includes('INSERT INTO notification'));
    expect(notifies.length).toBe(1);
    expect(JSON.stringify(notifies[0].params)).toContain('u-admin-1');
    expect(JSON.stringify(notifies[0].params)).toContain('transport_order');
    // 通知段 SAVEPOINT 隔离（工单线同款：通知失败不得让建单静默消失）
    expect(calls.find((c) => c.text.includes('SAVEPOINT'))).toBeTruthy();
    // 建单事件照常留痕
    expect(domainEventTypes(calls)).toContain('create');
  });

  it('③-1 回归：人工派单路径仍然能用（admin 走 dispatch → assigned）', async () => {
    const { client } = makeClient(handler({ current: { id: ORDER_ID, status: 'pending', def_version: 0 } }));
    const row = await transitionOrder(
      client,
      T,
      ORDER_ID,
      'dispatch',
      { carrier: 'w-manual', depart_at: 'now()' },
      {},
      'u-admin',
      'admin',
    );
    expect(row.status).toBe('assigned');
  });

  it('③-2 回归：人类角色门禁不因新增系统通道而被削弱（worker 派单仍 403）', async () => {
    const { client } = makeClient(handler({ current: { id: ORDER_ID, status: 'pending', def_version: 0 } }));
    const outcome = await settle(
      transitionOrder(client, T, ORDER_ID, 'dispatch', { carrier: 'w-1' }, {}, 'u-worker', 'worker'),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('FORBIDDEN');
  });

  it('③-3 系统身份通道：无人类角色 + systemAuto ⇒ dispatch 放行（否则自动派单恒 403）', async () => {
    const { client } = makeClient(handler({ current: { id: ORDER_ID, status: 'pending', def_version: 0 } }));
    // 【为什么用宽松签名】本条钉的是**尚未存在的第 9 个形参**（opts.systemAuto）；
    //   用强类型直接写会先得到 TS 编译错——那是"代码没写完"，不是"行为错了"，红得没有意义。
    //   故以 unknown 变参调用，把失败锁在断言层（下方会打印真实错误码）。
    const loose = transitionOrder as unknown as (...args: unknown[]) => Promise<any>;
    const outcome = await settle(
      loose(client, T, ORDER_ID, 'dispatch', { carrier: 'wt-2', depart_at: 'now()' }, {}, 'auto_dispatch', undefined, {
        systemAuto: true,
      }),
    );
    expect(outcome.ok, `系统派单不得被人类角色门禁挡住（失败码：${outcome.code}）`).toBe(true);
    expect(outcome.row.status).toBe('assigned');
  });

  it('③-4 回归：显式传了 carrier 的建单保持原行为（尊重调用方明确意图，不覆盖）', async () => {
    const { client, calls } = makeClient(
      handler({
        workerRows: [{ id: 'wt-1', skill_tags: '[]', load: 0, active: true }],
        inserted: { id: ORDER_ID, code: 'T-1', status: 'pending', carrier: 'w-explicit', def_version: 0 },
      }),
    );
    const outcome = await settle(createOrder(client, T, input({ carrier: 'w-explicit' })));
    expect(outcome.ok).toBe(true);
    expect(outcome.row.carrier).toBe('w-explicit');
    expect(calls.find((c) => c.text.includes('UPDATE transport_order'))).toBeUndefined();
  });
});
