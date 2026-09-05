// 注册制批次三（卡4 结算三凭证）单测：mock client 走真实调用路径（同 batchC 范式，不依赖真实 PG）。
// 覆盖：验收边注入（幂等）、验收 pass/reject 主链路（事件钉死/联动/SLA 重置）、
//       Y3 防后门守卫、结算建草稿预填/冲突、改价重算、确认锁定幂等、CSV 表头、权限矩阵。
import { describe, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import { RICH_WORK_ORDER_DEF, DEFAULT_WORK_ORDER_DEF, type WorkflowDef } from '../engine/stateMachine.js';
import { ensureAcceptanceEdges, hasAcceptanceEdges, ACCEPTANCE_EDGES } from '../engine/acceptanceEdges.js';
import {
  applyAcceptance,
  assertAcceptanceBackdoorGuard,
} from '../services/acceptance.js';
import {
  buildSettlementNo,
  buildSettlementCsv,
  createSettlementDraft,
  updateSettlementItem,
  confirmSettlement,
  deleteSettlement,
} from '../repo/settlement.js';
import { DEFAULT_PERM_MATRIX, PERMS } from '../middleware/role.js';

// ---- mock client（脚本式：按 SQL 片段匹配返回，记录全部调用）----
// 兜底改动：原先未命中任何 handler 的 SQL 会静默返回 {rows:[],rowCount:1}——
// 新增/改写 SQL 时测试毫无感知（这正是"结构一致性"事故的共同根因）。
// 现记录 misses；传 {strict:true} 时未命中直接抛错，用于「SQL 全覆盖」收口用例。
type Handler = { match: (text: string) => boolean; reply: (text: string, params: any[]) => any };
function makeMock(handlers: Handler[], opts?: { strict?: boolean }) {
  const calls: Array<{ text: string; params?: any[] }> = [];
  const misses: string[] = [];
  const client = {
    query: async (text: string, params?: any[]) => {
      calls.push({ text, params });
      for (const h of handlers) {
        if (h.match(text)) return h.reply(text, params ?? []);
      }
      misses.push(text);
      if (opts?.strict) throw new Error(`[mock] 未命中 handler 的 SQL（新增/改写了 SQL？）：${text}`);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;
  return { client, calls, misses };
}

/** 收口断言：捕获同步抛出的错误；没抛错返回 null（断言非 null = 杜绝"不抛错就空过"）。 */
function catchSync(fn: () => void): (Error & { status?: number }) | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e as Error & { status?: number };
  }
}

/**
 * 收口断言（异步版）：把 promise 的成败显式收成 {ok, value|error}。
 * 目的：禁止 `try{ await x }catch(e){ expect(e.status)... }` 这种「没抛错就整段跳过」的写法——
 * 用 settle 后必须显式断言 ok===false（接口要是正常返回，这条断言立刻红）。
 */
async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: any }> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

// 带验收边的富模板（模拟已升级租户的 workflow_def 行）
const richWithAcceptance: WorkflowDef = ensureAcceptanceEdges(RICH_WORK_ORDER_DEF).def;

const T = 't-batch3';

/**
 * 与 src/repo/ticket.ts:66-70 genOrderNo **同口径**的业务号：WO_YYYYMMDD_10位随机。
 * 背景：本文件原先用两种自相矛盾的假数据形态（WO_20260905_0001 的 4 位序号 / wo-20260905-0001 的连字符），
 * 与真库生成器都不一致——假数据"恰好像 uuid/像别的东西"正是 071 事故（uuid vs text）能在单测里全绿的原因。
 * 现统一走生成器口径；另保留一条"uuid 形态字符串也接受"的用例（text 列不挑形态）。
 */
function genOrderNoLike(d: Date = new Date()): string {
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = String(Math.floor(Math.random() * 4_294_967_296)).padStart(10, '0'); // 0..2^32-1，同 genOrderNo 熵
  return `WO_${ymd}_${rand}`;
}

const WO = genOrderNoLike();
const WO2 = genOrderNoLike();

