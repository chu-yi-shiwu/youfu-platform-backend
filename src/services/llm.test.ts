// K2 embedding 工具单元测试（vitest）
// 目标：验证余弦相似度纯函数正确性 + embeddingConfigured 的 key 闸门（无 key 则向量路径休眠）。
// 不触真实网络：本测试不调用 embedText（需外部 API），只验证本地可判定逻辑。
import { describe, it, expect, beforeEach } from 'vitest';
import { cosineSimilarity, embeddingConfigured } from './llm.js';

describe('K2 embedding utils', () => {
  beforeEach(() => { delete process.env.EMBEDDING_API_KEY; });

  it('cosineSimilarity: 相同向量 = 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });
  it('cosineSimilarity: 正交向量 = 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });
  it('cosineSimilarity: 长度不一致 = 0（安全护栏）', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
  it('cosineSimilarity: 空向量 = 0', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
  it('cosineSimilarity: 零模长 = 0（除零保护）', () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it('embeddingConfigured(): 无 key → false（向量路径休眠，关键词兜底不变）', () => {
    expect(embeddingConfigured()).toBe(false);
  });
  it('embeddingConfigured(): 有 key → true', () => {
    process.env.EMBEDDING_API_KEY = 'sk-test';
    expect(embeddingConfigured()).toBe(true);
  });
});
