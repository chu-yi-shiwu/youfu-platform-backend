import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { isValidUploadFileName, buildSafeUploadPath } from '../routes/uploads.js';

beforeEach(() => {
  vi.unstubAllEnvs();
  // 用独立测试根目录，避免触碰真实 /opt/youfu/uploads
  vi.stubEnv('UPLOAD_DIR', '/tmp/youfu-uploads-test');
});

describe('isValidUploadFileName · R19-005 文件名白名单', () => {
  it('允许 uuid 形态 + 已知扩展名（含大写）', () => {
    expect(isValidUploadFileName('123e4567-e89b-12d3-a456-426614174000.jpg')).toBe(true);
    expect(isValidUploadFileName('abc-123.PNG')).toBe(true);
    expect(isValidUploadFileName('deadbeef-0.m4a')).toBe(true);
    expect(isValidUploadFileName('ab12-cd34-eff0.wav')).toBe(true);
  });

  it('拒绝任何路径/上级引用/可执行扩展名', () => {
    expect(isValidUploadFileName('../secret.png')).toBe(false);
    expect(isValidUploadFileName('a/b.png')).toBe(false);
    expect(isValidUploadFileName('a..png')).toBe(false);
    expect(isValidUploadFileName('evil.exe')).toBe(false);
    expect(isValidUploadFileName('.htaccess')).toBe(false);
    expect(isValidUploadFileName('')).toBe(false);
    expect(isValidUploadFileName('../../etc/passwd')).toBe(false);
  });
});

describe('buildSafeUploadPath · R19-005 路径穿越防御', () => {
  it('合法租户+文件名 → 返回位于 UPLOAD_ROOT/{tenant} 内的绝对路径', () => {
    const fileName = '123e4567-e89b-12d3-a456-426614174000.jpg';
    const p = buildSafeUploadPath('t-verification', fileName);
    expect(p).not.toBeNull();
    expect(path.isAbsolute(p!)).toBe(true);
    expect(path.basename(p!)).toBe(fileName);
    expect(path.basename(path.dirname(p!))).toBe('t-verification');
    expect(p).not.toContain('..');
  });

  it('非法租户名（含路径分隔符） → null', () => {
    expect(buildSafeUploadPath('a/b', 'x.png')).toBeNull();
    expect(buildSafeUploadPath('a\\b', 'x.png')).toBeNull();
    expect(buildSafeUploadPath('..', 'x.png')).toBeNull();
  });

  it('文件名带穿越字符 → null（即便租户合法）', () => {
    expect(buildSafeUploadPath('t-verification', '../x.png')).toBeNull();
    expect(buildSafeUploadPath('t-verification', '..%2f..png')).toBeNull();
    expect(buildSafeUploadPath('t-verification', 'x/../../y.jpg')).toBeNull();
  });

  it('未知扩展名 → null', () => {
    expect(buildSafeUploadPath('t-verification', 'abc.sh')).toBeNull();
    expect(buildSafeUploadPath('t-verification', 'abc.exe')).toBeNull();
  });
});
