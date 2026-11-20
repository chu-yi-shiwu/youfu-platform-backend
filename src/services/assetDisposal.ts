// 处置撤销业务规则（2026-11-20）
// 设计原则：disposed 仍是终态；撤销是“审批后的冲销”，不是把终态改成可编辑状态。
export const DISPOSAL_REVERSAL_WINDOW_DAYS = 30;

export interface DisposalAssetSnapshot {
  status: string;
  disposed_at?: string | Date | null;
  dispose_method?: string | null;
  disposal_reversed_at?: string | Date | null;
}

export interface ReversalDecision {
  ok: boolean;
  code?: string;
  message?: string;
  days_since_dispose?: number;
}

const REVERSIBLE_METHODS = new Set(['', '报废', '回收']);

/**
 * 允许撤销的条件：
 *  - 资产确为已处置，且未撤销过；
 *  - 处置方式不是变卖/捐赠（已流入外部，不能凭空回到台账）；
 *  - 在 30 天撤销窗口内。
 * 变卖/捐赠如确需回滚，必须走线下资产回购/受赠流程重新建档，不在此接口放开。
 */
export function evaluateDisposalReversal(
  asset: DisposalAssetSnapshot,
  now: Date = new Date(),
  windowDays: number = DISPOSAL_REVERSAL_WINDOW_DAYS,
): ReversalDecision {
  if (asset.status !== 'disposed') {
    return { ok: false, code: 'NOT_DISPOSED', message: '资产当前不是已处置状态' };
  }
  if (asset.disposal_reversed_at) {
    return { ok: false, code: 'ALREADY_REVERSED', message: '该处置已撤销过' };
  }
  if (!asset.disposed_at) {
    return { ok: false, code: 'NO_DISPOSE_TIME', message: '缺少处置时间，无法判断撤销窗口' };
  }
  const disposedAt = new Date(asset.disposed_at);
  if (Number.isNaN(disposedAt.getTime())) {
    return { ok: false, code: 'BAD_DISPOSE_TIME', message: '处置时间格式异常' };
  }
  const days = Math.floor((now.getTime() - disposedAt.getTime()) / 86400000);
  if (days < 0) {
    return { ok: false, code: 'BAD_DISPOSE_TIME', message: '处置时间晚于当前时间' };
  }
  if (days > windowDays) {
    return {
      ok: false,
      code: 'WINDOW_EXPIRED',
      message: `已超过 ${windowDays} 天撤销窗口（已处置 ${days} 天）`,
      days_since_dispose: days,
    };
  }
  const method = (asset.dispose_method ?? '').trim();
  if (!REVERSIBLE_METHODS.has(method)) {
    return {
      ok: false,
      code: 'NON_REVERSIBLE_METHOD',
      message: `处置方式为「${method}」，资产已流出，不能直接撤销`,
      days_since_dispose: days,
    };
  }
  return { ok: true, days_since_dispose: days };
}
