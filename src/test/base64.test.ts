// Base64 严格解码（2026-11-14 深度探针 D-新5 负控制）
//
// 修复前实测：POST /upload {base64:"!!!!notbase64!!!!"} → 200，落盘坏文件。
// Buffer.from(...,'base64') 宽松解码会静默丢弃非法字符，上传入口必须 fail-closed。
import { describe, it, expect } from 'vitest';
import { decodeBase64Strict } from '../util/base64.js';

describe('decodeBase64Strict', () => {
  it('合法 base64 解码正确', () => {
    const src = Buffer.from('hello 优服家', 'utf8');
    const out = decodeBase64Strict(src.toString('base64'));
    expect(out?.toString('utf8')).toBe('hello 优服家');
  });

  it('无填充 base64 兼容', () => {
    const out = decodeBase64Strict(Buffer.from('abc').toString('base64').replace(/=+$/, ''));
    expect(out?.toString('utf8')).toBe('abc');
  });

  it('非法字符拒绝（不再静默丢弃）', () => {
    expect(decodeBase64Strict('!!!!notbase64!!!!')).toBeNull();
  });

  it('空串 / 非字符串拒绝', () => {
    expect(decodeBase64Strict('')).toBeNull();
    expect(decodeBase64Strict(undefined)).toBeNull();
    expect(decodeBase64Strict(Buffer.from('x') as unknown)).toBeNull();
  });

  it('长度被篡改的输入拒绝', () => {
    expect(decodeBase64Strict('a')).toBeNull();
    expect(decodeBase64Strict('abcde')).toBeNull();
  });
});
