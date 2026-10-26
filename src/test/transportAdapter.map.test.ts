// t5 / S3：transportAdapter 字段映射单测。
//
// 【为什么不需要 mock DB】
//   adapter 的四个方法**不持有连接**，连接由 `FlowProxyCtx.client` 从外部注入
//   ⇒ 本测直接塞一个假 client，比 http 层更贴近被验对象，也更快。
//   ⚠️ 但这同时意味着：**本测证明的是"adapter 把什么 SQL/参数交给了原生函数"**，
//   不证明这条 SQL 在真库上一定跑得通（真库层由 `*.pglite.test.ts` 负责）。
//
// 【一半行为、一半形状（形状那两条必须"找不到就炸"）】
//   · 行为：真调 adapter 的四个方法，断言 SQL 参数位、422/403、available。
//   · 形状：`flowAdapters/*.ts` 里**不许出现 `client.query(`**——S3 的硬边界是
//     "只做字段映射 + 委派原生函数，不写任何 SQL"。真写 SQL 的双份逻辑必然漂移。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import type { AuthLocals } from '../middleware/auth.js';
import { transportAdapter } from '../routes/flowAdapters/transportAdapter.js';
import { TRANSPORT_DEF } from '../engine/themes.js';
import { availableTransitions } from '../engine/stateMachine.js';
import type { FlowProxyCtx } from '../engine/flowProxy.js';

const TENANT = 't-t5';
const ORDER_ID = 'to-1';

interface CapturedQuery {
  text: string;
  params?: unknown[];
}

interface FakeOpts {
  orderStatus?: string;
  carrier?: string | null;
  workerId?: string;
  // —— T1-B 批 2：让假 client 能返回一个真实的版本链（默认全 0 ⇒ 既有用例行为不变）——
  /** workflow_def 里的 live 版本号；0/缺省 = 无定义 ⇒ 落 TRANSPORT_DEF 兜底 */
  liveVersion?: number;
  /** workflow_def 里的 live def */
  liveDef?: any;
  /** history 快照（version → def） */
  history?: Array<{ version: number; def: any }>;
  /** 列表返回的行；带上 def_version 即可测「按行版本分组」 */
  listRows?: any[];
  /** 详情/流转取到的单行；带上 def_version 即可测「老单按老版本走」 */
  orderRow?: any;
}

