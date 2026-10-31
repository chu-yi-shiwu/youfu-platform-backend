/**
 * R1 补强：版本回滚不得**静默**丢掉 config.fields
 *
 * 背景（生产实测 + 读码，2026-11-01）：
 *   · `workflow_def_history` 长期落后于 `workflow_def.version`（实测 def v17 / hist 最高 v15）
 *   · `POST /:entityType/versions/:version/rollback` 会把 history 里目标版本的 def **整体替换**当前 def
 *   · 一旦回滚到没有 `config.fields` 的旧版本，小程序建单页从"读配置"退回"未配置"，
 *     而**双方都不报错** —— 与 X1 同一类静默失效
 *
 * 本探针只钉纯函数判定；路由层的 409 与逃生口在路由测试/上线验收覆盖。
 */
import { describe, it, expect } from 'vitest';
import { detectConfigFieldLoss } from '../engine/workflowDef.js';

const F6 = ['title', 'category', 'location', 'urgency', 'photos', 'voice'];

function def(fields?: unknown) {
  const base: Record<string, unknown> = {
    initial: 'draft',
    states: ['draft'],
    transitions: [],
  };
  if (fields !== undefined) base.config = { fields };
  return base as { initial: string; states: string[]; transitions: unknown[]; config?: any };
}

describe('detectConfigFieldLoss —— 回滚前判定会丢哪些表单字段', () => {
  it('目标版本无 fields、当前有 ⇒ 报出全部丢失字段（顺序保持）', () => {
    const live = def(F6.map((k) => ({ key: k, type: 'text' })));
    const target = def(); // 没有 config.fields
    const r = detectConfigFieldLoss(live, target);
    expect(r.droppedFieldKeys).toEqual(F6);
  });

  it('目标版本 fields 与当前完全一致 ⇒ 不报丢失', () => {
    const live = def(F6.map((k) => ({ key: k, type: 'text' })));
    const target = def(F6.map((k) => ({ key: k, type: 'text' })));
    expect(detectConfigFieldLoss(live, target).droppedFieldKeys).toEqual([]);
  });

  it('当前本来就没有 fields ⇒ 不误报（回滚到同样没字段的版本是合法的）', () => {
    expect(detectConfigFieldLoss(def(), def()).droppedFieldKeys).toEqual([]);
    expect(detectConfigFieldLoss(def([]), def()).droppedFieldKeys).toEqual([]);
  });

  it('目标是当前的真子集 ⇒ 只报被丢掉的那几个', () => {
    const live = def(F6.map((k) => ({ key: k, type: 'text' })));
    const target = def(F6.slice(0, 3).map((k) => ({ key: k, type: 'text' })));
    expect(detectConfigFieldLoss(live, target).droppedFieldKeys).toEqual(['urgency', 'photos', 'voice']);
  });

  it('config.fields 不是数组（脏数据）⇒ 视为无字段配置，仍报丢失，但不崩', () => {
    // 规格选择「保守拦截」而非「放行」：脏数据时我们无法断定目标真的没丢字段，
    // 放行 = 可能静默抹掉建单表单；拦截代价仅是多一次显式确认（有 confirm_field_loss 逃生口）。
    const live = def(F6.map((k) => ({ key: k, type: 'text' })));
    const target = { initial: 'draft', states: ['draft'], transitions: [], config: { fields: 'oops' } };
    expect(() => detectConfigFieldLoss(live, target as any)).not.toThrow();
    expect(detectConfigFieldLoss(live, target as any).droppedFieldKeys).toEqual(F6);
  });

  it('缺 key 的字段项被忽略（不把 undefined 当成字段名）', () => {
    const live = def([{ key: 'title' }, { type: 'text' }, { key: 'voice' }]);
    const target = def();
    expect(detectConfigFieldLoss(live, target).droppedFieldKeys).toEqual(['title', 'voice']);
  });
});
