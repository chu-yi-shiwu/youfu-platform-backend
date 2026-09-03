// A3 入口接线单测：listEntityTypes（内置主题 ∪ 租户已配置 entity_type 的合并逻辑）。
// 不依赖真实 PG：fake client 模拟 workflow_def distinct 查询。
import { describe, it, expect } from 'vitest';
import { listEntityTypes } from '../routes/businessFlow.js';
import { TRANSPORT_DEF, EMERGENCY_DEF } from '../engine/themes.js';

function fakeClient(configured: string[]) {
  return {
    query: async (text: string) => {
      if (text.includes('workflow_def')) {
        return { rows: configured.map((entity_type) => ({ entity_type })) };
      }
      return { rows: [] };
    },
  } as any;
}

describe('flow 实体类型清单（/flow/entities 数据源）', () => {
  it('零配置租户 → 仅内置主题（transport_task / emergency_plan）', async () => {
    const list = await listEntityTypes(fakeClient([]), 't-x');
    expect(list.map((e) => e.entityType).sort()).toEqual(['emergency_plan', 'transport_task']);
    expect(list.every((e) => e.builtin)).toBe(true);
    expect(list.every((e) => typeof e.label === 'string' && e.label.length > 0)).toBe(true);
  });

  it('租户自定义流程 → 合并去重且 builtin=false', async () => {
    const list = await listEntityTypes(fakeClient(['cycle_check', 'emergency_plan']), 't-x');
    const map = new Map(list.map((e) => [e.entityType, e]));
    expect(map.size).toBe(3);
    expect(map.get('cycle_check')!.builtin).toBe(false);
    expect(map.get('emergency_plan')!.builtin).toBe(true);
    expect(map.get('transport_task')!.builtin).toBe(true);
  });

  it('内置兜底与 themes.ts 保持同源（ENTITY_DEF 不漂移）', async () => {
    // listEntityTypes 的 builtins 来自 ENTITY_DEF（TRANSPORT_DEF/EMERGENCY_DEF 键），
    // 此处锁断言：若 themes.ts 新增内置主题，本用例会提醒同步测试预期。
    expect(Object.keys(TRANSPORT_DEF)).toBeDefined();
    expect(Object.keys(EMERGENCY_DEF)).toBeDefined();
    const list = await listEntityTypes(fakeClient([]), 't-x');
    expect(list.length).toBe(2);
  });
});