function acceptanceHandlers(orderStatus: string, opts?: { slaMinutes?: number | null; def?: WorkflowDef }) {
  const def = opts?.def ?? richWithAcceptance;
  const slaMinutes = opts?.slaMinutes === undefined ? null : opts.slaMinutes;
  return [
    { match: (t: string) => t.includes('FROM work_orders') && t.includes('FOR UPDATE'), reply: () => ({ rows: [{ id: WO, tenant_id: T, order_no: 'WO_1', status: orderStatus, assignee_id: null, sla_minutes: slaMinutes }] }) },
    { match: (t: string) => t.includes('FROM workflow_def'), reply: () => ({ rows: [{ def }] }) },
    { match: (t: string) => t.includes('INSERT INTO work_acceptance'), reply: () => ({ rows: [{ id: 'acc-1' }] }) },
    { match: (t: string) => t.includes('UPDATE work_orders SET status') && t.includes('RETURNING'), reply: (_t: string, p: any[]) => ({ rows: [{ id: WO, status: p[0], tenant_id: T }] }) },
    { match: (t: string) => t.includes('INSERT INTO ticket_event'), reply: () => ({ rows: [], rowCount: 1 }) },
    { match: (t: string) => t.includes('INSERT INTO domain_event'), reply: () => ({ rows: [], rowCount: 1 }) },
    { match: (t: string) => t.includes('UPDATE worker SET load'), reply: () => ({ rows: [], rowCount: 1 }) },
    { match: (t: string) => t.includes('DELETE FROM settlement_item') && t.includes('RETURNING'), reply: () => ({ rows: [{ settlement_id: 'st-1' }], rowCount: 1 }) },
    { match: (t: string) => t.includes('DELETE FROM settlement s'), reply: () => ({ rows: [], rowCount: 1 }) },
    { match: (t: string) => t.includes('sla_due_at = NULL'), reply: () => ({ rows: [], rowCount: 1 }) },
    { match: (t: string) => t.includes("sla_due_at = now() + ($3::int * interval '1 minute')"), reply: () => ({ rows: [], rowCount: 1 }) },
  ];
}

describe('验收边注入（ensureAcceptanceEdges 纯函数 · 幂等）', () => {
  it('DEFAULT 4 态图注入两条验收边 + 补 closed 目标态', () => {
    const { def, added } = ensureAcceptanceEdges(DEFAULT_WORK_ORDER_DEF);
    expect(added).toHaveLength(2);
    expect(hasAcceptanceEdges(def)).toBe(true);
    expect(def.states).toContain('closed');
    const pass = def.transitions.find((t) => t.event === 'acceptance_pass');
    const reject = def.transitions.find((t) => t.event === 'acceptance_reject');
    expect(pass).toMatchObject({ from: 'completed', to: 'closed' });
    expect(reject).toMatchObject({ from: 'completed', to: 'processing' });
    expect(pass?.allowedRoles).toEqual(['admin', 'operator', 'reviewer']);
  });

  it('二次注入幂等：added 为空、def 不重复加边', () => {
    const once = ensureAcceptanceEdges(DEFAULT_WORK_ORDER_DEF).def;
    const twice = ensureAcceptanceEdges(once);
    expect(twice.added).toHaveLength(0);
    expect(twice.def.transitions.filter((t) => t.event?.startsWith('acceptance_'))).toHaveLength(2);
    expect(twice.def.states.filter((s) => s === 'closed')).toHaveLength(1);
  });

  it('RICH 模板注入：目标态已存在则不重复加态', () => {
    const { def, added } = ensureAcceptanceEdges(RICH_WORK_ORDER_DEF);
    expect(added).toHaveLength(2);
    expect(def.states.filter((s) => s === 'closed')).toHaveLength(1);
    expect(def.states.filter((s) => s === 'processing')).toHaveLength(1);
  });

  it('常量边与 allowedRoles 契约（验收端点角色门禁同源）', () => {
    expect(ACCEPTANCE_EDGES.map((e) => e.event)).toEqual(['acceptance_pass', 'acceptance_reject']);
  });
});

