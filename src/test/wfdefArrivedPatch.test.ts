// workflow_def 到场态补丁纯函数单测（2026-09-06 任务⑤）
// 被测对象是零依赖 .mjs 纯函数核心（与主脚本共用同一份逻辑，杜绝"测试版逻辑≠线上脚本逻辑"）。
// 覆盖：旧图补丁后包含 arrived 三边（字段与 RICH 定义一致）、巡检图不动、t-phasea 异构图
//       只增不改、幂等重跑无变化、字符串 def 兼容、批量汇总。
import { describe, it, expect } from 'vitest';
import {
  ARRIVED_TRANSITIONS,
  needsArrivedPatch,
  applyArrivedPatch,
  patchWorkflowDefRows,
} from '../../tools/wfdef_arrived_patch_core.mjs';

// 旧版 work_order 图（存量租户典型形态：无 arrived，assigned--start-->processing 直连）
function legacyDef() {
  return {
    initial: 'draft',
    states: ['draft', 'assigned', 'processing', 'completed'],
    transitions: [
      { from: 'draft', to: 'assigned', event: 'assign' },
      { from: 'assigned', to: 'processing', event: 'start' },
      { from: 'processing', to: 'completed', event: 'complete' },
    ],
    config: { doneStates: ['completed'] },
  };
}

describe('needsArrivedPatch（命中条件）', () => {
  it('states 含 assigned+processing 且无 arrived → true', () => {
    expect(needsArrivedPatch(legacyDef())).toBe(true);
  });
  it('巡检类图（pending/in_progress/done）→ false，不动', () => {
    const patrol = { initial: 'pending', states: ['pending', 'in_progress', 'done'], transitions: [] };
    expect(needsArrivedPatch(patrol)).toBe(false);
  });
  it('结构不完整 / 已含 arrived → false', () => {
    expect(needsArrivedPatch(null)).toBe(false);
    expect(needsArrivedPatch({ states: 'x', transitions: [] })).toBe(false);
    expect(needsArrivedPatch({ states: ['assigned', 'arrived', 'processing'], transitions: [] })).toBe(false);
  });
});

describe('applyArrivedPatch（JSON 增量补丁）', () => {
  it('旧图补丁后：arrived 插在 assigned 之后，三条边字段与 RICH 定义一致', () => {
    const r = applyArrivedPatch(legacyDef());
    expect(r.changed).toBe(true);
    expect(r.addedStates).toBe(1);
    expect(r.addedEdges).toBe(3);
    expect(r.def.states).toEqual(['draft', 'assigned', 'arrived', 'processing', 'completed']);
    for (const edge of ARRIVED_TRANSITIONS) {
      const hit = r.def.transitions.find((t) => t.from === edge.from && t.event === edge.event && t.to === edge.to);
      expect(hit).toBeDefined();
      expect(hit!.allowedRoles).toEqual(edge.allowedRoles);
      expect(hit!.requiredFields).toEqual(edge.requiredFields); // undefined for前两条
    }
    // 既有边原样保留（不删不改：assigned--start-->processing 兼容路径仍在）
    expect(r.def.transitions).toContainEqual({ from: 'assigned', to: 'processing', event: 'start' });
  });

  it('幂等：对补丁结果重跑 → changed=false，无重复边', () => {
    const once = applyArrivedPatch(legacyDef()).def;
    const twice = applyArrivedPatch(once);
    expect(twice.changed).toBe(false);
    expect(twice.addedEdges).toBe(0);
    expect(twice.def.transitions.filter((t) => t.to === 'arrived' || t.from === 'arrived')).toHaveLength(3);
    expect(twice.def).toEqual(once);
  });

  it('t-phasea 异构图（claim_hall/paused/suspended）：只增不改，arrived 插在 assigned 之后', () => {
    const phaseA = {
      initial: 'draft',
      states: ['draft', 'claim_hall', 'assigned', 'processing', 'paused', 'suspended', 'completed', 'cancelled'],
      transitions: [
        { from: 'draft', to: 'claim_hall', event: 'submit' },
        { from: 'claim_hall', to: 'assigned', event: 'claim' },
        { from: 'assigned', to: 'processing', event: 'start' },
        { from: 'processing', to: 'paused', event: 'pause' },
        { from: 'processing', to: 'suspended', event: 'suspend' },
      ],
    };
    const r = applyArrivedPatch(phaseA);
    expect(r.changed).toBe(true);
    expect(r.def.states).toEqual(['draft', 'claim_hall', 'assigned', 'arrived', 'processing', 'paused', 'suspended', 'completed', 'cancelled']);
    // 原有 5 条边全部保留
    for (const t of phaseA.transitions) expect(r.def.transitions).toContainEqual(t);
    expect(r.def.transitions).toHaveLength(8); // 5 旧 + 3 新
  });

  it('半截补丁补齐：states 已含 arrived 但缺边 → 只补缺边，不重复', () => {
    const partial = {
      initial: 'draft',
      states: ['draft', 'assigned', 'arrived', 'processing'],
      transitions: [{ from: 'assigned', to: 'processing', event: 'start' }],
    };
    const r = applyArrivedPatch(partial);
    expect(r.changed).toBe(true);
    expect(r.addedStates).toBe(0);
    expect(r.addedEdges).toBe(3);
    const rerun = applyArrivedPatch(r.def);
    expect(rerun.changed).toBe(false);
  });

  it('巡检类图补丁后原样（deep-equal，绝不塞入引用不存在状态的边）', () => {
    const patrol = { initial: 'pending', states: ['pending', 'in_progress', 'done'], transitions: [{ from: 'pending', to: 'in_progress', event: 'start' }] };
    const r = applyArrivedPatch(patrol);
    expect(r.changed).toBe(false);
    expect(r.def).toEqual(patrol);
  });

  it('不可变性：入参对象不被改写', () => {
    const def = legacyDef();
    const snapshot = JSON.stringify(def);
    applyArrivedPatch(def);
    expect(JSON.stringify(def)).toBe(snapshot);
  });
});

