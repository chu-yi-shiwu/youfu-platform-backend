// SEC-735 回归测试：锁定本轮审查修复的 2 处安全缺陷，防止回退。
import { describe, it, expect } from 'vitest';
import { extractCreds } from '../middleware/openApiAuth.js';
import { isValidTenantDirName } from '../routes/upload.js';

// 最小 Request mock：extractCreds 仅依赖 req.header(name)
function mockReq(headers: Record<string, string>) {
  return { header: (n: string) => headers[n] } as any;
}

describe('SEC-735-LATENT openApiAuth Bearer 解析（secret 含冒号）', () => {
  it('仅切首个冒号，secret 中的冒号被完整保留', () => {
    const header = 'Bearer ' + 'mykey' + ':' + 'sec:ret:with:colons';
    const creds = extractCreds(mockReq({ Authorization: header }));
    expect(creds).not.toBeNull();
    expect(creds!.key).toBe('mykey');
    expect(creds!.secret).toBe('sec:ret:with:colons');
  });
  it('X-App-Key / X-App-Secret 头仍可用', () => {
    const creds = extractCreds(mockReq({ 'X-App-Key': 'k', 'X-App-Secret': 's' }));
    expect(creds).toEqual({ key: 'k', secret: 's' });
  });
  it('Bearer key:（secret 为空）→ 返回 null，不再恒 AUTH_004', () => {
    const creds = extractCreds(mockReq({ Authorization: 'Bearer key:' }));
    expect(creds).toBeNull();
  });
  it('无凭据 → 返回 null', () => {
    expect(extractCreds(mockReq({}))).toBeNull();
  });
});

describe('SEC-735-MEDIUM 上传租户目录名校验（防路径穿越）', () => {
  it('合法租户 slug 通过', () => {
    expect(isValidTenantDirName('t-verification')).toBe(true);
    expect(isValidTenantDirName('tenant_1')).toBe(true);
    expect(isValidTenantDirName('org-abc123')).toBe(true);
  });
  it('含路径分隔符或上级引用 → 拒绝', () => {
    expect(isValidTenantDirName('../..')).toBe(false);
    expect(isValidTenantDirName('a/b')).toBe(false);
    expect(isValidTenantDirName('a\\b')).toBe(false);
    expect(isValidTenantDirName('..a')).toBe(false);
    expect(isValidTenantDirName('a/../b')).toBe(false);
  });
  it('空值 / 非字符串 → 拒绝', () => {
    expect(isValidTenantDirName('')).toBe(false);
  });
});
