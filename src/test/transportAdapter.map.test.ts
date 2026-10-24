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
      if (text.includes('FROM workflow_def')) return { rows: [], rowCount: 0 };
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
        return { rows: [{ id: 'to-2', status }, { id: 'to-1', status }], rowCount: 2 };
      }
      if (text.includes('FROM transport_order')) {
        return { rows: [{ id: ORDER_ID, status, carrier, work_order_id: null }], rowCount: 1 };
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
});
