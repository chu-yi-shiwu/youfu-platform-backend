// 注册制批次三（卡4 结算三凭证）单测：mock client 走真实调用路径（同 batchC 范式，不依赖真实 PG）。
// 覆盖：验收边注入（幂等）、验收 pass/reject 主链路（事件钉死/联动/SLA 重置）、
//       Y3 防后门守卫、结算建草稿预填/冲突、改价重算、确认锁定幂等、CSV 表头、权限矩阵。
import { describe, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import { RICH_WORK_ORDER_DEF, DEFAULT_WORK_ORDER_DEF, type WorkflowDef } from '../engine/stateMachine.js';
import { ensureAcceptanceEdges, hasAcceptanceEdges, ACCEPTANCE_EDGES } from '../engine/acceptanceEdges.js';
import {
  applyAcceptance,
  assertAcceptanceRole,
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
type Handler = { match: (text: string) => boolean; reply: (text: string, params: any[]) => any };
function makeMock(handlers: Handler[]) {
  const calls: Array<{ text: string; params?: any[] }> = [];
  const client = {
    query: async (text: string, params?: any[]) => {
      calls.push({ text, params });
      for (const h of handlers) {
        if (h.match(text)) return h.reply(text, params ?? []);
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;
  return { client, calls };
}

// 带验收边的富模板（模拟已升级租户的 workflow_def 行）
const richWithAcceptance: WorkflowDef = ensureAcceptanceEdges(RICH_WORK_ORDER_DEF).def;

const T = 't-batch3';
const WO = 'WO_20260905_0001'; // 业务号风格（001 主键 work_orders.id = text，live 修复后测试形态与真库一致）

function acceptanceHandlers(orderStatus: string) {
  return [
    { match: (t: string) => t.includes('FROM work_orders') && t.includes('FOR UPDATE'), reply: () => ({ rows: [{ id: WO, tenant_id: T, order_no: 'WO_1', status: orderStatus }] }) },
    { match: (t: string) => t.includes('FROM workflow_def'), reply: () => ({ rows: [{ def: richWithAcceptance }] }) },
    { match: (t: string) => t.includes('INSERT INTO work_acceptance'), reply: () => ({ rows: [{ id: 'acc-1' }] }) },
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

  it('角色门禁：worker 不允许验收（403）', async () => {
    expect(() => assertAcceptanceRole('worker')).toThrowError();
    expect(() => assertAcceptanceRole('reviewer')).not.toThrowError();
    expect(() => assertAcceptanceRole(undefined)).toThrowError();
  });
});

describe('Y3 防后门守卫（通用 transition 端点禁走验收事件 · QA 修复② 无条件版）', () => {
  it('acceptance_* 事件 → 一律 403（不看客户端自证标记）', () => {
    expect(() => assertAcceptanceBackdoorGuard('acceptance_pass')).toThrowError(/专用验收端点/);
    try {
      assertAcceptanceBackdoorGuard('acceptance_reject');
    } catch (e: any) {
      expect(e.status).toBe(403);
    }
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
  const orders = [
    { id: 'wo-20260905-0001', order_no: 'WO_1', status: 'completed', category: '空调维修' },
    { id: 'wo-20260905-0002', order_no: 'WO_2', status: 'closed', category: '未知分类' },
  ];

  function draftHandlers(opts?: { settled?: any[]; orderRows?: any[] }) {
    return [
      { match: (t: string) => t.includes('FROM work_orders') && t.includes('ANY($2'), reply: () => ({ rows: opts?.orderRows ?? orders }) },
      { match: (t: string) => t.includes('FROM settlement_item si') && t.includes('JOIN work_orders'), reply: () => ({ rows: opts?.settled ?? [] }) },
      { match: (t: string) => t.includes('FROM settlement WHERE tenant_id') && t.includes('COUNT'), reply: () => ({ rows: [{ c: 0 }] }) },
      { match: (t: string) => t.includes("INSERT INTO settlement (") , reply: () => ({ rows: [{ id: 'st-1' }] }) },
      { match: (t: string) => t.includes('FROM product_catalog'), reply: (_t: string, p: any[]) => ({ rows: p[1] === '空调维修' ? [{ code: 'AC', name: '空调维修', price: '120.00' }] : [] }) },
      { match: (t: string) => t.includes('SELECT * FROM settlement WHERE id'), reply: () => ({ rows: [{ id: 'st-1', settlement_no: 'ST202609050001', status: 'draft', total: '120.00', item_count: 2 }] }) },
    ];
  }

  it('命中价目快照 / 未命中 price=0 + note 提示；表头汇总正确；单号格式 ST+8位日期+4位序号', async () => {
    const { client, calls } = makeMock(draftHandlers());
    const r = await createSettlementDraft(client, T, ['wo-20260905-0001', 'wo-20260905-0002'], 'admin');
    expect(r.ok).toBe(true);
    expect(r.settlement!.settlement_no).toMatch(/^ST\d{8}\d{4}$/);
    expect(buildSettlementNo('20260905', 1)).toBe('ST202609050001');
    const itemIns = calls.filter((c) => c.text.includes('INSERT INTO settlement_item'));
    expect(itemIns).toHaveLength(2);
    const matched = itemIns.find((c) => c.params![2] === 'wo-20260905-0001')!;
    expect(matched.params![3]).toBe('AC');
    expect(matched.params![4]).toBe('空调维修');
    expect(Number(matched.params![5])).toBe(120);
    expect(Number(matched.params![7])).toBe(120);
    expect(matched.params![8]).toBeNull();
    const unmatched = itemIns.find((c) => c.params![2] === 'wo-20260905-0002')!;
    expect(Number(unmatched.params![5])).toBe(0);
    expect(unmatched.params![8]).toBe('价目未匹配，请手填');
    const hdr = calls.find((c) => c.text.includes('UPDATE settlement SET total'))!;
    expect(Number(hdr.params![0])).toBe(120);
    expect(hdr.params![1]).toBe(2);
  });

  it('已被任何结算单占用的工单 → 409 且列明冲突单号，不建单', async () => {
    const { client, calls } = makeMock(draftHandlers({ settled: [{ work_order_id: 'wo-20260905-0001', order_no: 'WO_1' }] }));
    const r = await createSettlementDraft(client, T, ['wo-20260905-0001'], 'admin');
    expect(r.ok).toBe(false);
    expect(r.conflicts).toEqual([{ work_order_id: 'wo-20260905-0001', order_no: 'WO_1', reason: 'already_settled' }]);
    expect(calls.find((c) => c.text.includes('INSERT INTO settlement ('))).toBeUndefined();
  });

  it('状态不可入账（processing）→ 409 bad_status', async () => {
    const { client } = makeMock(draftHandlers({ orderRows: [{ id: 'wo-20260905-0001', order_no: 'WO_1', status: 'processing', category: null }] }));
    const r = await createSettlementDraft(client, T, ['wo-20260905-0001'], 'admin');
    expect(r.ok).toBe(false);
    expect(r.conflicts![0].reason).toBe('bad_status');
  });

  it('工单不存在 → 409 not_found', async () => {
    const { client } = makeMock(draftHandlers({ orderRows: [] }));
    const r = await createSettlementDraft(client, T, ['wo-20260905-9999'], 'admin');
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
        if (text.includes('FROM product_catalog')) return { rows: params![1] === '空调维修' ? [{ code: 'AC', name: '空调维修', price: '120.00' }] : [] };
        if (text.includes('SELECT * FROM settlement WHERE id')) return { rows: [{ id: 'st-1', settlement_no: 'STX', status: 'draft', total: '120.00', item_count: 2 }] };
        return { rows: [], rowCount: 1 };
      },
    } as unknown as PoolClient;
    const r = await createSettlementDraft(client, T, ['wo-20260905-0001', 'wo-20260905-0002'], 'admin');
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
    expect(ins.params![2]).toBe(uuidLike);
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
  const item = { id: 'si-1', settlement_id: 'st-1', tenant_id: T, work_order_id: 'wo-20260905-0001', price: '100', qty: '1', amount: '100', note: null };

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
