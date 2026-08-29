// 库存动作纯函数单测（不依赖 DB）：锁定 applyStockAction 的边界行为，防回归。
// R23-002 防御：入库/出库数量非正或非有限数一律拒绝。
import { describe, it, expect } from 'vitest';
import { applyStockAction } from '../services/inventory.js';

describe('applyStockAction', () => {
  it('in 正常累加', () => {
    expect(applyStockAction(10, { type: 'in', qty: 5 })).toEqual({ next: 15, ok: true });
  });

  it('in 数量为 0 或负 → 拒绝（防误调用）', () => {
    expect(applyStockAction(10, { type: 'in', qty: 0 }).ok).toBe(false);
    expect(applyStockAction(10, { type: 'in', qty: -3 }).ok).toBe(false);
  });

  it('out 正常扣减', () => {
    expect(applyStockAction(10, { type: 'out', qty: 4 })).toEqual({ next: 6, ok: true });
  });

  it('out 超库存 → 拒绝且不改变', () => {
    expect(applyStockAction(3, { type: 'out', qty: 5 })).toEqual({ next: 3, ok: false });
  });

  it('out 数量为 0 或负 → 拒绝（关键：负出库会静默加库存）', () => {
    expect(applyStockAction(10, { type: 'out', qty: 0 }).ok).toBe(false);
    expect(applyStockAction(10, { type: 'out', qty: -2 }).ok).toBe(false);
  });

  it('adjust 直接置数（允许置 0）', () => {
    expect(applyStockAction(10, { type: 'adjust', qty: 0 })).toEqual({ next: 0, ok: true });
    expect(applyStockAction(10, { type: 'adjust', qty: 7 })).toEqual({ next: 7, ok: true });
  });

  it('数量非有限数（NaN/Infinity）→ 拒绝', () => {
    expect(applyStockAction(10, { type: 'in', qty: NaN }).ok).toBe(false);
    expect(applyStockAction(10, { type: 'out', qty: Infinity }).ok).toBe(false);
  });
});
