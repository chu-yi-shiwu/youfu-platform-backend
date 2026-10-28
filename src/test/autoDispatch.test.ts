// R31-F2（2026-08-31 全维度审查）：autoDispatchAfterCreate 此前零测试引用——
// 这是「公开报修单卡 draft、无派单、无通知」用户报障的修复点，必须有回归护栏。
// 用与 notify.test.ts 相同的 mock client + SQL 子串分流范式（无真实 PG）。
import { describe, it, expect, vi } from 'vitest';

const { autoDispatchAfterCreate } = await import('../routes/workOrder.js');
// 洞②：运送单建单后自动派单——与「自动派单」同一主题，故扩在本文件而不是新建文件。
//   （此前误建了 src/test/transportAutoDispatch.test.ts，本轮硬约束要求验收一律扩在既有文件，已迁回。）
const { createOrder, transitionOrder } = await import('../routes/transport.js');
type TransportOrderInput = Parameters<typeof createOrder>[2];

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

const WORKER_ID = '11111111-1111-4111-8111-111111111111';

function dispatchHandler(opts: {
  workerRows?: any[];
  ruleRows?: any[];
  adminRows?: any[];
  /** 洞③-2a：fault_category 上配的 skill_tags（派生技能的数据源）。默认空 = 派生不出技能。 */
  catalogRows?: any[];
} = {}): QueryFn {
  return async (text: string, params?: any[]) => {
    if (text.includes('UPDATE work_orders SET sla_minutes')) return { rows: [] };
    if (text.includes('FROM worker WHERE tenant_id')) return { rows: opts.workerRows ?? [] };
    if (text.includes('FROM fault_category')) return { rows: opts.catalogRows ?? [] };
    if (text.includes('FROM dispatch_rule WHERE')) return { rows: opts.ruleRows ?? [] }; // 无规则 → least_load 兜底
    if (text.includes('SELECT def FROM workflow_def')) return { rows: [] }; // 无自定义 def → DEFAULT
    if (text.includes('SELECT params FROM model_state')) return { rows: [] };
    // F4（2026-10-19）：派中段改走 transition() 主通道后的 mock 依赖——
    //   行锁读当前单 / assignee 存在性校验 / UPDATE RETURNING 新行
    if (text.includes('FOR UPDATE')) {
      return { rows: [{ id: '22222222-2222-4222-8222-222222222222', tenant_id: 't-verification', status: 'draft', assignee_id: null, ext: {}, priority: 'normal', catalog: 'electrical' }], rowCount: 1 };
    }
    if (text.includes('SELECT 1 FROM worker WHERE')) return { rows: [{ ok: 1 }], rowCount: 1 };
    if (text.includes('UPDATE work_orders SET status')) return { rows: [{ id: '22222222-2222-4222-8222-222222222222', status: params?.[0] }], rowCount: 1 };
    if (text.includes("SELECT id FROM account_user WHERE tenant_id=$1 AND role='admin'")) {
      return { rows: opts.adminRows ?? [] }; // 纵切② P0-4：派单未命中通知管理员
    }
    if (text.includes('UPDATE work_orders SET status')) return { rows: [] };
    if (text.includes('UPDATE worker SET load')) return { rows: [] };
    if (text.includes('INSERT INTO ticket_event')) return { rows: [] };
    if (text.includes('INSERT INTO domain_event')) return { rows: [] };
    if (text.includes('INSERT INTO notification')) return { rows: [] };
    return { rows: [] };
  };
}

const row = { id: '22222222-2222-4222-8222-222222222222', order_no: 'WO_20260831_0000000001' };
const need = { business_type: 'repair', skill_tags: null, priority: 'normal', catalog: 'electrical' };