describe('applyAcceptance（验收主链路 · mock client 走真实 transition 路径）', () => {
  it('pass：落完工凭证 + transition 钉死 acceptance_pass → closed', async () => {
    const { client, calls } = makeMock(acceptanceHandlers('completed'));
    const out = await applyAcceptance(client, T, WO, { result: 'pass', role: 'admin', actor: 'admin', note: 'OK' });
    expect(out.status).toBe('closed');
    const ins = calls.find((c) => c.text.includes('INSERT INTO work_acceptance'))!;
    expect(ins).toBeTruthy();
    expect(ins.params![2]).toBe('pass');
    expect(JSON.parse(ins.params![4])).toEqual([]);
    // transition 更新状态到 closed
    const upd = calls.find((c) => c.text.includes('UPDATE work_orders SET status') && c.text.includes('RETURNING'))!;
    expect(upd.params![0]).toBe('closed');
    // 事件钉死：ticket_event payload 携带 acceptance_pass
    const ev = calls.find((c) => c.text.includes('INSERT INTO ticket_event') && c.text.includes('transition'))!;
    expect(ev.params![5]).toContain('acceptance_pass');
    // pass 不触发结算清理 / SLA 重置
    expect(calls.find((c) => c.text.includes('DELETE FROM settlement_item'))).toBeUndefined();
    expect(calls.find((c) => c.text.includes('sla_due_at = NULL'))).toBeUndefined();
  });

  it('reject：transition 钉死 acceptance_reject → processing + 清草稿明细 + SLA 重置', async () => {
    const { client, calls } = makeMock(acceptanceHandlers('completed'));
    const out = await applyAcceptance(client, T, WO, { result: 'reject', role: 'reviewer', actor: 'reviewer', note: '维修不到位' });
    expect(out.status).toBe('processing');
    const upd = calls.find((c) => c.text.includes('UPDATE work_orders SET status') && c.text.includes('RETURNING'))!;
    expect(upd.params![0]).toBe('processing');
    const ev = calls.find((c) => c.text.includes('INSERT INTO ticket_event') && c.text.includes('transition'))!;
    expect(ev.params![5]).toContain('acceptance_reject');
    // Y4 联动：清草稿结算明细（含清空后删草稿单）
    const delItem = calls.find((c) => c.text.includes('DELETE FROM settlement_item') && c.text.includes("s.status = 'draft'"))!;
    expect(delItem.params![0]).toBe(T);
    expect(delItem.params![1]).toBe(WO);
    expect(calls.find((c) => c.text.includes('DELETE FROM settlement s') && c.text.includes('NOT EXISTS'))).toBeTruthy();
    // O3 SLA 重置：reject 后 sla_due_at=NULL
    const sla = calls.find((c) => c.text.includes('sla_due_at = NULL'))!;
    expect(sla.params).toEqual([WO, T]);
  });

  it('非 completed 单 → 409（拒绝验收）', async () => {
    const { client } = makeMock(acceptanceHandlers('processing'));
    await expect(applyAcceptance(client, T, WO, { result: 'pass', role: 'admin' })).rejects.toMatchObject({ status: 409 });
  });

  it('工单不存在 → 404', async () => {
    const { client } = makeMock([
      { match: (t: string) => t.includes('FOR UPDATE'), reply: () => ({ rows: [] }) },
    ]);
    await expect(applyAcceptance(client, T, WO, { result: 'pass', role: 'admin' })).rejects.toMatchObject({ status: 404 });
  });

  it('角色门禁（单一事实源 = workflow_def 验收边 allowedRoles）：worker → 403', async () => {
    // 架构🔴2：删除硬编码 ACCEPTANCE_ROLES 白名单后，角色由 transition() 的边 allowedRoles 统一判定。
    // 断言用 settle 收口：接口要是正常放行，ok===true → 断言立刻红（不是"没抛错就跳过"）。
    const { client } = makeMock(acceptanceHandlers('completed'));
    const r = await settle(applyAcceptance(client, T, WO, { result: 'pass', role: 'worker', actor: 'worker' }));
    expect(r.ok, 'worker 验收必须被拒（期望 reject 而非 resolve）').toBe(false);
    expect(r.ok === false && r.error.status).toBe(403);
  });

  it('角色门禁：reviewer 在验收边 allowedRoles 内 → 放行并落完工凭证', async () => {
    const { client, calls } = makeMock(acceptanceHandlers('completed'));
    const out = await applyAcceptance(client, T, WO, { result: 'pass', role: 'reviewer', actor: 'reviewer' });
    expect(out.status).toBe('closed');
    expect(calls.some((c) => c.text.includes('INSERT INTO work_acceptance'))).toBe(true);
  });

  it('老租户 def 缺验收边 → 409 且文案含「启用完工验收」（而非看不懂的 422）', async () => {
    const legacyDef = JSON.parse(JSON.stringify(DEFAULT_WORK_ORDER_DEF)) as WorkflowDef;
    const { client } = makeMock(acceptanceHandlers('completed', { def: legacyDef }));
    const r = await settle(applyAcceptance(client, T, WO, { result: 'pass', role: 'admin', actor: 'admin' }));
    expect(r.ok, '缺验收边必须被拒').toBe(false);
    expect(r.ok === false && r.error.status).toBe(409);
    expect(r.ok === false && String(r.error.message)).toContain('启用完工验收');
  });

  it('缺验收边时不得落 work_acceptance 凭证（409 必须发生在写之前）', async () => {
    const legacyDef = JSON.parse(JSON.stringify(DEFAULT_WORK_ORDER_DEF)) as WorkflowDef;
    const { client, calls } = makeMock(acceptanceHandlers('completed', { def: legacyDef }));
    await applyAcceptance(client, T, WO, { result: 'pass', role: 'admin' }).catch(() => undefined);
    expect(calls.some((c) => c.text.includes('INSERT INTO work_acceptance'))).toBe(false);
  });

  it('SLA 重置按 sla_minutes 重算；无时长来源才置 NULL（架构🟡7）', async () => {
    const withMinutes = makeMock(acceptanceHandlers('completed', { slaMinutes: 120 }));
    await applyAcceptance(withMinutes.client, T, WO, { result: 'reject', role: 'admin' });
    const recalc = withMinutes.calls.find((c) => c.text.includes('sla_due_at = now()'))!;
    expect(recalc).toBeTruthy();
    expect(recalc.params![2]).toBe(120);
    expect(withMinutes.calls.some((c) => c.text.includes('sla_due_at = NULL'))).toBe(false);

    const noMinutes = makeMock(acceptanceHandlers('completed', { slaMinutes: null }));
    await applyAcceptance(noMinutes.client, T, WO, { result: 'reject', role: 'admin' });
    expect(noMinutes.calls.some((c) => c.text.includes('sla_due_at = NULL'))).toBe(true);
  });
});

