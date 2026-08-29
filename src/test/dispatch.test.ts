import { describe, it, expect } from 'vitest';
import { pickWorker, type WorkerRow } from '../engine/dispatch.js';

const workers: WorkerRow[] = [
  { id: 'w1', skill_tags: ['repair'], load: 3, active: true },
  { id: 'w2', skill_tags: ['repair', 'electric'], load: 1, active: true },
  { id: 'w3', skill_tags: ['repair'], load: 1, active: false }, // 非 active 不选
];

describe('dispatch pickWorker', () => {
  it('命中且 least_load 优先（取最低 load 的 active worker）', () => {
    const picked = pickWorker(workers, { skillTags: ['repair'] });
    expect(picked?.id).toBe('w2'); // w1 load3, w2 load1(active) -> 取 w2
  });

  it('多技能命中取最低 load', () => {
    const picked = pickWorker(workers, { skillTags: ['repair', 'electric'] });
    expect(picked?.id).toBe('w2');
  });

  it('无匹配返回 null（上层映射 claim_hall，P6 不自动完成）', () => {
    const picked = pickWorker(workers, { skillTags: ['plumbing'] });
    expect(picked).toBeNull();
  });

  it('R17-005 防御：pickWorker 不原地排序污染入参数组', () => {
    const snapshot = workers.map((w) => ({ ...w }));
    pickWorker(workers, { skillTags: ['repair'] });
    expect(workers.map((w) => w.id)).toEqual(snapshot.map((w) => w.id)); // 顺序未被改动
  });
});
