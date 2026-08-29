// 库存动作纯函数（批次 C · 仓库物资）：不依赖 DB，便于单测。
// 真实扣减的事务正确性（防超卖）由 routes/material.ts 的 SELECT ... FOR UPDATE 保证。
export type StockAction = { type: 'in' | 'out' | 'adjust'; qty: number };

export function applyStockAction(
  currentQty: number,
  action: StockAction,
): { next: number; ok: boolean } {
  // 防御：数量非有限数一律拒绝（防 NaN/Infinity 误入库存）
  if (!Number.isFinite(action.qty)) return { next: currentQty, ok: false };
  if (action.type === 'in') {
    // in 数量须为正，非正拒绝（防误调用导致库存异常）
    if (action.qty <= 0) return { next: currentQty, ok: false };
    return { next: currentQty + action.qty, ok: true };
  }
  if (action.type === 'adjust') return { next: action.qty, ok: true }; // adjust 直接置数（允许置 0）
  // out：出库，数量须为正且不得超当前库存
  if (action.qty <= 0) return { next: currentQty, ok: false }; // 非正出库无意义，拒绝
  if (currentQty < action.qty) return { next: currentQty, ok: false }; // 不足，拒绝
  return { next: currentQty - action.qty, ok: true };
}