describe('Y3 防后门守卫（通用 transition 端点禁走验收事件 · QA 修复② 无条件版）', () => {
  it('acceptance_* 事件 → 一律 403（不看客户端自证标记）', () => {
    // 收口写法：catchSync 拿不到错误即返回 null，断言非 null 会失败——杜绝原 try/catch 的"不抛错就空过"。
    const e1 = catchSync(() => assertAcceptanceBackdoorGuard('acceptance_pass'));
    expect(e1, 'acceptance_pass 必须被拦截（期望抛错）').not.toBeNull();
    expect(e1!.status).toBe(403);
    expect(e1!.message).toContain('专用验收端点');

    const e2 = catchSync(() => assertAcceptanceBackdoorGuard('acceptance_reject'));
    expect(e2, 'acceptance_reject 必须被拦截（期望抛错）').not.toBeNull();
    expect(e2!.status).toBe(403);
  });
  it('客户端伪造 via=acceptance 也无法绕过（守卫不接收该参数）', () => {
    expect(() => assertAcceptanceBackdoorGuard('acceptance_pass')).toThrowError(/专用验收端点/);
  });
  it('普通事件不受影响', () => {
    expect(() => assertAcceptanceBackdoorGuard('close')).not.toThrowError();
    expect(() => assertAcceptanceBackdoorGuard(null)).not.toThrowError();
  });
});

