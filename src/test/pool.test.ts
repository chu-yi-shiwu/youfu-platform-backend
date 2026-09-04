import { describe, it, expect } from 'vitest';
import { assertSafeTenantId } from '../db/pool.js';
import { AppError } from '../middleware/error.js';

// R8 收口（2026-08-27 补遗）：assertSafeTenantId 是多租户隔离的「第一道闸」——
// SET LOCAL app.tenant_id 必须拼字符串（不支持 $1 参数化），故严格白名单 + 二次转义是防 SET 注入的唯一防线。
// 此前缺专职单测，本次补齐，直接锁定「非法租户标识一律被拒」的契约。
describe('assertSafeTenantId · 多租户隔离守卫（R8 收口，原缺专职单测）', () => {
  const VALID = [
    't-verification',
    'tenant_a',
    'org.1',
    'A-B_c.D',
    'T1',
    'a'.repeat(64), // 长度上限边界
  ];
  it.each(VALID)('接受合法租户标识: %s', (id) => {
    expect(assertSafeTenantId(id)).toBe(id);
  });

  const INVALID = [
    '', // 空
    ' ', // 空格
    '../../etc', // 路径穿越
    'a/b', // 正斜杠
    'a\\b', // 反斜杠
    'a b', // 空格
    'a;b', // SQL 片段
    "a'b", // 单引号（SET 注入载体）
    'a`b', // 反引号
    'a"b', // 双引号
    'a'.repeat(65), // 超长
  ];
  it.each(INVALID)('拒绝非法租户标识: %s', (id) => {
    expect(() => assertSafeTenantId(id)).toThrow('INVALID_TENANT_ID');
  });

  it('拒绝 SQL/SET 注入片段（防 SET LOCAL app.tenant_id 拼接注入；代码另有单引号二次转义作为第二道防线）', () => {
    expect(() => assertSafeTenantId("t1'; DROP TABLE tenant_registry;--")).toThrow();
  });

  it('长度边界：64 位接受、65 位拒绝（防超长边界滥用）', () => {
    expect(assertSafeTenantId('a'.repeat(64))).toBe('a'.repeat(64));
    expect(() => assertSafeTenantId('a'.repeat(65))).toThrow('INVALID_TENANT_ID');
  });

  it('仅放行白名单字符集 [A-Za-z0-9_.\\-]（覆盖上传端点 org 曾用的 ad-hoc includes 检查契约）', () => {
    // 与 /public/upload 历史守卫一致：含 / \\ 或 .. 的 org 一律不可作为租户标识流入 path.join
    for (const bad of ['../', '..\\', '/etc', 'c:/windows']) {
      expect(() => assertSafeTenantId(bad)).toThrow();
    }
  });

  it('OBS-1（#922）：拒绝时抛 AppError(400) 而非裸 Error——走 errorMiddleware 正常 4xx 路径，不再误入 [unhandled]/500 通道', () => {
    try {
      assertSafeTenantId('bad id!');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      const appErr = e as AppError;
      expect(appErr.code).toBe('INVALID_TENANT_ID');
      expect(appErr.status).toBe(400);
      expect(appErr.message).toContain('INVALID_TENANT_ID'); // toThrow 子串断言兼容性锚点
    }
  });
});
