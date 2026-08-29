// M3 扫码解析单测：覆盖 CAT-/AST-/未知 三类分支 + 大小写/空格容错。
import { describe, it, expect } from 'vitest';
import { resolveScan } from '../scan.js';

describe('resolveScan', () => {
  it('解析目录码 CAT-electrician（大小写容错）', () => {
    const r = resolveScan('cat-ELECTRICIAN');
    expect(r.asset.resolved).toBe(true);
    expect(r.asset.kind).toBe('catalog');
    expect(r.asset.catalog).toBe('electrician');
    expect(r.asset.label).toBe('电工维修');
    expect(r.suggested?.template).toBe('repair');
  });

  it('解析资产码 AST-3F-AIRCON-01 并关联目录', () => {
    const r = resolveScan('AST-3F-AIRCON-01');
    expect(r.asset.resolved).toBe(true);
    expect(r.asset.kind).toBe('asset');
    expect(r.asset.catalog).toBe('electrician');
    expect(r.asset.label).toBe('3F-空调-01');
    expect(r.asset.skill_tags).toContain('electric');
  });

  it('未知目录码 -> 诚实 unresolved', () => {
    const r = resolveScan('CAT-ghost');
    expect(r.asset.resolved).toBe(false);
    expect(r.asset.note).toContain('未知目录码');
  });

  it('资产台账未登记 -> 诚实 unresolved', () => {
    const r = resolveScan('AST-NOPE-99');
    expect(r.asset.resolved).toBe(false);
    expect(r.asset.note).toContain('资产台账未登记');
  });

  it('空格容错 + 完全无法识别 -> unresolved', () => {
    expect(resolveScan('  随便输的  ').asset.resolved).toBe(false);
    expect(resolveScan('  CAT-electrician ').asset.catalog).toBe('electrician');
  });

  it('空码 -> unresolved', () => {
    expect(resolveScan('').asset.resolved).toBe(false);
    expect(resolveScan('   ').asset.resolved).toBe(false);
  });

  it('非 CAT/AST 前缀不臆造 -> unresolved', () => {
    const r = resolveScan('QR-XYZ-123');
    expect(r.asset.resolved).toBe(false);
    expect(r.asset.note).toContain('未识别');
  });
});
