// 嵌入后台队列（2026-11-15 主站压测根因修复）
//
// 现象：主站建单 20 并发 p95 3.2s（pilot 239ms），同期流转也被拖慢。
// 根因：每个建单 fire-and-forget 调外部 embedding，无并发上限；且未遵守租户 AI 开关。
// 修复：租户 ai_features_enabled 关闭则不产生任务；有界队列 2 并发 / 200 上限。
import { describe, it, expect, vi } from 'vitest';
import { enqueueEmbedding, embeddingQueueStats } from '../services/embeddingQueue.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('embeddingQueue 有界并发', () => {
  it('同时最多 2 个任务在跑', async () => {
    let active = 0;
    let max = 0;
    const tasks = Array.from({ length: 10 }, (_, i) =>
      enqueueEmbedding(async () => {
        active += 1;
        max = Math.max(max, active);
        await sleep(15);
        active -= 1;
      }),
    );
    expect(tasks.every(Boolean)).toBe(true);
    await sleep(150);
    expect(max).toBeLessThanOrEqual(2);
    expect(embeddingQueueStats().active).toBe(0);
  });

  it('队列满时丢弃并告警，不无限堆积', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const accepted: boolean[] = [];
    for (let i = 0; i < 260; i++) accepted.push(enqueueEmbedding(async () => { await gate; }));
    expect(accepted.filter(Boolean).length).toBeLessThanOrEqual(202); // 2 活跃 + 200 队列
    expect(accepted.filter((x) => !x).length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalled();
    release();
    await sleep(50);
    warn.mockRestore();
  });
});

describe('ticket 建单路径根因不变式', () => {
  const src = readFileSync(join(__dirname, '..', 'repo', 'ticket.ts'), 'utf8');
  it('必须先过租户 AI 开关，再入队（不能只凭全局 key）', () => {
    const gate = src.indexOf('getAiFeaturesEnabled(dto.tenantId, client)');
    const enqueue = src.indexOf('enqueueEmbedding(');
    expect(gate).toBeGreaterThan(-1);
    expect(enqueue).toBeGreaterThan(gate);
    expect(src).toMatch(/if \(!aiEnabled\) return;/);
  });
});
