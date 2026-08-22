// 报修补全逻辑单测（DMR：最小输入 → 最全工单）
import { describe, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import { matchCategoryHint, resolveFaultCategory, inferPriority, resolveAsset } from '../services/intakeEnrich.js';

function fakeClient(rowsBySql: (sql: string, params: unknown[]) => { rows: any[]; rowCount: number }): PoolClient {
  return { query: async (sql: string, params: unknown[] = []) => rowsBySql(sql, params) } as unknown as PoolClient;
}

describe('matchCategoryHint', () => {
  it('命中空调关键词', () => expect(matchCategoryHint('空调漏水')).toBe('空调'));
  it('命中网络关键词（大小写不敏感）', () => expect(matchCategoryHint('WiFi断了')).toBe('网络'));
  it('无命中返回 undefined', () => expect(matchCategoryHint('今天天气真好')).toBeUndefined());
});

describe('inferPriority', () => {
  it('漏水 → 紧急', () => expect(inferPriority('空调漏水')).toBe('urgent'));
  it('断电 → 紧急', () => expect(inferPriority('办公室断电了')).toBe('urgent'));
  it('普通描述 → 普通', () => expect(inferPriority('灯不亮')).toBe('normal'));
});

describe('resolveFaultCategory', () => {
  const cats = [
    { id: 'c1', name: '空调维修' },
    { id: 'c2', name: '水电检修' },
  ];
  const client = fakeClient((sql, params) => {
    if (params.length === 1) return { rows: cats, rowCount: cats.length }; // 全量分类
    return { rows: [{ id: 'c2', name: '水电检修' }], rowCount: 1 }; // hint 模糊匹配
  });

  it('精确匹配分类名', async () => {
    const r = await resolveFaultCategory(client, 't1', '空调维修坏了');
    expect(r?.id).toBe('c1');
  });
  it('关键词 hint 模糊匹配分类名', async () => {
    const r = await resolveFaultCategory(client, 't1', '空调漏水严重');
    expect(r?.id).toBe('c2');
  });
  it('无匹配返回 null', async () => {
    const empty = fakeClient(() => ({ rows: [], rowCount: 0 }));
    const r = await resolveFaultCategory(empty, 't1', '今天心情不错');
    expect(r).toBeNull();
  });
});

describe('resolveAsset', () => {
  it('命中资产名 → 返回资产', async () => {
    const client = fakeClient(() => ({ rows: [{ id: 'a1', name: '3号楼中央空调' }], rowCount: 1 }));
    const r = await resolveAsset(client, 't1', '3号楼中央空调不制冷');
    expect(r?.id).toBe('a1');
  });
  it('无 hint 关键词 → 不查库返回 null', async () => {
    let called = false;
    const client = fakeClient(() => { called = true; return { rows: [], rowCount: 0 }; });
    const r = await resolveAsset(client, 't1', '今天心情不错');
    expect(r).toBeNull();
    expect(called).toBe(false); // 无 hint 不应触发查询（限制扫描面）
  });
});
