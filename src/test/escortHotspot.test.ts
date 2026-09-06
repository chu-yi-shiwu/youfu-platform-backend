// 陪检线运力走廊告警单测（2026-09-06 任务⑦，≥10 例）
// 覆盖：陪检单 3 次触发 / 2 次不触发 / 维修单（含跳闸）不进 escort 规则 / 窗口边界 /
//       空白归一 / 互斥性（维修线排除集 = 陪检线纳入集）/ 守卫断言 escort target 被 skip / 建议结构断言。
import { describe, it, expect } from 'vitest';
import {
  groupRepeatHotspots,
  groupEscortCorridors,
  generateEscortCorridorOptimizations,
  isAutoApplicableTarget,
  REPEAT_HOTSPOT_EXCLUDED_KEYWORDS,
  type RepeatHotspotRow,
} from '../services/optimizer.js';

const NOW = new Date('2026-09-06T08:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 864e5).toISOString();

function escortRow(over: Partial<RepeatHotspotRow> = {}): RepeatHotspotRow {
  return {
    location: '门诊楼 3 层',
    catalog: 'cat-escort',
    catalog_name: 'CT陪检',
    business_type: 'transport',
    created_at: daysAgo(10),
    ...over,
  };
}

describe('groupEscortCorridors（陪检线运力走廊纯函数）', () => {
  const opts = { now: NOW };

  it('① 陪检单 30 天内 3 次 → 触发，count=3', () => {
    const hs = groupEscortCorridors([escortRow(), escortRow({ created_at: daysAgo(5) }), escortRow({ created_at: daysAgo(1) })], opts);
    expect(hs).toHaveLength(1);
    expect(hs[0]).toMatchObject({ location: '门诊楼 3 层', catalog: 'cat-escort', count: 3 });
  });

  it('② 陪检单 2 次 → 不触发（< minCount=3）', () => {
    expect(groupEscortCorridors([escortRow(), escortRow({ created_at: daysAgo(2) })], opts)).toHaveLength(0);
  });

  it('③ 维修单（含跳闸类描述/类目）不进 escort 规则', () => {
    const rows: RepeatHotspotRow[] = [
      escortRow({ business_type: 'repair', catalog_name: '空调维修', catalog: 'cat-hvac' }),
      escortRow({ business_type: 'repair', catalog_name: '空调维修', catalog: 'cat-hvac', created_at: daysAgo(5) }),
      escortRow({ business_type: 'repair', catalog_name: '空调维修', catalog: 'cat-hvac', created_at: daysAgo(1) }),
    ];
    expect(groupEscortCorridors(rows, opts)).toHaveLength(0);
  });

  it('④ 滚动窗口边界：恰好 30 天前命中（含边界），30 天+1ms 与未来时间不命中', () => {
    const rows = [
      escortRow({ created_at: daysAgo(30) }),                                   // 边界内（含）
      escortRow({ created_at: daysAgo(10) }),
      escortRow({ created_at: daysAgo(1) }),
      escortRow({ created_at: new Date(NOW.getTime() - 30 * 864e5 - 1).toISOString() }), // 边界外 1ms
      escortRow({ created_at: new Date(NOW.getTime() + 864e5).toISOString() }),  // 未来时间
    ];
    const hs = groupEscortCorridors(rows, opts);
    expect(hs).toHaveLength(1);
    expect(hs[0].count).toBe(3);
  });

  it('⑤ 位置空白差异归一为同一分组键（trim + 空白折叠）', () => {
    const rows = [
      escortRow({ location: '门诊楼  3 层' }),
      escortRow({ location: '门诊楼 3 层', created_at: daysAgo(3) }),
      escortRow({ location: ' 门诊楼 3 层 ', created_at: daysAgo(1) }),
    ];
    expect(groupEscortCorridors(rows, opts)[0].count).toBe(3);
  });

  it('⑥ 类目不同不合并计数；location/catalog 为空不成组', () => {
    const diffCat = [
      escortRow(),
      escortRow({ catalog: 'cat-x', catalog_name: '转科护送' }),
      escortRow({ created_at: daysAgo(2) }),
    ];
    expect(groupEscortCorridors(diffCat, opts)).toHaveLength(0);
    const empty = [
      escortRow({ location: null }),
      escortRow({ location: null, created_at: daysAgo(3) }),
      escortRow({ location: null, created_at: daysAgo(1) }),
    ];
    expect(groupEscortCorridors(empty, opts)).toHaveLength(0);
  });

  it('⑦ 多走廊按 count 降序', () => {
    const rows = [
      ...Array.from({ length: 4 }, (_, i) => escortRow({ created_at: daysAgo(i) })),
      ...Array.from({ length: 3 }, (_, i) => escortRow({ location: '住院部', created_at: daysAgo(i), catalog_name: '检查申请陪护' })),
    ];
    const hs = groupEscortCorridors(rows, opts);
    expect(hs).toHaveLength(2);
    expect(hs[0].count).toBe(4);
    expect(hs[1].count).toBe(3);
  });
});

describe('与维修线热点的互斥性（口径闭合，无交叠缝隙）', () => {
  const opts = { now: NOW };
  it('⑧ 同一批数据：维修线热点与陪检线走廊分区严格互斥（检查申请/护送/transport 全归 escort）', () => {
    const rows: RepeatHotspotRow[] = [
      // 陪检线：business_type 命中
      escortRow(),
      escortRow({ created_at: daysAgo(5) }),
      escortRow({ created_at: daysAgo(1) }),
      // 陪检线：仅类目名命中（business_type 正常）
      escortRow({ location: '急诊大厅', catalog_name: '转科护送', catalog: 'cat-escort2', business_type: 'escort', created_at: daysAgo(2) }),
      escortRow({ location: '急诊大厅', catalog_name: '转科护送', catalog: 'cat-escort2', business_type: 'escort', created_at: daysAgo(3) }),
      escortRow({ location: '急诊大厅', catalog_name: '转科护送', catalog: 'cat-escort2', business_type: 'escort', created_at: daysAgo(4) }),
      // 维修线：完全不带陪检词汇
      escortRow({ location: '内科病房', catalog_name: '灯不亮', catalog: 'cat-light', business_type: 'repair' }),
      escortRow({ location: '内科病房', catalog_name: '灯不亮', catalog: 'cat-light', business_type: 'repair', created_at: daysAgo(5) }),
      escortRow({ location: '内科病房', catalog_name: '灯不亮', catalog: 'cat-light', business_type: 'repair', created_at: daysAgo(1) }),
    ];
    const repair = groupRepeatHotspots(rows, opts);
    const escort = groupEscortCorridors(rows, opts);
    // 维修线只认 repair 组；陪检线只认两组 escort 组
    expect(repair.map((h) => h.location).sort()).toEqual(['内科病房']);
    expect(escort.map((h) => h.location).sort()).toEqual(['急诊大厅', '门诊楼 3 层']);
    // 交集为空
    const repairKeys = new Set(repair.map((h) => `${h.location}\u0001${h.catalog}`));
    for (const h of escort) expect(repairKeys.has(`${h.location}\u0001${h.catalog}`)).toBe(false);
  });

  it('⑨ 排除词表与 escort 命中词表同源（维修排除的行 = 陪检纳入的行）', () => {
    for (const must of ['陪检', '护送', '运送', '转运', '转科', '检查申请', 'transport', 'escort']) {
      expect(REPEAT_HOTSPOT_EXCLUDED_KEYWORDS).toContain(must);
    }
  });
});

describe('generateEscortCorridorOptimizations（建议结构）与守卫红线', () => {
  it('⑩ 每走廊一条 scope=transport 建议，action=review_staffing，reason 含运力调度语义', () => {
    const hs = groupEscortCorridors(
      [escortRow(), escortRow({ created_at: daysAgo(5) }), escortRow({ created_at: daysAgo(1) })],
      { now: NOW },
    );
    const dec = generateEscortCorridorOptimizations(hs);
    expect(dec).toHaveLength(1);
    expect(dec[0].scope).toBe('transport');
    expect(dec[0].target).toBe('transport:repeat_corridor');
    expect(dec[0].recommendation.action).toBe('review_staffing');
    expect(dec[0].recommendation.count).toBe(3);
    expect(dec[0].recommendation.window_days).toBe(30);
    expect(dec[0].recommendation.min_count).toBe(3);
    expect(String(dec[0].reason)).toContain('固定班次');
    expect(String(dec[0].reason)).toContain('常驻陪检岗');
    expect(String(dec[0].reason)).toContain('合并派单');
    expect(String(dec[0].reason)).toContain('运力走廊'); // 语义=运力调度，非维修故障
    expect(String(dec[0].recommendation.action)).not.toBe('inspect_root_cause'); // 不与维修线动作混用
  });

  it('⑪ 守卫断言：escort/走廊类 target 永不被 isAutoApplicableTarget 放行（绝不自动 applied）', () => {
    expect(isAutoApplicableTarget('transport:repeat_corridor')).toBe(false);
    expect(isAutoApplicableTarget('work_order:repeat_hotspot')).toBe(false);
    expect(isAutoApplicableTarget('work_order:recheck_gate')).toBe(true);
  });

  it('⑫ dbScopeFor：transport 落库映射为 workflow（DDL CHECK 兜底），dispatch 原样', async () => {
    const { dbScopeFor } = await import('../services/optimizer.js');
    expect(dbScopeFor('transport')).toBe('workflow');
    expect(dbScopeFor('workflow')).toBe('workflow');
    expect(dbScopeFor('dispatch')).toBe('dispatch');
  });
});
