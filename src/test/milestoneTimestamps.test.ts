// 074 生命周期里程碑时间列单测（2026-09-06 任务④）
// 覆盖：stateMachine 纯函数映射、RICH 模板新增 arrived 态流转、
//       transition() 按目标状态回填里程碑列（fake client 捕获 UPDATE SQL 断言）。
import { describe, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import {
  RICH_WORK_ORDER_DEF,
  DEFAULT_WORK_ORDER_DEF,
  STATUS_TIMESTAMP_COLUMNS,
  timestampColumnFor,
  canTransition,
} from '../engine/stateMachine.js';
import { transition } from '../repo/ticket.js';

describe('STATUS_TIMESTAMP_COLUMNS（单一事实源映射）', () => {
  it('六状态→六里程碑列一一对应', () => {
    expect(timestampColumnFor('pending_accept')).toBe('accepted_at');
    expect(timestampColumnFor('assigned')).toBe('assigned_at');
    expect(timestampColumnFor('arrived')).toBe('arrived_at');
    expect(timestampColumnFor('processing')).toBe('started_at');
    expect(timestampColumnFor('completed')).toBe('completed_at');
    expect(timestampColumnFor('evaluated')).toBe('rated_at');
  });
  it('非里程碑状态返回 undefined（不回填）', () => {
    for (const s of ['draft', 'pending_dispatch', 'claim_hall', 'paused', 'suspended', 'pending_review', 'review_passed', 'closed', 'cancelled', 'bogus']) {
      expect(timestampColumnFor(s)).toBeUndefined();
    }
  });
  it('映射键全部是合法列名（防注入护栏：值仅允许小写下划线）', () => {
    for (const col of Object.values(STATUS_TIMESTAMP_COLUMNS)) {
      expect(col).toMatch(/^[a-z_]+$/);
    }
  });
});

describe('RICH 模板新增 arrived 态（074）', () => {
  const rich = RICH_WORK_ORDER_DEF;
  it('states 含 arrived（在 assigned 与 processing 之间）', () => {
    expect(rich.states).toContain('arrived');
    expect(rich.states.indexOf('assigned')).toBeLessThan(rich.states.indexOf('arrived'));
    expect(rich.states.indexOf('arrived')).toBeLessThan(rich.states.indexOf('processing'));
  });
  it('assigned --arrive--> arrived --start--> processing 新链路合法', () => {
    expect(canTransition(rich, 'assigned', 'arrived')).toBe(true);
    expect(canTransition(rich, 'arrived', 'processing')).toBe(true);
  });
  it('旧边保留：assigned --receive--> processing 兼容路径不断（旧客户端不门死）', () => {
    expect(canTransition(rich, 'assigned', 'processing')).toBe(true);
    const receive = rich.transitions.find((t) => t.from === 'assigned' && t.event === 'receive');
    expect(receive?.to).toBe('processing');
  });
  it('arrive/start 角色门禁为 admin+worker；arrived 有 cancel 逃逸边', () => {
    const arrive = rich.transitions.find((t) => t.from === 'assigned' && t.event === 'arrive');
    const start = rich.transitions.find((t) => t.from === 'arrived' && t.event === 'start');
    expect(arrive?.allowedRoles).toEqual(['admin', 'worker']);
    expect(start?.allowedRoles).toEqual(['admin', 'worker']);
    const cancel = rich.transitions.find((t) => t.from === 'arrived' && t.event === 'cancel');
    expect(cancel?.to).toBe('cancelled');
    expect(cancel?.requiredFields).toContain('cancel_reason');
  });
  it('arrive 无必填字段（不阻塞既有流转）', () => {
    const arrive = rich.transitions.find((t) => t.from === 'assigned' && t.event === 'arrive');
    expect(arrive?.requiredFields).toBeUndefined();
  });
  it('DEFAULT 模板不受影响（无 arrived，旧 4 态原样）', () => {
    expect(DEFAULT_WORK_ORDER_DEF.states).not.toContain('arrived');
    expect(canTransition(DEFAULT_WORK_ORDER_DEF, 'draft', 'assigned')).toBe(true);
    expect(canTransition(DEFAULT_WORK_ORDER_DEF, 'assigned', 'processing')).toBe(true);
  });
});

// ── transition() 回填断言（fake client 捕获 UPDATE SQL）──
// 说明：RICH def 存于 workflow_def 表，fake client 按 SQL 片段路由返回；
//       流转选取避开 assignee 增减（cur.assignee_id 固定），避免牵动 load/影子回填旁路。
function fakeClient(cur: Record<string, unknown>) {
  const captured: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      captured.push({ sql, params });
      if (sql.includes('FOR UPDATE')) return { rows: [cur], rowCount: 1 };
      if (sql.includes('FROM workflow_def')) {
        return { rows: [{ def: JSON.parse(JSON.stringify(RICH_WORK_ORDER_DEF)) }], rowCount: 1 };
      }
      if (sql.trimStart().toUpperCase().startsWith('UPDATE WORK_ORDERS')) {
        return { rows: [{ ...cur }], rowCount: 1 };
      }
      // ticket_event / domain_event INSERT 等一律吞掉
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;
  return { client, captured };
}

function lastUpdateSql(captured: Array<{ sql: string; params: unknown[] }>): string {
  const hits = captured.filter((c) => c.sql.trimStart().toUpperCase().startsWith('UPDATE WORK_ORDERS'));
  expect(hits.length).toBeGreaterThan(0);
  return hits[hits.length - 1].sql;
}

describe('transition() 里程碑列回填', () => {
  it('draft→pending_accept（submit）：回填 accepted_at', async () => {
    const { client, captured } = fakeClient({ id: 'wo1', tenant_id: 't1', status: 'draft', assignee_id: null });
    await transition(client, 't1', 'wo1', 'pending_accept', { actor: 'front_desk', role: 'admin' });
    expect(lastUpdateSql(captured)).toContain('accepted_at = now()');
  });

  it('pending_accept→pending_dispatch（accept）：非里程碑态，不回填任何里程碑列', async () => {
    const { client, captured } = fakeClient({ id: 'wo1', tenant_id: 't1', status: 'pending_accept', assignee_id: null });
    await transition(client, 't1', 'wo1', 'pending_dispatch', { actor: 'front_desk', role: 'admin' });
    const sql = lastUpdateSql(captured);
    expect(sql).not.toContain('accepted_at');
    expect(sql).not.toContain('assigned_at');
    expect(sql).not.toContain('arrived_at');
    expect(sql).not.toContain('started_at');
    expect(sql).not.toContain('completed_at');
    expect(sql).not.toContain('rated_at');
  });

  it('assigned→arrived（arrive，worker）：回填 arrived_at', async () => {
    const { client, captured } = fakeClient({ id: 'wo1', tenant_id: 't1', status: 'assigned', assignee_id: 'w1' });
    await transition(client, 't1', 'wo1', 'arrived', { actor: 'w1', role: 'worker' });
    expect(lastUpdateSql(captured)).toContain('arrived_at = now()');
  });

  it('arrived→processing（start，worker）：回填 started_at', async () => {
    const { client, captured } = fakeClient({ id: 'wo1', tenant_id: 't1', status: 'arrived', assignee_id: 'w1' });
    await transition(client, 't1', 'wo1', 'processing', { actor: 'w1', role: 'worker' });
    expect(lastUpdateSql(captured)).toContain('started_at = now()');
  });

  it('processing→completed（complete）：回填 completed_at', async () => {
    const { client, captured } = fakeClient({ id: 'wo1', tenant_id: 't1', status: 'processing', assignee_id: 'w1' });
    await transition(client, 't1', 'wo1', 'completed', { actor: 'w1', role: 'worker' });
    expect(lastUpdateSql(captured)).toContain('completed_at = now()');
  });

  it('closed→evaluated（satisfy，需 satisfaction_score）：回填 rated_at', async () => {
    const { client, captured } = fakeClient({ id: 'wo1', tenant_id: 't1', status: 'closed', assignee_id: null });
    await transition(client, 't1', 'wo1', 'evaluated', { actor: 'reporter', fields: { satisfaction_score: 5 } });
    expect(lastUpdateSql(captured)).toContain('rated_at = now()');
  });

  it('assigned→processing（receive 旧边）：回填 started_at（兼容路径同样打点）', async () => {
    const { client, captured } = fakeClient({ id: 'wo1', tenant_id: 't1', status: 'assigned', assignee_id: 'w1' });
    await transition(client, 't1', 'wo1', 'processing', { actor: 'w1', role: 'worker' });
    expect(lastUpdateSql(captured)).toContain('started_at = now()');
  });
});
