// T-C / C1 自适应优化层纯函数单测（脱离 PG）。
import { describe, it, expect } from 'vitest';
import { generateOptimizations, applyDispatchOptimizations, type OptimizationDecision } from '../services/optimizer.js';
import type { ProcessMetrics } from '../repo/stats.js';

const baseMetrics: ProcessMetrics = {
  tenant_id: 't',
  total: 10,
  dispatch_hit_rate: 1,
  reassign_rate: 0,
  sla_rate: 1,
  sla_note: '',
  duration_buckets: { lt_1h: 0, h1_4: 0, h4_24: 0, gt_24h: 0 },
  bottleneck: [],
};

describe('generateOptimizations - dispatch', () => {
  it('把模型臂权重转为 dispatch_rule 写回决策（保持 T-A 下限 0.1）', () => {
    const model = {
      arms: { 'electric::w-1': { weight: 0.6, pulls: 3 }, 'water::w-2': { weight: -0.5, pulls: 2 } },
      alpha: 0.2,
      ucbC: 1.5,
      version: 2,
    };
    const dec = generateOptimizations(model, baseMetrics);
    const dispatch = dec.filter((d: OptimizationDecision) => d.scope === 'dispatch');
    expect(dispatch).toHaveLength(2);
    const electric = dispatch.find((d) => d.target === 'dispatch_rule:business_type=electric');
    expect(electric?.recommendation.new_weight).toBe(0.6);
    const water = dispatch.find((d) => d.target === 'dispatch_rule:business_type=water');
    // 负权重被下限 0.1 夹住，避免规则权塌到 0
    expect(water?.recommendation.new_weight).toBe(0.1);
  });

  it('无模型参数时不产生 dispatch 决策', () => {
    const dec = generateOptimizations(null, baseMetrics);
    expect(dec.filter((d) => d.scope === 'dispatch')).toHaveLength(0);
  });
});

describe('generateOptimizations - workflow', () => {
  it('转派率>0.3 产生复核闸门建议', () => {
    const dec = generateOptimizations(null, { ...baseMetrics, reassign_rate: 0.5 });
    const wf = dec.filter((d) => d.scope === 'workflow' && d.target === 'work_order:recheck_gate');
    expect(wf).toHaveLength(1);
  });

  it('SLA 达成率<0.8 产生收紧建议', () => {
    const dec = generateOptimizations(null, { ...baseMetrics, sla_rate: 0.5 });
    const wf = dec.filter((d) => d.scope === 'workflow' && d.target === 'work_order:sla_tighten');
    expect(wf).toHaveLength(1);
  });

  it('瓶颈模块活跃>=3 产生自动升级建议', () => {
    const dec = generateOptimizations(null, {
      ...baseMetrics,
      bottleneck: [{ entity_type: 'work_order', active: 5 }],
    });
    const wf = dec.filter((d) => d.scope === 'workflow' && d.target === 'work_order:auto_escalate');
    expect(wf).toHaveLength(1);
  });

  it('健康度量不产生 workflow 建议', () => {
    const dec = generateOptimizations(null, baseMetrics);
    expect(dec.filter((d) => d.scope === 'workflow')).toHaveLength(0);
  });
});

describe('applyDispatchOptimizations - 审计状态', () => {
  function fakeClient(rowCount: number) {
    const inserted: any[] = [];
    return {
      inserted,
      query: async (sql: string, params?: any[]) => {
        if (sql.trim().startsWith('UPDATE')) return { rowCount };
        if (sql.trim().startsWith('INSERT')) { inserted.push(params); return { rowCount: 1 }; }
        return { rowCount: 0 };
      },
    } as any;
  }

  it('规则存在时写回 applied 审计', async () => {
    const client = fakeClient(1);
    const dec = generateOptimizations(
      { arms: { 'electric::w-1': { weight: 0.6, pulls: 3 } }, alpha: 0.2, ucbC: 1.5, version: 2 },
      baseMetrics,
    ).filter((d) => d.scope === 'dispatch');
    await applyDispatchOptimizations(client, 't', dec);
    // inserted[0] 是第 5 个参数位（$5 = status）
    expect(client.inserted[0][4]).toBe('applied');
  });

  it('规则不存在（0 行受影响）时审计为 no_match，不谎报 applied', async () => {
    const client = fakeClient(0);
    const dec = generateOptimizations(
      { arms: { 'electric::w-1': { weight: 0.6, pulls: 3 } }, alpha: 0.2, ucbC: 1.5, version: 2 },
      baseMetrics,
    ).filter((d) => d.scope === 'dispatch');
    await applyDispatchOptimizations(client, 't', dec);
    expect(client.inserted[0][4]).toBe('no_match');
  });
});
