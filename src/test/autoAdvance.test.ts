/**
 * 自动审核执行器端到端（地基④）——证明"配了规则**真的**会自动执行"，以及"红线真的挡得住"。
 *
 * 走**真实 transition 路径**（repo/ticket.ts），只 mock DB 连接池，不 mock 业务逻辑：
 *   processing --submit_review--> pending_review  ⇒ 命中启用规则 ⇒ 自动 approve ⇒ review_passed
 *
 * 与 autoRules.test.ts 的分工：那边测"规则能不能存"，这边测"存了之后引不引发"。
 */
import { describe, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import { transition } from '../repo/ticket.js';
import { RICH_WORK_ORDER_DEF, type WorkflowDef } from '../engine/stateMachine.js';
import type { AutoRule } from '../engine/autoRules.js';

const TENANT = 't-auto';
const WO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** 工单行（assignee 恒空 → 绕开 load 结算与 K2 影子回填，聚焦自动审核本身）。 */
const woRow = (status: string) => ({
  id: WO,
  tenant_id: TENANT,
  order_no: 'WO-AUTO-1',
  business_type: 'repair',
  catalog: '设施维修',
  priority: 'normal',
  location: null,
  title: null,
  description: null,
  contact: null,
  status,
  assignee_id: null,
  auto_flow: false,
  assets: null,
  ext: {},
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
});

/**
 * 造 mock client：用一个可变 status 模拟库的真实推进。
 * @param def       本租户流程定义
 * @param autoRules workflow_auto_rule 查询的返回（模拟表里已配的规则）
 */
function mkClient(def: WorkflowDef, autoRules: Array<Record<string, unknown>>) {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  let status = 'processing';
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      // findOneForUpdate（行锁读）
      if (text.includes('FOR UPDATE')) return { rows: [woRow(status)], rowCount: 1 };
      // getWorkflowDef
      if (text.includes('SELECT def FROM workflow_def')) return { rows: [{ def }], rowCount: 1 };
      // 状态推进（真实落库点）
      if (text.includes('UPDATE work_orders SET status')) {
        status = String(params[0]);
        return { rows: [woRow(status)], rowCount: 1 };
      }
      // 地基④：启用中的自动审核规则
      if (text.includes('FROM workflow_auto_rule')) return { rows: autoRules, rowCount: autoRules.length };
      if (text.includes('INSERT INTO ticket_event')) return { rows: [], rowCount: 1 };
      if (text.includes('INSERT INTO domain_event')) return { rows: [], rowCount: 1 };
      if (text.includes('UPDATE worker SET load')) return { rows: [], rowCount: 1 };
      if (text.includes('sla_paused_at')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PoolClient;
  return { client, calls, status: () => status };
}

/** 把 AutoRule 转成 mock 表行（列名与 repo/autoRule.ts 的 SELECT 一致）。 */
const rowOf = (r: Partial<AutoRule> & { fromState: string; event: string; enabled: boolean }) => ({
  id: r.id ?? 'r-1',
  entity_type: 'work_order',
  from_state: r.fromState,
  event: r.event,
  conditions: r.conditions ?? {},
  enabled: r.enabled,
  note: null,
});

/** 触发：processing → pending_review（提交审核）。 */
const submitReview = (c: PoolClient) =>
  transition(c, TENANT, WO, 'pending_review', { actor: 'worker-1', role: 'worker' });

describe('自动审核执行器 —— 配了启用规则就真的自动推进', () => {
  it('🔴 命中启用规则 → 自动 approve，工单直接落到 review_passed', async () => {
    const { client } = mkClient(RICH_WORK_ORDER_DEF, [
      rowOf({ fromState: 'pending_review', event: 'approve', enabled: true, conditions: {} }),
    ]);
    const r = await submitReview(client);
    expect(r.row.status).toBe('review_passed');
    expect(r.autoAdvanced).toMatchObject({ event: 'approve', to: 'review_passed' });
  });

  it('留痕：自动推进额外写一条 type=auto_rule、actor=system:auto 的 ticket_event', async () => {
    const { client, calls } = mkClient(RICH_WORK_ORDER_DEF, [
      rowOf({ fromState: 'pending_review', event: 'approve', enabled: true, conditions: {} }),
    ]);
    await submitReview(client);
    const evt = calls.filter((c) => c.text.includes('INSERT INTO ticket_event'));
    // 注意：type='auto_rule' 与 actor='system:auto' 是 SQL 内联字面量（不在 params 里），
    // params 依次为 [$1 tenant_id, $2 work_order_id, $3 from_status, $4 to_status, $5 payload]
    const auto = evt.find((c) => c.text.includes("'auto_rule'"));
    expect(auto, '必须有一条 auto_rule 留痕').toBeTruthy();
    expect(auto?.text).toContain("'system:auto'"); // 可追溯：是系统按规则做的，不是某个人
    expect(String(auto?.params?.[2])).toBe('pending_review');
    expect(String(auto?.params?.[3])).toBe('review_passed');
  });

  it('规则未启用 → 停在 pending_review（建了不等于启用）', async () => {
    const { client } = mkClient(RICH_WORK_ORDER_DEF, [
      rowOf({ fromState: 'pending_review', event: 'approve', enabled: false, conditions: {} }),
    ]);
    const r = await submitReview(client);
    expect(r.row.status).toBe('pending_review');
    expect(r.autoAdvanced).toBeUndefined();
  });

  it('表为空（094 未应用 / 未配任何规则）→ 零自动行为，与改造前逐字等价', async () => {
    const { client } = mkClient(RICH_WORK_ORDER_DEF, []);
    const r = await submitReview(client);
    expect(r.row.status).toBe('pending_review');
    expect(r.autoAdvanced).toBeUndefined();
  });

  it('条件不命中（优先级不在白名单）→ 不自动，留给人工审核', async () => {
    const { client } = mkClient(RICH_WORK_ORDER_DEF, [
      rowOf({
        fromState: 'pending_review',
        event: 'approve',
        enabled: true,
        conditions: { priorityIn: ['urgent'] }, // 本单是 normal
      }),
    ]);
    const r = await submitReview(client);
    expect(r.row.status).toBe('pending_review');
    expect(r.autoAdvanced).toBeUndefined();
  });

  it('触发态不匹配（规则配在别的态）→ 不自动', async () => {
    const { client } = mkClient(RICH_WORK_ORDER_DEF, [
      rowOf({ fromState: 'assigned', event: 'approve', enabled: true, conditions: {} }),
    ]);
    const r = await submitReview(client);
    expect(r.row.status).toBe('pending_review');
  });
});

describe('红线双保险 —— 运行期数据漂移也挡得住', () => {
  it('🔴 规则指向终态 closed → 绝不自动推进（哪怕数据绕过了保存校验）', async () => {
    // 构造一条"approve 直达 closed"的脏 def，模拟保存校验被绕过的数据漂移
    const dirtyDef: WorkflowDef = {
      ...RICH_WORK_ORDER_DEF,
      states: [...RICH_WORK_ORDER_DEF.states, 'closed'],
      transitions: [
        ...RICH_WORK_ORDER_DEF.transitions.filter(
          (t) => !(t.from === 'pending_review' && t.event === 'approve'),
        ),
        { from: 'pending_review', to: 'closed', event: 'approve' },
      ],
    };
    const { client } = mkClient(dirtyDef, [
      rowOf({ fromState: 'pending_review', event: 'approve', enabled: true, conditions: {} }),
    ]);
    const r = await submitReview(client);
    expect(r.row.status).toBe('pending_review'); // 绝不能自动关单
    expect(r.autoAdvanced).toBeUndefined();
  });

  it('🔴 单级限制：自动推进产生的结果不再触发下一轮（防链式失控）', async () => {
    // 同时配两条：pending_review 自动 approve → review_passed；review_passed 也配了 approve（不存在该边，故不触发）
    const { client, calls } = mkClient(RICH_WORK_ORDER_DEF, [
      rowOf({ fromState: 'pending_review', event: 'approve', enabled: true, conditions: {} }),
      rowOf({ id: 'r-2', fromState: 'review_passed', event: 'approve', enabled: true, conditions: {} }),
    ]);
    const r = await submitReview(client);
    expect(r.row.status).toBe('review_passed'); // 只推进一级，没有继续往下串
    const autoEvents = calls.filter((c) => c.text.includes("'auto_rule'"));
    expect(autoEvents).toHaveLength(1);
  });

  it('目标边声明了 requiredFields → 不自动（系统填不出人工字段，硬推只会 422）', async () => {
    const defWithRequired: WorkflowDef = {
      ...RICH_WORK_ORDER_DEF,
      transitions: RICH_WORK_ORDER_DEF.transitions.map((t) =>
        t.from === 'pending_review' && t.event === 'approve'
          ? { ...t, requiredFields: ['approve_comment'] }
          : t,
      ),
    };
    const { client } = mkClient(defWithRequired, [
      rowOf({ fromState: 'pending_review', event: 'approve', enabled: true, conditions: {} }),
    ]);
    const r = await submitReview(client);
    expect(r.row.status).toBe('pending_review');
  });
});
