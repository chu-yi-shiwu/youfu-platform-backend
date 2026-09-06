// 位置×类目高频重复告警单测（2026-09-06 任务③）
// 覆盖：规则触发（3 次/30 天命中）、2 次不触发、滚动窗口边界、陪检/运送排除、
//       建议结构断言、自动改流程守卫（repeat_hotspot 不被 auto-apply 吞掉）。
import { describe, it, expect } from 'vitest';
import {
  normalizeLocationKey,
  groupRepeatHotspots,
  generateRepeatHotspotOptimizations,
  isAutoApplicableTarget,
  REPEAT_HOTSPOT_DEFAULTS,
  REPEAT_HOTSPOT_EXCLUDED_KEYWORDS,
  applyRecommendationToDef,
  type RepeatHotspotRow,
} from '../services/optimizer.js';

const NOW = new Date('2026-09-06T08:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 864e5).toISOString();

function row(over: Partial<RepeatHotspotRow> = {}): RepeatHotspotRow {
  return {
    location: '3号楼护士站',
    catalog: 'cat-hvac',
    catalog_name: '空调维修',
    business_type: 'repair',
    created_at: daysAgo(10),
    ...over,
  };
}

describe('normalizeLocationKey（诚实口径：仅 trim + 空白折叠）', () => {
  it('折叠连续空白并去首尾', () => {
    expect(normalizeLocationKey('  3号楼  护士站 \t  east  ')).toBe('3号楼 护士站 east');
  });
  it('空值安全返回空串（空键不成组）', () => {
    expect(normalizeLocationKey(null)).toBe('');
    expect(normalizeLocationKey(undefined)).toBe('');
    expect(normalizeLocationKey('   ')).toBe('');
  });
});

describe('groupRepeatHotspots（纯函数聚合）', () => {
  const opts = { now: NOW };

  it('30 天内 3 次同类报修 → 触发，计数正确', () => {
    const rows = [row(), row({ created_at: daysAgo(5) }), row({ created_at: daysAgo(1) })];
    const hs = groupRepeatHotspots(rows, opts);
    expect(hs).toHaveLength(1);
    expect(hs[0]).toMatchObject({ location: '3号楼护士站', catalog: 'cat-hvac', count: 3 });
  });

  it('2 次不触发（< minCount=3）', () => {
    const hs = groupRepeatHotspots([row(), row({ created_at: daysAgo(2) })], opts);
    expect(hs).toHaveLength(0);
  });

  it('滚动窗口边界：恰好 30 天前命中（含边界），30 天+1ms 不命中，未来时间不命中', () => {
    const rows = [
      row({ created_at: daysAgo(30) }),              // 边界内（含）
      row({ created_at: daysAgo(10) }),              // 窗口内凑足阈值
      row({ created_at: new Date(NOW.getTime() - 30 * 864e5 - 1).toISOString() }), // 边界外 1ms
      row({ created_at: NOW.toISOString() }),        // now 本身命中
    ];
    const hs = groupRepeatHotspots(rows, opts);
    expect(hs).toHaveLength(1);
    expect(hs[0].count).toBe(3);
    // 未来时间戳剔除
    const withFuture = [...rows, row({ created_at: new Date(NOW.getTime() + 864e5).toISOString() })];
    expect(groupRepeatHotspots(withFuture, opts)[0].count).toBe(3);
  });

  it('位置空白差异归一为同一分组键', () => {
    const rows = [
      row({ location: '3号楼  护士站' }),
      row({ location: '3号楼 护士站', created_at: daysAgo(3) }),
      row({ location: ' 3号楼 护士站 ', created_at: daysAgo(1) }),
    ];
    expect(groupRepeatHotspots(rows, opts)[0].count).toBe(3);
  });

  it('不同类目不合并计数', () => {
    const rows = [
      row(),
      row({ catalog: 'cat-water', catalog_name: '给排水' }),
      row({ created_at: daysAgo(2) }),
    ];
    expect(groupRepeatHotspots(rows, opts)).toHaveLength(0);
  });

  it('陪检/运送业务线排除：business_type 或类目名命中排除词 → 不参与', () => {
    const rows = [
      row({ business_type: 'transport', catalog_name: '转科运送' }),
      row({ business_type: 'transport', catalog_name: '转科运送', created_at: daysAgo(3) }),
      row({ business_type: 'transport', catalog_name: '转科运送', created_at: daysAgo(1) }),
      // 类目名命中但 business_type 正常 → 仍排除
      row({ catalog_name: '陪检服务' }),
      row({ catalog_name: '陪检服务', created_at: daysAgo(3) }),
      row({ catalog_name: '陪检服务', created_at: daysAgo(1) }),
    ];
    expect(groupRepeatHotspots(rows, opts)).toHaveLength(0);
  });

  it('location/catalog 为空不成组（诚实留白）', () => {
    const rows = [
      row({ location: null }),
      row({ location: null, created_at: daysAgo(3) }),
      row({ location: null, created_at: daysAgo(1) }),
      row({ catalog: null, catalog_name: null }),
      row({ catalog: null, catalog_name: null, created_at: daysAgo(3) }),
      row({ catalog: null, catalog_name: null, created_at: daysAgo(1) }),
    ];
    expect(groupRepeatHotspots(rows, opts)).toHaveLength(0);
  });

  it('多热点按 count 降序输出', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => row({ created_at: daysAgo(i) })),
      ...Array.from({ length: 3 }, (_, i) => row({ location: '门诊楼', created_at: daysAgo(i) })),
    ];
    const hs = groupRepeatHotspots(rows, opts);
    expect(hs).toHaveLength(2);
    expect(hs[0].count).toBe(5);
    expect(hs[1].count).toBe(3);
  });

  it('缺省阈值 = 30 天 / ≥3 次', () => {
    expect(REPEAT_HOTSPOT_DEFAULTS).toEqual({ windowDays: 30, minCount: 3 });
  });

  it('排除词表覆盖陪检/运送业务线关键词', () => {
    for (const must of ['陪检', '护送', '运送', '转运', '转科', 'transport', 'escort']) {
      expect(REPEAT_HOTSPOT_EXCLUDED_KEYWORDS).toContain(must);
    }
  });
});