describe('结算建草稿（createSettlementDraft · 预填/汇总/冲突）', () => {
  // 假数据统一走真库生成器口径（WO_YYYYMMDD_10位随机），不再用自相矛盾的连字符形态
  const orders = [
    { id: WO, order_no: 'WO_1', status: 'completed', category: '空调维修' },
    { id: WO2, order_no: 'WO_2', status: 'closed', category: '未知分类' },
  ];

  function draftHandlers(opts?: { settled?: any[]; orderRows?: any[] }) {
    return [
      { match: (t: string) => t.includes('FROM work_orders') && t.includes('ANY($2'), reply: () => ({ rows: opts?.orderRows ?? orders }) },
      { match: (t: string) => t.includes('FROM settlement_item si') && t.includes('JOIN work_orders'), reply: () => ({ rows: opts?.settled ?? [] }) },
      { match: (t: string) => t.includes('FROM settlement WHERE tenant_id') && t.includes('COUNT'), reply: () => ({ rows: [{ c: 0 }] }) },
      { match: (t: string) => t.startsWith('SAVEPOINT') || t.startsWith('RELEASE SAVEPOINT') || t.startsWith('ROLLBACK TO SAVEPOINT'), reply: () => ({ rows: [], rowCount: 0 }) },
      { match: (t: string) => t.includes("INSERT INTO settlement (") , reply: () => ({ rows: [{ id: 'st-1' }] }) },
      { match: (t: string) => t.includes('FROM product_catalog'), reply: (_t: string, p: any[]) => ({ rows: (p[1] as string[] | undefined)?.includes('空调维修') ? [{ code: 'AC', name: '空调维修', price: '120.00' }] : [] }) },
      { match: (t: string) => t.includes('INSERT INTO settlement_item'), reply: () => ({ rows: [], rowCount: 2 }) },
      { match: (t: string) => t.includes('UPDATE settlement SET total'), reply: () => ({ rows: [], rowCount: 1 }) },
      { match: (t: string) => t.includes('SELECT * FROM settlement WHERE id'), reply: () => ({ rows: [{ id: 'st-1', settlement_no: 'ST202609050001', status: 'draft', total: '120.00', item_count: 2 }] }) },
    ];
  }

  it('命中价目快照 / 未命中 price=0 + note 提示；表头汇总正确；单号格式 ST+8位日期+4位序号', async () => {
    const { client, calls } = makeMock(draftHandlers());
    const r = await createSettlementDraft(client, T, [WO, WO2], 'admin');
    expect(r.ok).toBe(true);
    expect(r.settlement!.settlement_no).toMatch(/^ST\d{8}\d{4}$/);
    expect(buildSettlementNo('20260905', 1)).toBe('ST202609050001');
    // 架构🔴3 批量化：明细预填由「循环内逐单 INSERT」改为一条 unnest 多行 INSERT（消 N+1 往返），
    // 入参是等长数组：[$tenant, $settlementId, woIds[], catCodes[], catNames[], prices[], qtys[], amounts[], notes[]]
    const itemIns = calls.filter((c) => c.text.includes('INSERT INTO settlement_item'));
    expect(itemIns).toHaveLength(1);
    const p = itemIns[0].params!;
    expect(p[2]).toEqual([WO, WO2]);
    const i = (p[2] as string[]).indexOf(WO);
    expect(p[3][i]).toBe('AC');                  // 命中价目：code 快照
    expect(p[4][i]).toBe('空调维修');              // 命中价目：name 快照
    expect(Number(p[5][i])).toBe(120);           // price 快照
    expect(Number(p[6][i])).toBe(1);             // qty 默认 1
    expect(Number(p[7][i])).toBe(120);           // amount = price * qty
    expect(p[8][i]).toBeNull();                  // 命中不写提示
    const j = (p[2] as string[]).indexOf(WO2);
    expect(Number(p[5][j])).toBe(0);             // 未命中 price=0
    expect(p[8][j]).toBe('价目未匹配，请手填');    // 未命中 note 提示
    const hdr = calls.find((c) => c.text.includes('UPDATE settlement SET total'))!;
    expect(Number(hdr.params![0])).toBe(120);
    expect(hdr.params![1]).toBe(2);
  });

  it('已被任何结算单占用的工单 → 409 且列明冲突单号，不建单', async () => {
    const { client, calls } = makeMock(draftHandlers({ settled: [{ work_order_id: WO, order_no: 'WO_1' }] }));
    const r = await createSettlementDraft(client, T, [WO], 'admin');
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual([{ work_order_id: WO, order_no: 'WO_1', reason: 'already_settled' }]);
    expect(calls.find((c) => c.text.includes('INSERT INTO settlement ('))).toBeUndefined();
  });

  it('状态不可入账（processing）→ 409 bad_status', async () => {
    const { client } = makeMock(draftHandlers({ orderRows: [{ id: WO, order_no: 'WO_1', status: 'processing', category: null }] }));
    const r = await createSettlementDraft(client, T, [WO], 'admin');
    expect(r.ok).toBe(false);
    expect(r.conflicts![0].reason).toBe('bad_status');
  });

  it('工单不存在 → 409 not_found', async () => {
    const { client } = makeMock(draftHandlers({ orderRows: [] }));
    const r = await createSettlementDraft(client, T, [genOrderNoLike()], 'admin'); // 生成器口径的不存在单号
    expect(r.ok).toBe(false);
    expect(r.conflicts![0].reason).toBe('not_found');
  });

  it('单号 23505 冲突：SAVEPOINT 回滚后 seq+1 重试成功（QA 修复③）', async () => {
    const calls: Array<{ text: string; params?: any[] }> = [];
    let insertAttempts = 0;
    const client = {
      query: async (text: string, params?: any[]) => {
        calls.push({ text, params });
        if (text.includes('INSERT INTO settlement (')) {
          insertAttempts += 1;
          if (insertAttempts === 1) {
            const err: any = new Error('duplicate key value violates unique constraint');
            err.code = '23505';
            throw err; // 模拟同事务撞唯一键（若不 SAVEPOINT 回滚，PG 事务 aborted 后续必 500）
          }
          return { rows: [{ id: 'st-1' }] };
        }
        if (text.includes('FROM work_orders') && text.includes('ANY($2')) return { rows: orders };
        if (text.includes('FROM settlement_item si') && text.includes('JOIN work_orders')) return { rows: [] };
        if (text.includes('FROM settlement WHERE tenant_id') && text.includes('COUNT')) return { rows: [{ c: 0 }] };
        if (text.includes('FROM product_catalog')) return { rows: (params![1] as string[] | undefined)?.includes('空调维修') ? [{ code: 'AC', name: '空调维修', price: '120.00' }] : [] };
        if (text.includes('SELECT * FROM settlement WHERE id')) return { rows: [{ id: 'st-1', settlement_no: 'STX', status: 'draft', total: '120.00', item_count: 2 }] };
        return { rows: [], rowCount: 1 };
      },
    } as unknown as PoolClient;
    const r = await createSettlementDraft(client, T, [WO, WO2], 'admin');
    expect(r.ok).toBe(true);
    const texts = calls.map((c) => c.text);
    // 语句序列：SAVEPOINT → INSERT(撞23505) → ROLLBACK TO → SAVEPOINT → INSERT(成功) → RELEASE
    const saveIdx = texts.findIndex((t) => t.includes('SAVEPOINT st_no_retry'));
    const rollbackIdx = texts.findIndex((t) => t.includes('ROLLBACK TO SAVEPOINT st_no_retry'));
    const releaseIdx = texts.findIndex((t) => t.includes('RELEASE SAVEPOINT st_no_retry'));
    expect(saveIdx).toBeGreaterThanOrEqual(0);
    expect(rollbackIdx).toBeGreaterThan(saveIdx);
    expect(releaseIdx).toBeGreaterThan(rollbackIdx);
    expect(calls.filter((c) => c.text.includes('ROLLBACK TO SAVEPOINT'))).toHaveLength(1);
    // 重试单号 seq 递增：0001 → 0002
    const inserts = calls.filter((c) => c.text.includes('INSERT INTO settlement ('));
    expect(inserts).toHaveLength(2);
    expect(inserts[0].params![1]).toMatch(/\d{4}0001$/);
    expect(inserts[1].params![1]).toMatch(/\d{4}0002$/);
  });

  it('work_order_ids 含 uuid 形态字符串同样接受（text 列不设限，防 uuid 校验回归）', async () => {
    // live 修复锚点：work_orders.id 是 text 业务号，zod/repo 层不得恢复 z.string().uuid() / ::uuid[] cast；
    // text 列天然兼容 uuid 形态字符串——两种形态都必须走通建草稿流程。
    const uuidLike = '7f3a9c2e-1b2c-4d5e-8f90-a1b2c3d4e5f6';
    const rows = [{ id: uuidLike, order_no: 'WO_U', status: 'completed', category: null }];
    const { client, calls } = makeMock(draftHandlers({ orderRows: rows }));
    const r = await createSettlementDraft(client, T, [uuidLike], 'admin');
    expect(r.ok).toBe(true);
    const ins = calls.find((c) => c.text.includes('INSERT INTO settlement_item'))!;
    // 批量化后 work_order_id 入参是 text[] 数组（unnest），不再是单个字符串
    expect(ins.params![2]).toEqual([uuidLike]);
  });

  it('业务号形态自洽：假数据必须是真库生成器口径 WO_YYYYMMDD_10位随机', () => {
    // 071 事故根因之一：假数据形态自相矛盾且与真库不一致，导致 uuid/text 错配在单测里全绿。
    expect(WO).toMatch(/^WO_\d{8}_\d{10}$/);
    expect(WO2).toMatch(/^WO_\d{8}_\d{10}$/);
    expect(WO).not.toBe(WO2);
  });
});

