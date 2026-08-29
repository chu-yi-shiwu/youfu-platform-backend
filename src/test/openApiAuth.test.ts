// openApiAuth 纯函数回归（不依赖 DB）。
// 覆盖：extractCreds（首冒号切分，secret 可含冒号）/ safeEqualHex（长度不同/相等/不等）/ requireScope（scope 命中 / '*' 通配 / 缺失）。
import { describe, it, expect } from 'vitest';
import { extractCreds, safeEqualHex, requireScope } from '../middleware/openApiAuth.js';
import { AppError } from '../middleware/error.js';

function mockRes(scopes: string[] | undefined) {
  return { locals: { openApp: scopes ? { id: 'a', app_key: 'k', app_name: 'n', scopes } : undefined } };
}

describe('extractCreds', () => {
  it('X-App-Key + X-App-Secret 头', () => {
    const req = { header: (h: string) => (h === 'X-App-Key' ? 'key1' : h === 'X-App-Secret' ? 'sec1' : undefined) } as any;
    expect(extractCreds(req)).toEqual({ key: 'key1', secret: 'sec1' });
  });

  it('Authorization: Bearer key:secret', () => {
    const req = { header: (h: string) => (h === 'Authorization' ? 'Bearer key1:sec1' : undefined) } as any;
    expect(extractCreds(req)).toEqual({ key: 'key1', secret: 'sec1' });
  });

  it('secret 含冒号时只切首个冒号（修复项：旧 indexOf 之外 reconciliation）', () => {
    const req = { header: (h: string) => (h === 'Authorization' ? 'Bearer k:aa:bb:cc' : undefined) } as any;
    expect(extractCreds(req)).toEqual({ key: 'k', secret: 'aa:bb:cc' });
  });

  it('无凭据返回 null', () => {
    const req = { header: () => undefined } as any;
    expect(extractCreds(req)).toBeNull();
  });
});

describe('safeEqualHex', () => {
  it('相等返回 true', () => {
    expect(safeEqualHex('abcd', 'abcd')).toBe(true);
  });
  it('长度不同直接 false（防长度旁路）', () => {
    expect(safeEqualHex('abcd', 'abcde')).toBe(false);
  });
  it('长度相同但内容不同返回 false', () => {
    expect(safeEqualHex('abcd', 'abce')).toBe(false);
  });
});

describe('requireScope', () => {
  it('scopes 含目标 scope → 放行（next 无参）', () => {
    const next = (() => {}) as any;
    const spy = { calls: [] as any[] };
    const wrapped = (...args: any[]) => { spy.calls.push(args); };
    requireScope('ticket.manage')({} as any, mockRes(['ticket.manage']) as any, wrapped as any);
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0][0]).toBeUndefined();
  });

  it('scopes 含 * 通配 → 放行', () => {
    const spy = { calls: [] as any[] };
    const wrapped = (...args: any[]) => { spy.calls.push(args); };
    requireScope('anything')({} as any, mockRes(['*']) as any, wrapped as any);
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0][0]).toBeUndefined();
  });

  it('缺失 scope → next(AppError FORBIDDEN)', () => {
    const spy = { calls: [] as any[] };
    const wrapped = (...args: any[]) => { spy.calls.push(args); };
    requireScope('role.manage')({} as any, mockRes(['ticket.manage']) as any, wrapped as any);
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0][0] instanceof AppError).toBe(true);
    expect((spy.calls[0][0] as AppError).code).toBe('FORBIDDEN');
  });
});