describe('autoDispatchAfterCreate（R31-F2 回归护栏）', () => {
  it('有可用工人：SLA 起算 + 流转 assigned + worker load+1 + 事件 + 派单通知', async () => {
    const { client, calls } = makeClient(
      dispatchHandler({ workerRows: [{ id: WORKER_ID, skill_tags: '["electrical"]', load: 0, active: true }] }),
    );
    const r = await autoDispatchAfterCreate(client, 't-verification', row, need);
    expect(r.autoFlow).toBe(true);
    expect(r.assignee).toBe(WORKER_ID);
    expect(r.dispatchTarget).toBe('assigned');
    // SLA 起算（draft 态即计时）
    expect(calls.find((c) => c.text.includes('UPDATE work_orders SET sla_minutes'))).toBeTruthy();
    // 流转到 assigned 且写 assignee（F4：走 transition() 主通道，params = [to, id, tenantId, assignee]）
    const statusUpd = calls.find((c) => c.text.includes('UPDATE work_orders SET status'));
    expect(statusUpd?.params?.[0]).toBe('assigned');
    expect(statusUpd?.params).toContain(row.id);
    expect(statusUpd?.params).toContain(WORKER_ID);
    // worker load +1（transition() 活跃态净结算：+1 带 tenant 参数）
    expect(calls.find((c) => c.text.includes('UPDATE worker SET load = load + 1'))?.params).toContain(WORKER_ID);
    // assign 事件（事件流；事件类型 'assign' 内联在 SQL 文本中，from=initial(draft)→to=assigned）
    const evt = calls.find((c) => c.text.includes('INSERT INTO ticket_event'));
    expect(evt?.text).toContain("'assign'");
    expect(evt?.params?.[2]).toBe('draft');
    expect(evt?.params?.[3]).toBe('assigned');
    // domain_event（结果状态口径 = dispatchTarget）
    const dom = calls.find((c) => c.text.includes('INSERT INTO domain_event'));
    expect(dom?.params).toContain('assigned');
    // 派单通知 fan-out（含 task-detail 深链 payload）
    const notify = calls.find((c) => c.text.includes('INSERT INTO notification'));
    expect(notify).toBeTruthy();
    expect(JSON.stringify(notify?.params)).toContain('task-detail');
  });

  it('无可用工人：落抢单大厅 claim_hall（enter_hall 事件），不派单给工人，但通知全部 active admin（纵切② P0-4）', async () => {
    const { client, calls } = makeClient(
      dispatchHandler({ workerRows: [], adminRows: [{ id: 'u-admin-1' }, { id: 'u-admin-2' }] }),
    );
    const r = await autoDispatchAfterCreate(client, 't-verification', row, need);
    expect(r.autoFlow).toBe(false);
    expect(r.assignee).toBeNull();
    const statusUpd = calls.find((c) => c.text.includes('UPDATE work_orders SET status'));
    expect(statusUpd?.params?.[0]).toBe('claim_hall');
    // F8（2026-10-19）：落大厅由旁路 UPDATE 改为 transition() 主通道后，事件的两处口径被修正——
    //   ① from_status 由旧旁路的「claim_hall」（=to，笔误：一张单自己流向自己）
    //      修正为真实初态 draft（from→to 才是过程挖掘要的语义）；
    //   ② payload 位置由 params[3] 变为 params[5]（与全系统统一事件写入一致：[tenant,id,from,to,actor,payload]）。
    const evt = calls.find((c) => c.text.includes('INSERT INTO ticket_event'));
    expect(evt?.text).toContain("'enter_hall'");
    expect(evt?.params?.[2]).toBe('draft');
    expect(evt?.params?.[3]).toBe('claim_hall');
    expect(JSON.parse(String(evt?.params?.[5])).reason).toBe('no_available_worker');
    // 给工人的派单通知不出现（assignee 通知 only 在 picked 分支）
    expect(calls.filter((c) => c.text.includes('INSERT INTO notification')).length).toBe(2);
    expect(calls.find((c) => c.text.includes('UPDATE worker SET load'))).toBeUndefined();
    // 未命中通知管理员：2 名 active admin 各一条 account 通知，文案含「抢单大厅」
    const adminNotifies = calls.filter((c) => c.text.includes('INSERT INTO notification'));
    expect(adminNotifies.length).toBe(2);
    expect(JSON.stringify(adminNotifies.map((n) => n.params))).toContain('抢单大厅');
    expect(JSON.stringify(adminNotifies.map((n) => n.params))).toContain('u-admin-1');
    expect(JSON.stringify(adminNotifies.map((n) => n.params))).toContain('u-admin-2');
  });

  it('worker 全部 inactive：等同无可用工人，落 claim_hall（不误派）', async () => {
    const { client, calls } = makeClient(
      dispatchHandler({ workerRows: [{ id: WORKER_ID, skill_tags: '["electrical"]', load: 0, active: false }] }),
    );
    const r = await autoDispatchAfterCreate(client, 't-verification', row, need);
    expect(r.autoFlow).toBe(false);
    expect(calls.find((c) => c.text.includes('UPDATE work_orders SET status'))?.params?.[0]).toBe('claim_hall');
    // V2-F3：worker 全 inactive → 同口径 no_available_worker（F8：payload 位移至 params[5]）
    const evt0 = calls.find((c) => c.text.includes('INSERT INTO ticket_event'));
    expect(JSON.parse(String(evt0?.params?.[5]))).toMatchObject({ reason: 'no_available_worker', transition_event: 'enter_hall' });
  });

  it('V2-F3：有在岗工人但技能失配（规则/兜底都没接住）→ reason=no_rule_matched（P0-8 失配观测口）', async () => {
    const { client, calls } = makeClient(
      dispatchHandler({ workerRows: [{ id: WORKER_ID, skill_tags: '["electrical"]', load: 0, active: true }] }),
    );
    const r = await autoDispatchAfterCreate(client, 't-verification', row, { ...need, skill_tags: ['plumbing'] });
    expect(r.autoFlow).toBe(false);
    expect(r.assignee).toBeNull();
    const evt = calls.find((c) => c.text.includes('INSERT INTO ticket_event'));
    expect(evt?.text).toContain("'enter_hall'");
    // 有 active 工人却没派出去 → 配置/技能失配口径 no_rule_matched（F8：payload 位移至 params[5]）
    expect(JSON.parse(String(evt?.params?.[5]))).toMatchObject({ reason: 'no_rule_matched' });
  });

  // 2026-09-14 纵切② P0-1：strategy:'least_load' 不再短路规则匹配。
  it('纵切② P0-1：least_load strategy + 规则命中 → 规则胜出（reason 含规则名，不再被静默废掉）', async () => {
    const rule = {
      id: 'r-electrical', name: '维修-电工优先', priority: 10,
      match_json: { business_type: 'repair' },
      strategy_json: { type: 'skill_match', skill_tags: ['electrical'] },
      weight: 1, score: 0,
    };
    const { client, calls } = makeClient(
      dispatchHandler({
        workerRows: [{ id: WORKER_ID, skill_tags: '["electrical"]', load: 0, active: true }],
        ruleRows: [rule],
      }),
    );
    const r = await autoDispatchAfterCreate(client, 't-verification', row, need);
    expect(r.autoFlow).toBe(true);
    expect(r.assignee).toBe(WORKER_ID);
    expect(r.reason).toContain('维修-电工优先');
    // 命中的是规则链路：assign 事件 + worker load+1 正常发生
    expect(calls.find((c) => c.text.includes("'assign'"))).toBeTruthy();
    expect(calls.find((c) => c.text.includes('UPDATE worker SET load = load + 1'))).toBeTruthy();
  });

  it('纵切② P0-1：least_load strategy + 规则未命中 → 落 pickWorker 兜底（与旧版行为一致）', async () => {
    // 规则存在但 business_type 不匹配 → resolveDispatch 返回 null → 兜底选人（旧行为：least_load 直通兜底）
    const rule = {
      id: 'r-other', name: '保洁规则', priority: 10,
      match_json: { business_type: 'cleaning' },
      strategy_json: { type: 'load_balance' },
      weight: 1, score: 0,
    };
    const { client } = makeClient(
      dispatchHandler({
        workerRows: [{ id: WORKER_ID, skill_tags: '["electrical"]', load: 0, active: true }],
        ruleRows: [rule],
      }),
    );
    const r = await autoDispatchAfterCreate(client, 't-verification', row, need);
    expect(r.autoFlow).toBe(true);
    expect(r.assignee).toBe(WORKER_ID);
    expect(r.reason).toBe('auto dispatched by least_load fallback');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 洞③-2a：修「假中」——兜底 pickWorker 必须用**派生后**的 skill_tags
//
// 症状：自动派单命中率看着 71%~85%，数字是假的。
//   routes/workOrder.ts 的 `resolveNeed` 把派生技能写进了 needPayload.skill_tags
//   （engine/dispatch/needResolver.ts:114-117），但兜底那一行仍用调用方**原始**的
//   need.skill_tags。而 engine/dispatch.ts:43-45 里 required=[] 时 [].every() 恒真
//   ⇒ 公开报修（publicReportCreate.ts:304）/ AI 建单（conversationAgent.ts:183）
//   不传 skill_tags 时，**只要有 1 名在岗工人就必中**。
// 初一裁决 D-3：修假中，要真数字不要好看数字。
// ═══════════════════════════════════════════════════════════════════════════
describe('洞③-2a · 兜底派单必须用派生后的技能（假中修复）', () => {
  /** 调用方**不传** skill_tags（= 公开报修 / AI 建单的真实形态），技能全靠 catalog 派生。 */
  const needNoSkill = { business_type: 'repair', skill_tags: null, priority: 'normal', catalog: 'electrical' };

  it('① 3 名在岗工人只有 1 名具备派生技能 ⇒ 派中的必须是那名有技能的工人', async () => {
    const { client } = makeClient(
      dispatchHandler({
        // 故障分类 electrical 上配了技能 electrician（运营可配，用户零感知）⇒ 派生出 ["electrician"]
        catalogRows: [{ skill_tags: '["electrician"]' }],
        // 两名"手上没活但不会电"的工人 load=0：若兜底不看派生技能，least_load 会选中它们 = 派错人
        workerRows: [
          { id: 'w-clean-1', skill_tags: '["cleaning"]', load: 0, active: true },
          { id: 'w-clean-2', skill_tags: '["cleaning"]', load: 0, active: true },
          { id: 'w-electrician', skill_tags: '["electrician"]', load: 7, active: true },
        ],
      }),
    );
    const r = await autoDispatchAfterCreate(client, 't-verification', row, needNoSkill);
    expect(r.autoFlow).toBe(true);
    expect(r.assignee, '必须派给唯一具备派生技能的工人，而不是"手上活最少的无关工人"').toBe('w-electrician');
  });

  it('② 没有任何匹配工人 ⇒ 不再"必中"（假中的直接反证：落抢单大厅，不随便派一个人）', async () => {
    const { client, calls } = makeClient(
      dispatchHandler({
        catalogRows: [{ skill_tags: '["electrician"]' }],
        // 两名在岗工人都不会电 ⇒ 改前 required=[] ⇒ [].every() 恒真 ⇒ 必中（假中）
        workerRows: [
          { id: 'w-clean-1', skill_tags: '["cleaning"]', load: 0, active: true },
          { id: 'w-clean-2', skill_tags: '["cleaning"]', load: 0, active: true },
        ],
      }),
    );
    const r = await autoDispatchAfterCreate(client, 't-verification', row, needNoSkill);
    expect(r.autoFlow, '没有匹配工人就不该算派中').toBe(false);
    expect(r.assignee).toBeNull();
    // 有 active 工人却没派出去 ⇒ 落大厅且原因是技能失配（no_rule_matched），不是容量问题
    const evt = calls.find((c) => c.text.includes('INSERT INTO ticket_event'));
    expect(evt?.text).toContain("'enter_hall'");
    expect(JSON.parse(String(evt?.params?.[5]))).toMatchObject({ reason: 'no_rule_matched' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 洞② · 运送单建单后自动派单
//
// 为什么要扩在 autoDispatch.test.ts：本文件主题就是「自动派单」（工单线），
//   运送单的第三条路属同一主题，且同为 fake client + SQL 子串分流范式。
//
// 【先查实再动手的结论（E7 留痕）】
//   TRANSPORT_DEF（engine/themes.ts:22-36）的 states =
//     pending / assigned / transporting / done / exception / cancelled
//   ⇒ **没有池态**（无 claim_hall 之类可落的"等待池"）。
//   ⇒ 派不到人时按工单线 else 分支的**可移植部分**执行：保持 pending + 通知本租户 active admin，
//     不发明新状态、不改状态机定义（YAGNI，也算新增变量）。
// ═══════════════════════════════════════════════════════════════════════════
const T_TRANSPORT = 't-transport-autodispatch';
const TRANSPORT_ORDER_ID = 'to-auto-1';

/** 运送线专用夹具：与上方工单线夹具分开，避免两条线的 SQL 子串互相误命中。 */
function transportHandler(o: {
  workerRows?: any[];
  adminRows?: any[];
  inserted?: any;
  current?: any;
  updated?: any;
} = {}): QueryFn {
  return async (text: string, p?: any[]) => {
    if (text.includes('FROM workflow_def')) return { rows: [{ version: 0 }], rowCount: 1 };
    if (text.includes('INSERT INTO transport_order')) {
      return {
        rows: [o.inserted ?? { id: TRANSPORT_ORDER_ID, code: 'T-1', status: 'pending', carrier: null, def_version: 0 }],
        rowCount: 1,
      };
    }
    if (text.includes('SELECT id, skill_tags, load, active FROM worker')) {
      return { rows: o.workerRows ?? [], rowCount: (o.workerRows ?? []).length };
    }
    if (text.includes('SELECT * FROM transport_order WHERE id')) {
      return {
        rows: [o.current ?? { id: TRANSPORT_ORDER_ID, status: 'pending', carrier: null, def_version: 0 }],
        rowCount: 1,
      };
    }
    if (text.includes('UPDATE transport_order')) {
      return {
        rows: [o.updated ?? { id: TRANSPORT_ORDER_ID, status: 'assigned', carrier: String((p ?? [])[3] ?? null) }],
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
function transportEventTypes(calls: Array<{ text: string; params?: any[] }>): string[] {
  return calls
    .filter((c) => c.text.includes('INSERT INTO domain_event'))
    .map((c) => String((c.params ?? [])[3]));
}

/** 建单入参（只填必填项 item_name；刻意**不传** carrier ⇒ 触发自动派单）。 */
function transportInput(over: Partial<TransportOrderInput> = {}): TransportOrderInput {
  return { item_name: '标本', priority: 'normal', order_type: 'scheduled', ...over } as TransportOrderInput;
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
      transportHandler({
        workerRows: [
          { id: 'wt-1', skill_tags: '[]', load: 3, active: true },
          { id: 'wt-2', skill_tags: '[]', load: 1, active: true },
        ],
      }),
    );

    const outcome = await settle(createOrder(client, T_TRANSPORT, transportInput()));
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
    expect(transportEventTypes(calls)).toContain('dispatch');
    // 被派中的工人收到通知（与工单线 A5 fan-out 同口径；entity_type 标 transport_order）
    const notifies = calls.filter((c) => c.text.includes('INSERT INTO notification'));
    expect(notifies.length).toBe(1);
    expect(JSON.stringify(notifies[0].params)).toContain('wt-2');
    expect(JSON.stringify(notifies[0].params)).toContain('transport_order');
  });

  it('② 无在岗工人 ⇒ 不报错、保持 pending + 通知本租户 active admin（运送线无池态，不发明新状态）', async () => {
    const { client, calls } = makeClient(
      transportHandler({
        // 有工人档案但无一在岗 ⇒ 无人可派
        workerRows: [{ id: 'wt-off', skill_tags: '[]', load: 0, active: false }],
        adminRows: [{ id: 'u-admin-1' }],
      }),
    );

    const outcome = await settle(createOrder(client, T_TRANSPORT, transportInput()));
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
    expect(transportEventTypes(calls)).toContain('create');
  });

  it('③-1 回归：人工派单路径仍然能用（admin 走 dispatch → assigned）', async () => {
    const { client } = makeClient(
      transportHandler({ current: { id: TRANSPORT_ORDER_ID, status: 'pending', def_version: 0 } }),
    );
    const row = await transitionOrder(
      client,
      T_TRANSPORT,
      TRANSPORT_ORDER_ID,
      'dispatch',
      { carrier: 'w-manual', depart_at: 'now()' },
      {},
      'u-admin',
      'admin',
    );
    expect(row.status).toBe('assigned');
  });

  it('③-2 回归：人类角色门禁不因新增系统通道而被削弱（worker 派单仍 403）', async () => {
    const { client } = makeClient(
      transportHandler({ current: { id: TRANSPORT_ORDER_ID, status: 'pending', def_version: 0 } }),
    );
    const outcome = await settle(
      transitionOrder(client, T_TRANSPORT, TRANSPORT_ORDER_ID, 'dispatch', { carrier: 'w-1' }, {}, 'u-worker', 'worker'),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('FORBIDDEN');
  });

  it('③-3 系统身份通道：无人类角色 + systemAuto ⇒ dispatch 放行（否则自动派单恒 403）', async () => {
    const { client } = makeClient(
      transportHandler({ current: { id: TRANSPORT_ORDER_ID, status: 'pending', def_version: 0 } }),
    );
    // 【为什么用宽松签名】本条钉的是**尚未存在的第 9 个形参**（opts.systemAuto）；
    //   用强类型直接写会先得到 TS 编译错——那是"代码没写完"，不是"行为错了"，红得没有意义。
    //   故以 unknown 变参调用，把失败锁在断言层（下方会打印真实错误码）。
    const loose = transitionOrder as unknown as (...args: unknown[]) => Promise<any>;
    const outcome = await settle(
      loose(
        client, T_TRANSPORT, TRANSPORT_ORDER_ID, 'dispatch',
        { carrier: 'wt-2', depart_at: 'now()' }, {}, 'auto_dispatch', undefined, { systemAuto: true },
      ),
    );
    expect(outcome.ok, `系统派单不得被人类角色门禁挡住（失败码：${outcome.code}）`).toBe(true);
    expect(outcome.row.status).toBe('assigned');
  });

  it('③-4 回归：显式传了 carrier 的建单保持原行为（尊重调用方明确意图，不覆盖）', async () => {
    const { client, calls } = makeClient(
      transportHandler({
        workerRows: [{ id: 'wt-1', skill_tags: '[]', load: 0, active: true }],
        inserted: { id: TRANSPORT_ORDER_ID, code: 'T-1', status: 'pending', carrier: 'w-explicit', def_version: 0 },
      }),
    );
    const outcome = await settle(createOrder(client, T_TRANSPORT, transportInput({ carrier: 'w-explicit' })));
    expect(outcome.ok).toBe(true);
    expect(outcome.row.carrier).toBe('w-explicit');
    expect(calls.find((c) => c.text.includes('UPDATE transport_order'))).toBeUndefined();
  });
});
