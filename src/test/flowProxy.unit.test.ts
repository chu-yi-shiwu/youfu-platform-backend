// T5 / S1：代理骨架单测。
//
// 本测的立场：**S1 落地时 registry 必须是空的**。
//   空 registry ⇒ `proxyFor()` 恒 undefined ⇒ `/flow` 仍走原 `business_flow_tasks`
//   ⇒ "加骨架"这一笔**零行为改动**。★真正的切换在 S5★（把实体写进 registry 的那一笔）。
//   所以下面"registry 空"的断言不是走过场：**它一旦转 false，说明有人提前切换了**，
//   而提前切换会导致 S1~S4 的每一步都带上行为变化（E6：一次只动一个变量）。
//
// 另一半是**契约可用性**（不是形状扫描）：真注册一个 stub adapter，走 `proxyFor`
// 查表 + 调四方法，证明骨架真的能把一次调用递到原生实现门口。
import { describe, it, expect, afterEach } from 'vitest';
import { FLOW_PROXY, proxyFor, type FlowAdapter, type FlowProxyCtx, type FlowRow } from '../engine/flowProxy.js';

/** 造一个最小可用 adapter：四方法只记录收到的入参并回一个标记行（不碰 DB、不写 SQL）。 */
function stubAdapter(calls: string[]): FlowAdapter {
  const ctx: Pick<FlowProxyCtx, 'client' | 'auth' | 'actor'> = {
    client: {} as never,
    auth: { tenantId: 't-unit', requestId: 'r-unit', role: 'admin', authMode: 'dev' },
    actor: 'unit-tester',
  };
  const mark = (name: string, extra: FlowRow): FlowRow => {
    calls.push(`${name}:${String(ctx.actor)}:${String(ctx.auth.tenantId)}`);
    return { __stub: name, available: [], ...extra };
  };
  return {
    entityType: 'stub_task',
    // 故意让事件口径名 ≠ def 口径名：D1 的永久双名在类型层就被钉住，
    // 将来若有人"顺手统一成同一个名字"，这个 adapter 就是反例，编译期不会拦、但代码评审有对照物。
    nativeEntityType: 'stub_order',
    list: async (_c, query) => [mark('list', { status: query.status ?? null })],
    create: async (_c, body) => mark('create', { title: body.title }),
    detail: async (_c, id) => mark('detail', { id }),
    transition: async (_c, id, body) => mark('transition', { id, event: body.event }),
  };
}

afterEach(() => {
  // 任何往 registry 里塞的 entry 都必须清掉：本文件断言"registry 空"，
  // 泄漏出去会污染同进程内其它断言（也让 S1 的"零行为改动"失去证据）。
  for (const k of Object.keys(FLOW_PROXY)) delete FLOW_PROXY[k];
});

describe('T5/S1 proxyFor —— registry 空 ⇒ 恒未代理', () => {
  it('transport_task 未代理（★S1 验收项：切换点尚未拨动）', () => {
    expect(proxyFor('transport_task')).toBeUndefined();
  });

  it('其它业务实体同样未代理（默认路径 = business_flow_tasks）', () => {
    // 含 D2 已判 410 的 emergency_plan：它**不走代理**，410 由路由侧直接给（S-D2）。
    for (const t of ['emergency_plan', 'cycle_check', 'repair_task', 'inspection_task']) {
      expect(proxyFor(t)).toBeUndefined();
    }
  });

  it('原型链键不误命中（URL 路径可控 ⇒ fail-closed 到"未代理"侧）', () => {
    for (const k of ['toString', 'constructor', '__proto__', 'valueOf', 'hasOwnProperty']) {
      expect(proxyFor(k)).toBeUndefined();
    }
  });

  it('空串与空白不命中', () => {
    expect(proxyFor('')).toBeUndefined();
    expect(proxyFor('   ')).toBeUndefined();
  });
});

describe('T5/S1 FlowAdapter 契约 —— 查表命中后四方法可用', () => {
  it('注册的 adapter 能被 proxyFor 查回，且四方法把 ctx 原样递到实现门口', async () => {
    const calls: string[] = [];
    FLOW_PROXY['stub_task'] = stubAdapter(calls);

    const a = proxyFor('stub_task');
    expect(a).toBeDefined();
    // 双名：def 口径 ≠ 事件口径（D1 永久双名，不是待修缺陷）
    expect(a?.entityType).toBe('stub_task');
    expect(a?.nativeEntityType).toBe('stub_order');

    const ctx = {
      client: {} as never,
      tenantId: 't-unit',
      entityType: 'stub_task',
      auth: { tenantId: 't-unit', requestId: 'r-unit', role: 'admin', authMode: 'dev' } as never,
      actor: 'unit-tester',
    };

    const listed = await a!.list(ctx, { status: 'pending' });
    const created = await a!.create(ctx, { title: '一张单' });
    const detail = await a!.detail(ctx, 'id-1');
    const moved = await a!.transition(ctx, 'id-1', { event: 'dispatch' });

    // 真调用了（不是只查回一个对象就完事）：每次调用都带上调用方身份
    expect(calls).toEqual([
      'list:unit-tester:t-unit',
      'create:unit-tester:t-unit',
      'detail:unit-tester:t-unit',
      'transition:unit-tester:t-unit',
    ]);
    // 返回值带 available —— /flow 响应外壳要求每行都带（前端据此渲染动作按钮）
    for (const row of [listed[0], created, detail, moved]) {
      expect(row).toBeTruthy();
      expect(row).toHaveProperty('available');
    }
    expect(created.title).toBe('一张单');
    expect(moved.event).toBe('dispatch');
  });

  it('清掉 entry 后立刻回到未代理（切换可逆 = 回退路径存在）', () => {
    FLOW_PROXY['stub_task'] = stubAdapter([]);
    expect(proxyFor('stub_task')).toBeDefined();
    delete FLOW_PROXY['stub_task'];
    expect(proxyFor('stub_task')).toBeUndefined();
  });
});
