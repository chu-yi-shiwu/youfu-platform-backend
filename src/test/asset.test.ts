// 生产化② 资产台账 DB 化：覆盖 parseScanCode + resolveScanFromDb（注入假 queryFn，不连真库）。
import { describe, it, expect } from 'vitest';
import { parseScanCode, resolveScanFromDb, type AssetQueryFn } from '../scan.js';

describe('parseScanCode（纯函数）', () => {
  it('CAT- 前缀 → catalog + 大写 key', () => {
    expect(parseScanCode('cat-ELECTRICIAN')).toEqual({ kind: 'catalog', key: 'ELECTRICIAN' });
  });
  it('AST- 前缀（小写输入）→ asset + 大写 key', () => {
    expect(parseScanCode('ast-3f-aircon-01')).toEqual({ kind: 'asset', key: '3F-AIRCON-01' });
  });
  it('空串 / 空格 → null', () => {
    expect(parseScanCode('')).toBeNull();
    expect(parseScanCode('   ')).toBeNull();
  });
  it('非 CAT-/AST- 前缀 → null（不臆造）', () => {
    expect(parseScanCode('QR-XYZ-123')).toBeNull();
    expect(parseScanCode('随便输的')).toBeNull();
  });
});

describe('resolveScanFromDb（DB 权威）', () => {
  const T = 't-verification';

  it('目录命中 → resolved，catalog 小写、template 推导', async () => {
    const qf: AssetQueryFn = async () => ({ label: '电工维修', skill_tags: ['electric'] });
    const r = await resolveScanFromDb(T, 'CAT-ELECTRICIAN', qf);
    expect(r.asset.resolved).toBe(true);
    expect(r.asset.kind).toBe('catalog');
    expect(r.asset.catalog).toBe('electrician');
    expect(r.asset.label).toBe('电工维修');
    expect(r.suggested?.template).toBe('repair');
  });

  it('资产命中 → resolved，关联目录小写 + template', async () => {
    const qf: AssetQueryFn = async () => ({
      label: '3F-空调-01',
      catalog_code: 'ELECTRICIAN',
      skill_tags: ['electric'],
    });
    const r = await resolveScanFromDb(T, 'AST-3F-AIRCON-01', qf);
    expect(r.asset.resolved).toBe(true);
    expect(r.asset.kind).toBe('asset');
    expect(r.asset.catalog).toBe('electrician');
    expect(r.asset.label).toBe('3F-空调-01');
    expect(r.suggested?.template).toBe('repair');
  });

  it('目录未登记 → 诚实 unresolved（DB 权威，不回退本地）', async () => {
    const qf: AssetQueryFn = async () => undefined;
    const r = await resolveScanFromDb(T, 'CAT-ghost', qf);
    expect(r.asset.resolved).toBe(false);
    expect(r.asset.note).toContain('未知目录码');
  });

  it('资产未登记 → 诚实 unresolved', async () => {
    const qf: AssetQueryFn = async () => undefined;
    const r = await resolveScanFromDb(T, 'AST-NOPE-99', qf);
    expect(r.asset.resolved).toBe(false);
    expect(r.asset.note).toContain('资产台账未登记');
  });

  it('非前缀/空串 → 直接降级，不调用 DB 查询', async () => {
    const qf: AssetQueryFn = async () => {
      throw new Error('不应被调用');
    };
    expect((await resolveScanFromDb(T, 'QR-XYZ-123', qf)).asset.resolved).toBe(false);
    expect((await resolveScanFromDb(T, '', qf)).asset.resolved).toBe(false);
  });
});