describe('结算改明细 / 确认 / 删除（状态机与重算）', () => {
  function itemHandlers(header: any, item: any, agg = { total: '250.00', c: 1 }, finalHeader?: any) {
    return [
      { match: (t: string) => t.includes('FROM settlement WHERE id = $1 AND tenant_id = $2 FOR UPDATE'), reply: () => ({ rows: [header] }) },
      { match: (t: string) => t.includes('FROM settlement_item WHERE id = $1 AND settlement_id'), reply: () => ({ rows: [item] }) },
      { match: (t: string) => t.includes('SUM(amount)'), reply: () => ({ rows: [agg] }) },
      { match: (t: string) => t.includes('SELECT * FROM settlement WHERE id'), reply: () => ({ rows: [finalHeader ?? { ...header, total: agg.total, item_count: agg.c }] }) },
      { match: (t: string) => t.includes('COUNT(*)::int AS c FROM settlement_item WHERE settlement_id'), reply: () => ({ rows: [{ c: agg.c }] }) },
    ];
  }
  const header = { id: 'st-1', tenant_id: T, settlement_no: 'ST202609050001', status: 'draft', total: '100.00', item_count: 1 };
  const item = { id: 'si-1', settlement_id: 'st-1', tenant_id: T, work_order_id: WO, price: '100', qty: '1', amount: '100', note: null };

  it('草稿改价重算：amount 与表头 total 同步更新', async () => {
    const { client, calls } = makeMock(itemHandlers(header, item));
    const s = await updateSettlementItem(client, T, 'st-1', 'si-1', { price: 250 });
    expect(s.total).toBe('250.00');
    const upd = calls.find((c) => c.text.includes('UPDATE settlement_item SET price'))!;
    expect(Number(upd.params![0])).toBe(250);
    expect(Number(upd.params![2])).toBe(250); // amount = 250*1
  });

  it('confirmed 后改明细 → 409', async () => {
    const { client } = makeMock(itemHandlers({ ...header, status: 'confirmed' }, item));
    await expect(updateSettlementItem(client, T, 'st-1', 'si-1', { price: 1 })).rejects.toMatchObject({ status: 409 });
  });

  it('confirmed 后删除 → 409', async () => {
    const { client } = makeMock(itemHandlers({ ...header, status: 'confirmed' }, item));
    await expect(deleteSettlement(client, T, 'st-1')).rejects.toMatchObject({ status: 409 });
  });

  it('草稿删除：DELETE 执行（CASCADE 释放明细）', async () => {
    const { client, calls } = makeMock(itemHandlers(header, item));
    await deleteSettlement(client, T, 'st-1');
    expect(calls.find((c) => c.text.startsWith('DELETE FROM settlement WHERE'))).toBeTruthy();
  });

  it('确认锁定成功：draft→confirmed + confirmed_by/confirmed_at 落库', async () => {
    const { client, calls } = makeMock(itemHandlers(header, item, { total: '100.00', c: 1 }, { ...header, status: 'confirmed' }));
    const s = await confirmSettlement(client, T, 'st-1', 'admin');
    expect(s.status).toBe('confirmed');
    const upd = calls.find((c) => c.text.includes("SET status = 'confirmed'"))!;
    expect(upd.params![0]).toBe('admin');
  });

  it('确认幂等冲突：已确认再确认 → 409', async () => {
    const { client } = makeMock(itemHandlers({ ...header, status: 'confirmed' }, item));
    await expect(confirmSettlement(client, T, 'st-1', 'admin')).rejects.toMatchObject({ status: 409 });
  });

  it('0 明细不可确认 → 409', async () => {
    const { client } = makeMock(itemHandlers(header, item, { total: '0.00', c: 0 }));
    await expect(confirmSettlement(client, T, 'st-1', 'admin')).rejects.toMatchObject({ status: 409 });
  });
});

