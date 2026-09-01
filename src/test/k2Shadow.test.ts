// k2Shadow.test.ts —— K2 影子模式单测（R34）
// 覆盖：余弦相似度、多数投票（含平票稳定）、影子落库、派单回填、旁路吞错。
import { describe, it, expect } from 'vitest';
import { cosineSim, majorityVote, recordShadowSuggestions, resolveDispatchShadow } from '../services/k2Shadow.js';

type RecordedCall = { sql: string; params: unknown[] };

function makeFakeClient(routes: Record<string, () => { rows: unknown[] }>) {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params: params ?? [] });
      for (const key of Object.keys(routes)) {
        if (sql.includes(key)) return routes[key]();
      }
      return { rows: [] };
    },
  } as never;
}

describe('cosineSim', () => {
  it('同向=1，正交=0', () => {
    expect(cosineSim([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it('长度不等或零向量=NaN（由调用方过滤）', () => {
    expect(Number.isNaN(cosineSim([1, 0], [1, 0, 0]))).toBe(true);
    expect(Number.isNaN(cosineSim([0, 0], [1, 0]))).toBe(true);
  });
});

describe('majorityVote', () => {
  it('常规多数票', () => {
    expect(majorityVote(['a', 'b', 'a'])).toBe('a');
  });
  it('平票取首个达到最高票者（稳定可复现）', () => {
    expect(majorityVote(['a', 'b'])).toBe('a');
    expect(majorityVote(['b', 'a'])).toBe('b');
  });
  it('全空票返回空串', () => {
    expect(majorityVote(['', ''])).toBe('');
  });
});

describe('recordShadowSuggestions', () => {
  // R15 适配：候选查询已改 LEFT JOIN work_orders（R12-F1 数据稀疏修正），
  // 候选行直接携带 assignee_id；dispatch 投票只在有派单记录的候选内进行。
  const candidates = {
    rows: [
      { ref_id: 'w1', category: '水电维修', embedding: [1, 0], assignee_id: 'wk-a' },
      { ref_id: 'w2', category: '水电维修', embedding: [0.9, 0.1], assignee_id: 'wk-a' },
      { ref_id: 'w3', category: '空调维修', embedding: [-1, 0], assignee_id: null },
    ],
  };
  // 自愈回填块查询工单当前 assignee（'SELECT assignee_id FROM work_orders'）的响应
  const currentAssignee = { rows: [{ assignee_id: 'wk-a' }] };

  it('相似单多数票落 category + dispatch 两条影子，category 当场判 matched', async () => {
    const client = makeFakeClient({
      'FROM ai_case_embeddings': () => candidates,
      'FROM work_orders': () => currentAssignee,
    });
    await recordShadowSuggestions(client, 't-verification', 'wo-1', [1, 0], '水电维修');
    const calls = (client as never as { calls: RecordedCall[] }).calls;
    const inserts = calls.filter((c) => c.sql.includes('INSERT INTO ai_shadow_suggestions'));
    expect(inserts.length).toBe(2);
    // category INSERT 参数序：[tenant, wo, suggested, actual, matched, detail]；kind 写死在 SQL
    const cat = inserts.find((c) => c.sql.includes("'category'"))!;
    expect(cat.params[2]).toBe('水电维修'); // suggested（水电 2 票 > 空调 1 票）
    expect(cat.params[3]).toBe('水电维修'); // actual=最终分类
    expect(cat.params[4]).toBe(true); // matched
    // dispatch INSERT 参数序：[tenant, wo, suggested, detail]
    const dis = inserts.find((c) => c.sql.includes("'dispatch'"))!;
    expect(dis.params[2]).toBe('wk-a'); // suggested=相似单 assignee 多数票
    // R12-F1 自愈回填：影子落库后立即查当前 assignee 并回填 actual（消时序竞态）
    const backfill = calls.find((c) => c.sql.includes("kind = 'dispatch'") && c.sql.includes('UPDATE'));
    expect(backfill).toBeDefined();
    expect(backfill!.params).toEqual(['t-verification', 'wo-1', 'wk-a']);
  });

  it('候选全无 assignee → 只落 category 行（dispatch 投票稀疏修正）', async () => {
    const client = makeFakeClient({
      'FROM ai_case_embeddings': () => ({
        rows: [
          { ref_id: 'w1', category: '水电维修', embedding: [1, 0], assignee_id: null },
          { ref_id: 'w2', category: '水电维修', embedding: [0.9, 0.1], assignee_id: null },
        ],
      }),
    });
    await recordShadowSuggestions(client, 't-verification', 'wo-1', [1, 0], '水电维修');
    const calls = (client as never as { calls: RecordedCall[] }).calls;
    const inserts = calls.filter((c) => c.sql.includes('INSERT INTO ai_shadow_suggestions'));
    expect(inserts.length).toBe(1);
    expect(inserts[0].sql).toContain("'category'");
    // 无 dispatch 行 → 也不应触发自愈回填查询
    expect(calls.some((c) => c.sql.includes("kind = 'dispatch'"))).toBe(false);
  });

  it('无相似候选 → 零影子行', async () => {
    const client = makeFakeClient({});
    await recordShadowSuggestions(client, 't-verification', 'wo-1', [1, 0], '水电维修');
    const inserts = (client as never as { calls: RecordedCall[] }).calls.filter((c) => c.sql.includes('INSERT INTO ai_shadow_suggestions'));
    expect(inserts.length).toBe(0);
  });

  it('最终分类为空 → category 影子 matched=null，不误判', async () => {
    const client = makeFakeClient({
      'FROM ai_case_embeddings': () => candidates,
      'FROM work_orders': () => ({ rows: [] }),
    });
    await recordShadowSuggestions(client, 't-verification', 'wo-1', [1, 0], '');
    const inserts = (client as never as { calls: RecordedCall[] }).calls.filter((c) => c.sql.includes('INSERT INTO ai_shadow_suggestions'));
    const cat = inserts.find((c) => c.sql.includes("'category'"))!;
    expect(cat.params[4]).toBe(null); // matched=null：最终分类未知时不误判
  });

  it('相似度≤0 的候选被过滤', async () => {
    const client = makeFakeClient({
      'FROM ai_case_embeddings': () => ({ rows: [{ ref_id: 'w3', category: '空调维修', embedding: [-1, 0] }] }),
      'FROM work_orders': () => ({ rows: [] }),
    });
    await recordShadowSuggestions(client, 't-verification', 'wo-1', [1, 0], '水电维修');
    const inserts = (client as never as { calls: RecordedCall[] }).calls.filter((c) => c.sql.includes('INSERT INTO ai_shadow_suggestions'));
    expect(inserts.length).toBe(0);
  });
});

describe('resolveDispatchShadow', () => {
  it('回填 actual + matched + resolved_at，仅命中未决 dispatch 行', async () => {
    const client = makeFakeClient({});
    await resolveDispatchShadow(client, 't-verification', 'wo-1', 'wk-b');
    const calls = (client as never as { calls: RecordedCall[] }).calls;
    expect(calls.length).toBe(1);
    expect(calls[0].sql).toContain("kind = 'dispatch'");
    expect(calls[0].sql).toContain('resolved_at IS NULL');
    expect(calls[0].params).toEqual(['t-verification', 'wo-1', 'wk-b']);
  });

  it('影子回填失败吞错仅告警——绝不影响主链路事务', async () => {
    const bomb = {
      calls: [] as RecordedCall[],
      async query() {
        throw new Error('shadow table missing');
      },
    } as never;
    await expect(resolveDispatchShadow(bomb, 't-verification', 'wo-1', 'wk-b')).resolves.toBeUndefined();
  });
});