describe('generateRepeatHotspotOptimizations（建议结构）', () => {
  it('每热点一条 workflow 建议，只产建议不改状态', () => {
    const hotspots = groupRepeatHotspots(
      [row(), row({ created_at: daysAgo(5) }), row({ created_at: daysAgo(1) })],
      { now: NOW },
    );
    const dec = generateRepeatHotspotOptimizations(hotspots);
    expect(dec).toHaveLength(1);
    expect(dec[0].scope).toBe('workflow');
    expect(dec[0].target).toBe('work_order:repeat_hotspot');
    expect(dec[0].recommendation.action).toBe('inspect_root_cause');
    expect(dec[0].recommendation.count).toBe(3);
    expect(dec[0].recommendation.window_days).toBe(30);
    expect(dec[0].reason).toContain('巡检/根因排查');
  });
});

describe('自动改流程守卫（repeat_hotspot 绝不被 auto-apply 吞掉）', () => {
  it('isAutoApplicableTarget 不认识 repeat_hotspot', () => {
    expect(isAutoApplicableTarget('work_order:repeat_hotspot')).toBe(false);
    expect(isAutoApplicableTarget('work_order:recheck_gate')).toBe(true);
    expect(isAutoApplicableTarget('work_order:sla_tighten')).toBe(true);
    expect(isAutoApplicableTarget('business_flow_tasks:auto_escalate')).toBe(true);
  });
  it('applyRecommendationToDef 对 repeat_hotspot 建议不改状态图（防御兜底）', () => {
    const def = {
      initial: 'draft',
      states: ['draft', 'processing'],
      transitions: [{ from: 'draft', to: 'processing', event: 'start' }],
      config: {},
    };
    const decision = {
      scope: 'workflow' as const,
      target: 'work_order:repeat_hotspot',
      recommendation: { action: 'inspect_root_cause', count: 5 },
      reason: '',
    };
    const next = applyRecommendationToDef(def, decision);
    expect(next.states).toEqual(def.states);
    expect(next.transitions).toEqual(def.transitions);
  });
});