/** 假 client：把每条 SQL 记下来，并对原生函数需要的语句给出让流程走通的最小返回。 */
function makeClient(o: FakeOpts = {}) {
  const calls: CapturedQuery[] = [];
  const status = o.orderStatus ?? TRANSPORT_DEF.initial;
  const carrier = o.carrier === undefined ? 'w-1' : o.carrier;
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      const p = params ?? [];
      if (text.includes('INSERT INTO domain_event')) return { rows: [], rowCount: 1 };
      // 🔴 顺序敏感：`workflow_def_history` 里含 `workflow_def` 子串 ⇒ history 分支必须排最前，
      //    被下面那条兜底先拦掉会一律返回 0 行 ⇒ history 永远查不到，版本读一律降级到 live。
      //    （这种"桩自己把被测路径堵死"的错，表现是全绿，属最隐蔽的假绿之一。）
      if (text.includes('FROM workflow_def_history')) {
        const v = Number(p[2] ?? 0); // 参数序 = [tenantId, entityType, version]
        const hit = (o.history ?? []).find((x) => x.version === v);
        return hit ? { rows: [{ def: JSON.stringify(hit.def) }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text.includes('SELECT version FROM workflow_def')) {
        return o.liveVersion ? { rows: [{ version: o.liveVersion }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text.includes('FROM workflow_def')) {
        return o.liveDef ? { rows: [{ def: JSON.stringify(o.liveDef) }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text.includes('FROM work_orders')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM worker')) return { rows: [{ id: o.workerId ?? 'w-1' }], rowCount: 1 };
      if (text.includes('INSERT INTO transport_track_point')) return { rows: [{ id: 'tp-1' }], rowCount: 1 };
      if (text.includes('FROM transport_track_point')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO transport_order')) {
        return {
          rows: [
            {
              id: 'to-new',
              status: TRANSPORT_DEF.initial,
              item_name: String(p[2]),
              carrier: p[5] ?? null,
              plan_depart_at: p[7] ?? null,
              // T1-B 批2：新行盖的章 = 当时的 live 版本（模拟 createOrder 的 RETURNING *）
              def_version: o.liveVersion ?? 0,
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('UPDATE transport_order')) {
        return { rows: [{ id: String(p[0]), status: String(p[2]), carrier: p[3] ?? carrier }], rowCount: 1 };
      }
      if (text.includes('FROM transport_order') && text.startsWith('SELECT id, carrier')) {
        return { rows: [{ id: ORDER_ID, carrier }], rowCount: 1 };
      }
      if (text.includes('FROM transport_order') && text.includes('ORDER BY')) {
        const rows = o.listRows ?? [{ id: 'to-2', status }, { id: 'to-1', status }];
        return { rows, rowCount: rows.length };
      }
      if (text.includes('FROM transport_order')) {
        const rows = o.orderRow ?? [{ id: ORDER_ID, status, carrier, work_order_id: null }];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  return { client: client as unknown as PoolClient, calls };
}

function auth(role = 'admin', userId = 'u-admin'): AuthLocals {
  return { tenantId: TENANT, requestId: 'rid-t5', role, userId, username: role, authMode: 'prod' };
}

function ctxOf(client: PoolClient, a: AuthLocals = auth()): FlowProxyCtx {
  return { client, tenantId: TENANT, entityType: 'transport_task', auth: a, actor: a.userId ?? 'user' };
}

function insertParams(calls: CapturedQuery[], table: string): unknown[] | undefined {
  return calls.find((c) => c.text.includes(`INSERT INTO ${table}`))?.params;
}

// ═══════════════════════════════════════════════════════════════════════════
describe('T5/S3 transportAdapter —— 建单字段映射 + R3 无落点守卫', () => {
  it('{title, scheduled_at, assignee} → {item_name, plan_depart_at, carrier}，默认值走原生 schema', async () => {
    const { client, calls } = makeClient();
    const row = await transportAdapter.create(ctxOf(client), {
      title: '送标本到 3 楼检验科',
      scheduled_at: '2026-10-30T09:00:00Z',
      assignee: 'w-9',
    });

    // INSERT 列顺序见 transport.ts：tenant_id, code, item_name, from_loc, to_loc, carrier,
    //                            priority, plan_depart_at, item_category, order_type, work_order_id, sla_due_at
    const p = insertParams(calls, 'transport_order');
    expect(p, '没发建单 SQL ⇒ 委派没跑到原生函数').toBeTruthy();
    expect(p![0]).toBe(TENANT);
    expect(p![2], 'title → item_name').toBe('送标本到 3 楼检验科');
    expect(p![5], 'assignee → carrier（R5 语义近似）').toBe('w-9');
    expect(p![7], 'scheduled_at → plan_depart_at').toBe('2026-10-30T09:00:00Z');
    // 默认值必须来自原生 orderSchema，不能在 adapter 里另抄一份
    expect(p![6], 'priority 用原生 schema 默认值 normal').toBe('normal');
    expect(p![9], 'order_type 用原生 schema 默认值 scheduled').toBe('scheduled');

    // /flow 响应外壳要求每行带 available
    expect(row.available).toEqual(availableTransitions(TRANSPORT_DEF, TRANSPORT_DEF.initial));
    // D1：事件口径统一到原生名
    expect(calls.filter((c) => c.text.includes('INSERT INTO domain_event')).map((c) => String((c.params ?? [])[1]))).toEqual([
      'transport_order',
    ]);
  });

  it('🔴 R3：data 非空 ⇒ 422，且 message 指明「该实体无 data 落点」', async () => {
    const { client, calls } = makeClient();
    await expect(
      transportAdapter.create(ctxOf(client), { title: '一张单', data: { temperature: '2-8℃' } }),
    ).rejects.toMatchObject({ status: 422 });
    // 关键：不许静默丢弃。既没发 INSERT，也没进数据库
    expect(insertParams(calls, 'transport_order'), 'data 无落点时绝不能照常建单（静默丢 = 静默失效）').toBeUndefined();
  });

  it('🔴 R3：location 非空 ⇒ 422，且 message 指明「该实体无 location 落点」', async () => {
    const { client, calls } = makeClient();
    await expect(
      transportAdapter.create(ctxOf(client), { title: '一张单', location: '门诊 3 楼' }),
    ).rejects.toMatchObject({ status: 422 });
    expect(insertParams(calls, 'transport_order')).toBeUndefined();
  });

  it('对照（保兼容·绿）：data={} 与 location="" 放行——不给既有调用方添堵', async () => {
    const a = makeClient();
    await expect(
      transportAdapter.create(ctxOf(a.client), { title: '空 data 也要能建', data: {}, location: '' }),
    ).resolves.toBeTruthy();

    const b = makeClient();
    await expect(transportAdapter.create(ctxOf(b.client), { title: '不传也行' })).resolves.toBeTruthy();
  });

  it('422 的 message 必须写明"无落点"（不看文案就无从知道该换字段）', async () => {
    const { client } = makeClient();
    const errData = await transportAdapter
      .create(ctxOf(client), { title: 'x', data: { a: 1 } })
      .catch((e: any) => e);
    expect(String(errData?.message)).toMatch(/无 data 落点/);

    const errLoc = await transportAdapter
      .create(ctxOf(client), { title: 'x', location: 'y' })
      .catch((e: any) => e);
    expect(String(errLoc?.message)).toMatch(/无 location 落点/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('T5/S3 transportAdapter —— 列表 / 详情 / 流转', () => {
  it('list：每行补 available（引擎现算，不是硬编码）', async () => {
    const { client } = makeClient({ orderStatus: 'pending' });
    const items = await transportAdapter.list(ctxOf(client), { status: 'pending' });
    expect(items.map((i) => i.id)).toEqual(['to-2', 'to-1']);
    for (const i of items) {
      expect(i.available).toEqual(availableTransitions(TRANSPORT_DEF, 'pending'));
    }
  });

  it('detail：委托原生 getOrder（自带 available），找不到即 404', async () => {
    const { client } = makeClient({ orderStatus: 'pending' });
    const item = await transportAdapter.detail(ctxOf(client), ORDER_ID);
    expect(item.id).toBe(ORDER_ID);
    expect(item.available).toEqual(availableTransitions(TRANSPORT_DEF, 'pending'));
  });

  it('流转 dispatch：assignee → carrier，并写 depart_at=now()（与原生路由同口径）', async () => {
    const { client, calls } = makeClient({ orderStatus: 'pending', carrier: 'w-1' });
    const row = await transportAdapter.transition(ctxOf(client), ORDER_ID, {
      event: 'dispatch',
      data: { assignee: 'w-1' }, // dispatch 的 requiredFields 要求 assignee
    });
    expect(row.status).toBe('assigned');

    const upd = calls.find((c) => c.text.includes('UPDATE transport_order'));
    expect(upd, '没发 UPDATE ⇒ 委派没跑到原生函数').toBeTruthy();
    // UPDATE SET 子句见 transitionOrder：status=$3，其后是白名单内的 extra 列
    expect(String(upd!.text)).toMatch(/depart_at = now\(\)/);
    expect(String(upd!.text)).toMatch(/carrier = \$/);
  });

  // 🔴 这两条钉的是 422 挡不住的那种静默丢：**键认识、但没被转发**。
  //    早期版本把 `extra.carrier = ...` 写在 `event === 'dispatch'` 分支里 ⇒
  //    非 dispatch 事件带 carrier 时：过得了 422（carrier 在 UNDERSTOOD 里），
  //    却进 transitionOrder(extra={}) ⇒ **200 且数据丢了**。
  //    200 但没落到 SQL 参数里 = 静默丢，必须红。
  it('🔴 非 dispatch 事件带 carrier ⇒ 必须真落到 transport_order.carrier（不许 200 静默丢）', async () => {
    // receive：assigned → transporting，def 上无 requiredFields，无需额外字段
    const { client, calls } = makeClient({ orderStatus: 'assigned', carrier: 'w-1' });
    const row = await transportAdapter.transition(ctxOf(client), ORDER_ID, {
      event: 'receive',
      data: { carrier: 'w-9' },
    });
    expect(row.status).toBe('transporting');

    const upd = calls.find((c) => c.text.includes('UPDATE transport_order'));
    expect(upd, '没发 UPDATE ⇒ 委派没跑到原生函数').toBeTruthy();
    expect(String(upd!.text), 'UPDATE 里必须出现 carrier 的赋值位').toMatch(/carrier = \$/);
    expect((upd!.params ?? []), 'carrier 的值必须真的出现在参数里（出现在 SQL 里但不出现在参数里 = 假转发）').toContain('w-9');
  });

  it('🔴 非 dispatch 事件带 assignee ⇒ 同样落到 carrier（R5 不随事件分支变化）', async () => {
    const { client, calls } = makeClient({ orderStatus: 'assigned', carrier: 'w-1' });
    await transportAdapter.transition(ctxOf(client), ORDER_ID, {
      event: 'receive',
      data: { assignee: 'w-9' },
    });
    const upd = calls.find((c) => c.text.includes('UPDATE transport_order'));
    expect(upd).toBeTruthy();
    expect(String(upd!.text)).toMatch(/carrier = \$/);
    expect((upd!.params ?? [])).toContain('w-9');
  });

  it('🔴 流转的 data 里出现无处可存的键 ⇒ 422（不静默丢）', async () => {
    const { client, calls } = makeClient({ orderStatus: 'pending' });
    await expect(
      transportAdapter.transition(ctxOf(client), ORDER_ID, {
        event: 'dispatch',
        data: { assignee: 'w-1', temperature: '2-8℃' },
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(
      calls.find((c) => c.text.includes('UPDATE transport_order')),
      '有键无处可存时不许照常流转',
    ).toBeUndefined();
  });

  it('🔴 R4：worker 转他人单 ⇒ 403（代理必须带上原生侧 #583 归属守卫）', async () => {
    // receive：allowedRoles 含 worker ⇒ 若守卫缺失，这条会走到 200
    const { client } = makeClient({ orderStatus: 'assigned', carrier: 'w-1', workerId: 'w-2' });
    await expect(
      transportAdapter.transition(ctxOf(client, auth('worker', 'u-w2')), ORDER_ID, { event: 'receive' }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('🔴 R4：def 的 allowedRoles 不含当前角色 ⇒ 403（角色门禁不许被代理绕过）', async () => {
    // dispatch 的 allowedRoles = ['admin','operator']，不含 worker；归属守卫放行（本人单）
    const { client } = makeClient({ orderStatus: 'pending', carrier: 'w-1', workerId: 'w-1' });
    await expect(
      transportAdapter.transition(ctxOf(client, auth('worker', 'u-w1')), ORDER_ID, {
        event: 'dispatch',
        data: { assignee: 'w-1' },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('必填字段校验：requiredFields 缺失 ⇒ 422（代理不许悄悄取消这道校验）', async () => {
    const { client } = makeClient({ orderStatus: 'pending' });
    await expect(
      transportAdapter.transition(ctxOf(client), ORDER_ID, { event: 'dispatch', data: {} }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('T5/S3 形状护栏：adapter 不许自己写 SQL', () => {
  it('flowAdapters/*.ts 里不得出现 client.query(（S3 硬边界：只映射+委派）', () => {
    const file = join(process.cwd(), 'src', 'routes', 'flowAdapters', 'transportAdapter.ts');
    let src = '';
    try {
      src = readFileSync(file, 'utf8');
    } catch (e) {
      // 形状护栏"找不到目标就炸"：文件被挪走/改名时，必须失败，不能静默跳过
      throw new Error(`[形状护栏] 读不到 ${file} ⇒ 护栏目标消失，必须修：${String(e)}`);
    }
    expect(src.length).toBeGreaterThan(0);
    // 去掉注释行再扫：文件头注释里为了说明"不许出现什么"，本身就写了那串字，
    // 不剥掉会自己命中自己（形状护栏最容易被这种自指骗过）。
    const codeOnly = src
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .join('\n');
    expect(codeOnly, 'adapter 的代码里出现了 client.query( ⇒ 代理层开始自己写 SQL，双份逻辑必然漂移').not.toMatch(
      /\.query\s*\(/,
    );
  });

  it('双名钉死：entityType=transport_task（def 口径）≠ nativeEntityType=transport_order（事件口径）', () => {
    expect(transportAdapter.entityType).toBe('transport_task');
    expect(transportAdapter.nativeEntityType).toBe('transport_order');
  });

  it('🔴 循环依赖护栏：adapter 引用 engine/flowProxy.js 的 import 必须是 import type', () => {
    // 为什么守这条：`flowProxy.ts` 按值引入本文件的 transportAdapter（registry 要它）。
    // 若本文件再按值反向 import flowProxy ⇒ 运行时成环 ⇒ **生产启动阶段**
    // `ReferenceError: Cannot access 'transportAdapter' before initialization`。
    // ⚠️ vitest 下**不炸**（模块执行顺序不同）⇒ 单测全绿会骗人，只能靠这条静态护栏兜住。
    // 已实测：成环版在 `npx tsx` 下 adapter-first 加载顺序必崩。
    const file = join(process.cwd(), 'src', 'routes', 'flowAdapters', 'transportAdapter.ts');
    let src = '';
    try {
      src = readFileSync(file, 'utf8');
    } catch (e) {
      throw new Error(`[循环依赖护栏] 读不到 ${file} ⇒ 护栏目标消失，必须修：${String(e)}`);
    }
    const codeLines = src
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));
    const refs = codeLines.filter((l) => l.includes('engine/flowProxy.js'));
    expect(refs.length, 'adapter 应当只从 flowProxy 取类型（一条都找不到 ⇒ 类型引用被改没了）').toBeGreaterThan(0);
    for (const line of refs) {
      expect(
        line.trim(),
        'adapter 出现了按值 import flowProxy ⇒ 循环依赖 ⇒ 生产启动崩（改成 import type）',
      ).toMatch(/^import type\b/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// T1-B 批 2 · transport_order 在途单锁版本
//
// 【为什么在 adapter 这一层验】/flow 代理侧的四个方法各自读一次 def 再套到行上，
//   这条路径不经过 http 桩，而是"真 adapter + 真 workflowDef 模块 + 假 client"
//   ⇒ 断言"查了几次、查的是哪个版本"验的是真引擎，不是桩。
// 【两条 v1/v2 的唯一差别】v2 比 v1 多一条 pending --cancel--> cancelled。
//   这条边就是全部判别关键：老单不该看见它，新单应该能看见。
// ═══════════════════════════════════════════════════════════════════════════
const V1_TRANSPORT: any = {
  initial: 'pending',
  states: ['pending', 'assigned', 'transporting', 'done', 'cancelled'],
  transitions: [
    { from: 'pending', to: 'assigned', event: 'dispatch', allowedRoles: ['admin', 'operator'] },
    { from: 'assigned', to: 'transporting', event: 'receive', allowedRoles: ['admin', 'worker'] },
    { from: 'transporting', to: 'done', event: 'complete', allowedRoles: ['admin', 'worker'] },
  ],
  config: {},
};
const V2_TRANSPORT: any = {
  initial: 'pending',
  states: ['pending', 'assigned', 'transporting', 'done', 'cancelled'],
  transitions: [
    ...V1_TRANSPORT.transitions,
    { from: 'pending', to: 'cancelled', event: 'cancel', allowedRoles: ['admin', 'operator'] },
  ],
  config: {},
};

const evs = (row: any): string[] => (row?.available ?? []).map((t: any) => t.event);
const historyCalls = (calls: CapturedQuery[]) => calls.filter((c) => c.text.includes('FROM workflow_def_history'));
const versionCalls = (calls: CapturedQuery[]) => calls.filter((c) => c.text.includes('SELECT version FROM workflow_def'));

describe('T1-B 批2 · transport 锁版本', () => {
  it('列表：每行按自己锁的版本给 available，不是全表共用一个 live def', async () => {
    const { client, calls } = makeClient({
      liveVersion: 2,
      liveDef: V2_TRANSPORT,
      history: [{ version: 1, def: V1_TRANSPORT }],
      listRows: [
        { id: 'to-2', status: 'pending', def_version: 2 },
        { id: 'to-1', status: 'pending', def_version: 1 },
      ],
    });
    const rows: any[] = await transportAdapter.list(ctxOf(client), {});
    const byId = new Map<string, any>(rows.map((r) => [r.id, r]));

    expect(evs(byId.get('to-2')), '锁 v2 的行应当看得到 v2 新加的 cancel').toContain('cancel');
    // 🔴 这条是批 2 列表口的存在理由：改前 list 是「读一次 def 套 N 行」，
    //    两行都会拿到 live(v2) 的 available ⇒ 老单凭空多出 cancel 按钮。
    expect(evs(byId.get('to-1')), '锁 v1 的老单不该出现 v2 才有的 cancel').not.toContain('cancel');

    // 路径断言：分组后只该查 1 次 history（v2 是 live 不必查），不是 2 次、也不是每行 1 次。
    expect(historyCalls(calls).length, '两个版本中只有 v1 需要翻 history ⇒ 恰好 1 次').toBe(1);
  });

  it('建单：新行的 available 走 versioned 读（路径断言：必产生一次 version 查询，且不翻 history）', async () => {
    const { client, calls } = makeClient({
      liveVersion: 2,
      liveDef: V2_TRANSPORT,
      history: [{ version: 1, def: V1_TRANSPORT }],
    });
    const row: any = await transportAdapter.create(ctxOf(client), { title: '送标本到 3 楼检验科' });

    expect(row.def_version, '新行盖的章 = 建单当时的 live 版本').toBe(2);
    expect(evs(row)).toContain('cancel');
    // 路径断言：改前 create 直接用 defFor（= getWorkflowDefOrDefault），一次 version 都不查。
    //   ⇒ 少了这条，"create 仍读 live"这种实现会照样绿（此刻结果与 versioned 读完全相同）。
    expect(versionCalls(calls).length, 'create 必须走 versioned 读 ⇒ 至少查一次 version').toBeGreaterThan(0);
    // 新行版本 == live ⇒ 不该去翻 history
    expect(historyCalls(calls).length, '新行锁的就是 live 版本，不必翻 history').toBe(0);
  });

  it('流转：必填校验与流转用同一个版本 ⇒ 老单不被新版本的必填项卡死（防死锁）', async () => {
    // 🔴 这条对应设计文档 §5 批 2 表格里**没写到**的那一处（transportAdapter.transition）。
    //    v2 给 dispatch 加了必填 note；老单锁的是 v1（v1 的 dispatch 没有必填项）。
    //    若必填校验读 live(v2)、流转却按老锁版本走 ⇒ 老单被要求填一个它出生时
    //    根本不存在的字段，填了老版本也不认 ⇒ 死锁。这条就是钉死它的。
    const v1 = {
      initial: 'pending',
      states: ['pending', 'assigned', 'transporting', 'done', 'cancelled'],
      transitions: [
        { from: 'pending', to: 'assigned', event: 'dispatch', allowedRoles: ['admin', 'operator'] },
        { from: 'assigned', to: 'transporting', event: 'receive', allowedRoles: ['admin', 'worker'] },
      ],
      config: {},
    };
    const v2 = {
      ...v1,
      transitions: [
        { from: 'pending', to: 'assigned', event: 'dispatch', requiredFields: ['note'], allowedRoles: ['admin', 'operator'] },
        { from: 'assigned', to: 'transporting', event: 'receive', allowedRoles: ['admin', 'worker'] },
      ],
    };
    const { client, calls } = makeClient({
      liveVersion: 2,
      liveDef: v2,
      history: [{ version: 1, def: v1 }],
      orderRow: [{ id: ORDER_ID, status: 'pending', carrier: 'w-1', work_order_id: null, def_version: 1 }],
    });

    // 不传 note —— 老单锁 v1，v1 的 dispatch 没有必填项 ⇒ 必须放行
    await expect(transportAdapter.transition(ctxOf(client), ORDER_ID, { event: 'dispatch' })).resolves.toBeTruthy();
    // 必填校验走的是老单自己那一版 ⇒ 必然真的翻了 history 去取 v1 快照
    expect(historyCalls(calls).length, '老单锁 v1 ⇒ 必填校验必须真去 history 取 v1').toBeGreaterThan(0);
  });
});
