// 资产运营规则纯函数测试（2026-11-20）：处置撤销、流程预检、上传类型策略。
import { describe, it, expect } from 'vitest';
import { evaluateDisposalReversal, DISPOSAL_REVERSAL_WINDOW_DAYS } from '../services/assetDisposal.js';
import { analyzeWorkflowReadiness } from '../services/assetWorkflowReadiness.js';
import { resolveUploadExt, mimeForUploadExt } from '../services/uploadPolicy.js';

const now = new Date('2026-11-20T12:00:00Z');

describe('evaluateDisposalReversal', () => {
  it('窗口内 + 报废/回收/未填方式 → 允许', () => {
    for (const method of ['报废', '回收', null]) {
      const r = evaluateDisposalReversal({ status: 'disposed', disposed_at: '2026-11-10T00:00:00Z', dispose_method: method }, now);
      expect(r.ok).toBe(true);
    }
  });

  it('超过 30 天 → WINDOW_EXPIRED', () => {
    const r = evaluateDisposalReversal({ status: 'disposed', disposed_at: '2026-10-01T00:00:00Z', dispose_method: '报废' }, now);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('WINDOW_EXPIRED');
    expect(DISPOSAL_REVERSAL_WINDOW_DAYS).toBe(30);
  });

  it('变卖/捐赠 → NON_REVERSIBLE_METHOD', () => {
    for (const method of ['变卖', '捐赠']) {
      const r = evaluateDisposalReversal({ status: 'disposed', disposed_at: '2026-11-10T00:00:00Z', dispose_method: method }, now);
      expect(r.ok).toBe(false);
      expect(r.code).toBe('NON_REVERSIBLE_METHOD');
    }
  });

  it('非已处置 / 已撤销过 → 拒绝', () => {
    expect(evaluateDisposalReversal({ status: 'in_use' }, now).code).toBe('NOT_DISPOSED');
    expect(evaluateDisposalReversal({
      status: 'disposed', disposed_at: '2026-11-10T00:00:00Z', disposal_reversed_at: '2026-11-11T00:00:00Z',
    }, now).code).toBe('ALREADY_REVERSED');
  });
});

describe('analyzeWorkflowReadiness', () => {
  const done = { doneStates: ['completed'] };

  it('pilot 型（processing 可取消/完成）→ ok', () => {
    const r = analyzeWorkflowReadiness({
      initial: 'draft',
      states: ['draft', 'assigned', 'processing', 'cancelled', 'completed'],
      transitions: [
        { from: 'draft', to: 'assigned', event: 'assign' },
        { from: 'assigned', to: 'processing', event: 'start' },
        { from: 'processing', to: 'completed', event: 'complete' },
        { from: 'processing', to: 'cancelled', event: 'cancel' },
      ],
      config: done,
    });
    expect(r.ok).toBe(true);
    expect(r.cancel_from).toEqual(['processing']);
    expect(r.done_from).toContain('processing->completed');
  });

  it('主站型（draft/arrived 可取消）→ ok', () => {
    const r = analyzeWorkflowReadiness({
      initial: 'draft',
      states: ['draft', 'pending_dispatch', 'assigned', 'arrived', 'pending_review', 'completed', 'cancelled'],
      transitions: [
        { from: 'draft', to: 'pending_dispatch', event: 'submit' },
        { from: 'pending_dispatch', to: 'assigned', event: 'assign' },
        { from: 'assigned', to: 'arrived', event: 'arrive' },
        { from: 'arrived', to: 'pending_review', event: 'resolve' },
        { from: 'pending_review', to: 'completed', event: 'close' },
        { from: 'draft', to: 'cancelled', event: 'cancel' },
        { from: 'arrived', to: 'cancelled', event: 'cancel' },
      ],
      config: done,
    });
    expect(r.ok).toBe(true);
    expect(r.cancel_from).toEqual(['draft', 'arrived']);
  });

  it('取消边存在但不可达 → NO_CANCEL_PATH（防“配置写了但业务走不到”）', () => {
    const r = analyzeWorkflowReadiness({
      initial: 'draft',
      states: ['draft', 'assigned', 'completed', 'cancelled', 'orphan'],
      transitions: [
        { from: 'draft', to: 'assigned', event: 'assign' },
        { from: 'assigned', to: 'completed', event: 'complete' },
        { from: 'orphan', to: 'cancelled', event: 'cancel' },
      ],
      config: done,
    });
    expect(r.ok).toBe(false);
    expect(r.cancel_from).toEqual([]);
    expect(r.issues.some((x) => x.code === 'NO_CANCEL_PATH')).toBe(true);
  });
});

describe('uploadPolicy', () => {
  it('非法扩展名不能靠 contentType 绕过', () => {
    expect(resolveUploadExt('evil.exe', 'image/jpeg')).toBeNull();
    expect(resolveUploadExt('a.svg', 'image/svg+xml')).toBeNull();
  });

  it('合法扩展名与无扩展名回退', () => {
    expect(resolveUploadExt('a.PDF', 'application/octet-stream')).toBe('pdf');
    expect(resolveUploadExt('', 'image/png')).toBe('png');
    expect(mimeForUploadExt('pdf')).toBe('application/pdf');
  });
});
