// 库存动作纯函数（批次 C · 仓库物资）：不依赖 DB，便于单测。
// 真实扣减的事务正确性（防超卖）由 routes/material.ts 的 SELECT ... FOR UPDATE 保证。
export type StockAction = { type: 'in' | 'out' | 'adjust'; qty: number };

export function applyStockAction(
  currentQty: number,
  action: StockAction,
): { next: number; ok: boolean } {
  if (action.type === 'in') return { next: currentQty + action.qty, ok: true };
  if (action.type === 'adjust') return { next: action.qty, ok: true }; // adjust 直接置数
  // out：出库
  if (currentQty < action.qty) return { next: currentQty, ok: false }; // 不足，拒绝
  return { next: currentQty - action.qty, ok: true };
}
