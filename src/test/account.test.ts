import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  signLoginToken,
  toPublic,
} from '../account.js';
import { signJwt, verifyJwt } from '../middleware/auth.js';

const SECRET = 'test-secret-0123456789';

describe('account: password hashing (scrypt)', () => {
  it('hashPassword 派生格式为 scrypt$<salt>$<hash>', () => {
    const h = hashPassword('admin123!');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(h.split('$').length).toBe(3);
  });

  it('verifyPassword 对正确密码返回 true（同一密码每次盐不同但可验证）', () => {
    const pwd = 'S3cret-password';
    const h = hashPassword(pwd);
    expect(verifyPassword(pwd, h)).toBe(true);
  });

  it('verifyPassword 对错误密码返回 false', () => {
    const h = hashPassword('correct-horse');
    expect(verifyPassword('wrong-password', h)).toBe(false);
  });

  it('verifyPassword 对篡改/非法存储格式返回 false（不抛错）', () => {
    expect(verifyPassword('x', 'not-a-valid-format')).toBe(false);
    expect(verifyPassword('x', 'scrypt$zzz$')).toBe(false);
  });
});

describe('account: login token', () => {
  it('signLoginToken 产出可被 verifyJwt 校验通过的令牌，且携带 sub/tid/role/exp', () => {
    const token = signLoginToken(
      { sub: 'u-1', tid: 't-verification', role: 'admin', username: 'admin' },
      SECRET,
    );
    const p = verifyJwt(token, SECRET);
    expect(p).not.toBeNull();
    expect(p!.sub).toBe('u-1');
    expect(p!.tid).toBe('t-verification');
    expect(p!.role).toBe('admin');
    expect(typeof p!.exp).toBe('number');
  });

  it('过期令牌（exp 在过去）被 verifyJwt 拒绝', () => {
    const token = signJwt({ sub: 'u-1', tid: 't', role: 'admin', exp: 100 }, SECRET);
    expect(verifyJwt(token, SECRET)).toBeNull();
  });

  it('签名密钥不符被 verifyJwt 拒绝', () => {
    const token = signLoginToken(
      { sub: 'u-1', tid: 't', role: 'operator', username: 'op' },
      SECRET,
    );
    expect(verifyJwt(token, 'different-secret')).toBeNull();
  });
});

describe('account: toPublic 脱敏（不含 password_hash）', () => {
  it('不泄露 password_hash 字段', () => {
    const pub = toPublic({
      id: 'i',
      tenant_id: 't',
      username: 'u',
      password_hash: 'scrypt$salt$hash',
      display_name: 'D',
      role: 'operator',
      active: true,
    });
    expect((pub as unknown as Record<string, unknown>).password_hash).toBeUndefined();
    expect(pub.username).toBe('u');
  });
});