describe('结算 CSV 导出（BOM + UTF-8 表头）', () => {
  it('表头与首行数据正确', () => {
    const csv = buildSettlementCsv([
      { settlement_no: 'ST202609050001', category_name: '空调维修', price: '120.00', qty: '1', amount: '120.00', note: null, order_no: 'WO_1' },
    ]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('单号,分类,价目,数量,金额,备注,工单号');
    expect(csv).toContain('ST202609050001,空调维修,120.00,1,120.00,,WO_1');
  });
});

// ---- mock 收口：所有 SQL 调用都必须命中某个 handler ----
// 背景：mock client 的兜底返回 {rows:[],rowCount:1} 会让"新增/改写了一条 SQL"完全无感知——
// 这正是 071/live 类事故在单测里全绿的机制性原因。以下用例用 strict mock 跑完整主链路，
// 任何一条 SQL 没被 handler 覆盖就立刻抛错（新增 SQL 时必须同步补 handler，等于强制复核）。
describe('mock 收口（SQL 全覆盖 · 防新增/改写 SQL 无感知）', () => {
  it('applyAcceptance pass 全链路：零未命中 SQL', async () => {
    const mk = makeMock(acceptanceHandlers('completed'), { strict: true });
    const out = await applyAcceptance(mk.client, T, WO, { result: 'pass', role: 'admin', actor: 'admin' });
    expect(out.status).toBe('closed');
    expect(mk.misses).toEqual([]);
    expect(mk.calls.length).toBeGreaterThan(3);
  });

  it('applyAcceptance reject 全链路（含结算清理 + SLA 重算）：零未命中 SQL', async () => {
    const mk = makeMock(acceptanceHandlers('completed', { slaMinutes: 60 }), { strict: true });
    const out = await applyAcceptance(mk.client, T, WO, { result: 'reject', role: 'reviewer', actor: 'reviewer' });
    expect(out.status).toBe('processing');
    expect(mk.misses).toEqual([]);
    // 关键清理语句确实被走到（不是被兜底静默吞掉）
    expect(mk.calls.some((c) => c.text.includes('DELETE FROM settlement_item'))).toBe(true);
  });

  it('createSettlementDraft 全链路（含 SAVEPOINT 重试路径）：零未命中 SQL', async () => {
    const mk = makeMock(
      [
        { match: (t: string) => t.includes('FROM work_orders') && t.includes('ANY($2'), reply: () => ({ rows: [{ id: WO, order_no: 'WO_1', status: 'completed', category: '空调维修' }] }) },
        { match: (t: string) => t.includes('FROM settlement_item si') && t.includes('JOIN work_orders'), reply: () => ({ rows: [] }) },
        { match: (t: string) => t.includes('COUNT') && t.includes('FROM settlement WHERE'), reply: () => ({ rows: [{ c: 0 }] }) },
        { match: (t: string) => /^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(t), reply: () => ({ rows: [], rowCount: 0 }) },
        { match: (t: string) => t.includes('INSERT INTO settlement ('), reply: () => ({ rows: [{ id: 'st-1' }] }) },
        { match: (t: string) => t.includes('FROM product_catalog'), reply: () => ({ rows: [{ code: 'AC', name: '空调维修', price: '120.00' }] }) },
        { match: (t: string) => t.includes('INSERT INTO settlement_item'), reply: () => ({ rows: [], rowCount: 1 }) },
        { match: (t: string) => t.includes('UPDATE settlement SET total'), reply: () => ({ rows: [], rowCount: 1 }) },
        { match: (t: string) => t.includes('SELECT * FROM settlement WHERE id'), reply: () => ({ rows: [{ id: 'st-1', settlement_no: 'ST202609050001', status: 'draft', total: '120.00', item_count: 1 }] }) },
      ],
      { strict: true },
    );
    const r = await createSettlementDraft(mk.client, T, [WO], 'admin');
    expect(r.ok).toBe(true);
    expect(mk.misses).toEqual([]);
  });

  it('⚙自检：strict mock 对未命中 SQL 确实会炸（证明收口不是摆设）', async () => {
    const mk = makeMock([{ match: (t: string) => t.includes('INSERT INTO work_acceptance'), reply: () => ({ rows: [{ id: 'acc-1' }] }) }], { strict: true });
    const r = await settle(applyAcceptance(mk.client, T, WO, { result: 'pass', role: 'admin' }));
    expect(r.ok, '缺 handler 时必须抛错').toBe(false);
    expect(r.ok === false && String(r.error.message)).toContain('未命中 handler');
  });
});

describe('结算入参去重（QA🟡3 · 自撞 UNIQUE 的明确拒绝）', () => {
  it('同一 work_order_id 传两次 → 400（而非让它自己撞 UNIQUE 变 500）', async () => {
    const { client } = makeMock([
      { match: (t: string) => t.includes('FROM work_orders') && t.includes('ANY($2'), reply: () => ({ rows: [{ id: WO, order_no: 'WO_1', status: 'completed', category: null }] }) },
    ]);
    const r = await settle(createSettlementDraft(client, T, [WO, WO], 'admin'));
    expect(r.ok, '重复入参必须被拒').toBe(false);
    expect(r.ok === false && r.error.status).toBe(400);
    expect(r.ok === false && String(r.error.message)).toContain('重复');
  });

  it('重复校验在任何 SQL 之前（不发无谓查询）', async () => {
    const mk = makeMock([], { strict: true });
    await settle(createSettlementDraft(mk.client, T, [WO, WO], 'admin'));
    expect(mk.calls, '去重应在查库之前短路').toEqual([]);
  });
});

describe('权限矩阵（批次三新权限点）', () => {
  it('PERMS 含 settlement.read / settlement.edit', () => {
    expect(PERMS).toContain('settlement.read');
    expect(PERMS).toContain('settlement.edit');
  });
  it('admin 全量；operator 仅 read；其余角色无结算权限', () => {
    expect(DEFAULT_PERM_MATRIX.admin).toContain('settlement.edit');
    expect(DEFAULT_PERM_MATRIX.operator).toContain('settlement.read');
    expect(DEFAULT_PERM_MATRIX.operator).not.toContain('settlement.edit');
    for (const role of ['dispatcher', 'worker', 'reviewer', 'service_desk'] as const) {
      expect(DEFAULT_PERM_MATRIX[role]).not.toContain('settlement.read');
      expect(DEFAULT_PERM_MATRIX[role]).not.toContain('settlement.edit');
    }
  });
});