describe('patchWorkflowDefRows（批量汇总，5 租户异构样本）', () => {
  it('命中 4 租户 work_order 图、巡检图与已补图不动；def 为字符串也兼容', () => {
    const rows = [
      { tenant_id: 't-1', entity_type: 'work_order', version: 3, def: legacyDef() },
      { tenant_id: 't-2', entity_type: 'work_order', version: 1, def: JSON.stringify(legacyDef()) }, // 字符串形态
      { tenant_id: 't-3', entity_type: 'work_order', version: 2, def: applyArrivedPatch(legacyDef()).def }, // 已补
      { tenant_id: 't-4', entity_type: 'patrol', version: 1, def: { initial: 'pending', states: ['pending', 'in_progress', 'done'], transitions: [] } },
      { tenant_id: 't-5', entity_type: 'work_order', version: 5, def: { initial: 'draft', states: ['draft', 'claim_hall', 'assigned', 'processing'], transitions: [] } },
    ];
    const { patched, unchanged } = patchWorkflowDefRows(rows);
    expect(patched.map((p) => p.tenant_id).sort()).toEqual(['t-1', 't-2', 't-5']);
    expect(unchanged).toBe(2);
    const t2 = patched.find((p) => p.tenant_id === 't-2')!;
    expect(t2.def_after.states).toContain('arrived');
    expect(t2.version_before).toBe(1);
    // 幂等重跑全量（t-1/t-2/t-5 用补丁后 def）：0 行命中
    const after = rows.map((r) =>
      ['t-1', 't-2', 't-5'].includes(r.tenant_id)
        ? { ...r, def: patched.find((p) => p.tenant_id === r.tenant_id)!.def_after }
        : r,
    );
    const rerun = patchWorkflowDefRows(after);
    expect(rerun.patched).toHaveLength(0);
    expect(rerun.unchanged).toBe(5);
  });

  it('脏数据（def 字符串解析失败）跳过不猜', () => {
    const { patched, unchanged } = patchWorkflowDefRows([
      { tenant_id: 't-x', entity_type: 'work_order', version: 1, def: '{not-json' },
    ]);
    expect(patched).toHaveLength(0);
    expect(unchanged).toBe(1);
  });
});
