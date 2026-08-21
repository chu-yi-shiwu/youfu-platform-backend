// 批次 C 单测：聚焦纯函数 + 真实链路用例（防批次 A 式"假绿"）。
// 不依赖真实 PG：纯函数直接测；ticketStats 用 mock client 走真实调用路径。
import { describe, it, expect, beforeEach } from 'vitest';
import { applyStockAction } from '../services/inventory.js';
import { buildServiceDeskTicket } from '../services/serviceDeskTicket.js';
import { summarizeLinkedOrders } from '../services/assetHistory.js';
import { ticketStats, clearStatsCache } from '../repo/stats.js';
import type { PoolClient } from 'pg';

describe('applyStockAction（库存动作）', () => {
  it('入库 +50', () => {
    expect(applyStockAction(10, { type: 'in', qty: 50 })).toEqual({ next: 60, ok: true });
  });
  it('调整置数为 99', () => {
    expect(applyStockAction(10, { type: 'adjust', qty: 99 })).toEqual({ next: 99, ok: true });
  });
  it('出库 30（库存充足）', () => {
    expect(applyStockAction(50, { type: 'out', qty: 30 })).toEqual({ next: 20, ok: true });
  });
  it('出库不足返回 ok:false', () => {
    expect(applyStockAction(10, { type: 'out', qty: 30 })).toEqual({ next: 10, ok: false });
  });
});

describe('buildServiceDeskTicket（来电弹屏映射）', () => {
  it('catalog 映射为 business_type，无误则无幂等键', () => {
    const dto = buildServiceDeskTicket({
      tenantId: 't1',
      deskId: 'd1',
      callerName: '张三',
      catalog: 'repair',
      description: '灯不亮',
    });
    expect(dto.businessType).toBe('repair');
    expect(dto.catalog).toBe('repair');
    expect(dto.idempotencyKey).toBeUndefined();
    expect(dto.title).toContain('张三');
  });
  it('sessionId 存在才生成幂等键防双击', () => {
    const dto = buildServiceDeskTicket({
      tenantId: 't1',
      deskId: 'd1',
      callerName: '李四',
      catalog: 'transport',
      description: '送检',
      sessionId: 's-abc',
    });
    expect(dto.idempotencyKey).toBe('svcdesk:d1:s-abc');
  });
});

describe('summarizeLinkedOrders（资产历史只读聚合）', () => {
  it('空数组返回空', () => {
    expect(summarizeLinkedOrders([])).toEqual([]);
  });
  it('多行映射保留关键字段', () => {
    const rows = [
      { id: 'a', order_no: 'WO-1', business_type: 'repair', status: 'assigned', created_at: '2026-01-01' },
      { id: 'b', order_no: 'WO-2', business_type: 'repair', status: 'completed', created_at: '2026-01-02' },
    ];
    const out = summarizeLinkedOrders(rows);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ order_id: 'a', order_no: 'WO-1', business_type: 'repair', status: 'assigned', created_at: '2026-01-01' });
  });
});

describe('ticketStats（真实链路 · mock client）', () => {
  // 构造 mock client，走真实 ticketStats 调用路径（非内存构造返回值）
  const mockClient = {
    query: async () => ({
      rows: [{ total: '10', completed: '5', auto_dispatched: '8', auto_closed: '4' }],
    }),
  } as unknown as PoolClient;

  it('返回 7 字段且自动派单率计算正确', async () => {
    const s = await ticketStats(mockClient, 't1');
    expect(s.tenant_id).toBe('t1');
    expect(s.total).toBe(10);
    expect(s.completed).toBe(5);
    expect(s.auto_dispatched).toBe(8);
    expect(s.auto_closed).toBe(4);
    expect(s.auto_dispatch_rate).toBe(0.8); // 8/10
    expect(s.auto_close_rate).toBe(0.4); // 4/10
    expect(typeof s.note).toBe('string');
  });

  it('总数为 0 时比率安全置 0', async () => {
    clearStatsCache(); // 隔离：避免命中前序用例的全局 30s 统计缓存（mock client 不写缓存）
    const emptyClient = { query: async () => ({ rows: [{ total: '0', completed: '0', auto_dispatched: '0', auto_closed: '0' }] }) } as unknown as PoolClient;
    const s = await ticketStats(emptyClient, 't1');
    expect(s.auto_dispatch_rate).toBe(0);
    expect(s.auto_close_rate).toBe(0);
  });
});
