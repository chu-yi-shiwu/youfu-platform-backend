// R19-003 接入层安全关键纯函数回归测试（不依赖数据库）。
import { describe, it, expect } from 'vitest';
import { isPerTenantSummaryAllowed } from '../routes/openApi.js';
import { safeEqualHex } from '../middleware/openApiAuth.js';
import { isValidTenantDirName } from '../routes/upload.js';

describe('openApi.isPerTenantSummaryAllowed（开放 API 横向越权闸门）', () => {
  it('无 tenant_id → 允许全量聚合（默认行为）', () => {
    expect(isPerTenantSummaryAllowed(['summary:read'])).toBe(true);
    expect(isPerTenantSummaryAllowed(['summary:read'], undefined)).toBe(true);
  });
  it('仅 summary:read 作用域 → 禁止带 tenant_id 下钻单租户（最小权限）', () => {
    expect(isPerTenantSummaryAllowed(['summary:read'], 't-foo')).toBe(false);
  });
  it('summary:read:* 或 * 作用域 → 允许下钻', () => {
    expect(isPerTenantSummaryAllowed(['summary:read:*'], 't-foo')).toBe(true);
    expect(isPerTenantSummaryAllowed(['*'], 't-foo')).toBe(true);
  });
});

describe('openApiAuth.safeEqualHex（app_secret 常量时间比对，防时序旁路）', () => {
  it('相同返回 true', () => {
    expect(safeEqualHex('abc', 'abc')).toBe(true);
  });
  it('不同返回 false', () => {
    expect(safeEqualHex('abc', 'abd')).toBe(false);
    expect(safeEqualHex('', 'abc')).toBe(false);
  });
  it('长度不同直接 false（避免误判为相等）', () => {
    expect(safeEqualHex('abc', 'abcd')).toBe(false);
  });
});

describe('upload.isValidTenantDirName（上传租户目录名白名单，防逃逸 UPLOAD_ROOT）', () => {
  it('合法租户目录名通过', () => {
    expect(isValidTenantDirName('t-verification')).toBe(true);
    expect(isValidTenantDirName('demo_tenant')).toBe(true);
    expect(isValidTenantDirName('a1-b2_c3')).toBe(true);
  });
  it('含路径分隔符或上级引用拒绝', () => {
    expect(isValidTenantDirName('a/b')).toBe(false);
    expect(isValidTenantDirName('a\\b')).toBe(false);
    expect(isValidTenantDirName('..')).toBe(false);
    expect(isValidTenantDirName('../etc')).toBe(false);
    expect(isValidTenantDirName('a/../b')).toBe(false);
  });
  it('空字符串拒绝', () => {
    expect(isValidTenantDirName('')).toBe(false);
    expect(isValidTenantDirName(undefined as unknown as string)).toBe(false);
  });
});
