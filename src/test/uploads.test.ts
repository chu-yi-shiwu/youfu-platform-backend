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

// ============================================================================
// 缺陷修复（2026-11）：webm / amr "能存不能读"
//
// 【修的是什么】publicReportSchema.ts:20-21 的 CTYPE_EXT 允许 audio/webm → .webm、
//   audio/amr → .amr，POST /public/upload 据此落盘并 201 返回 URL；但 uploads.ts 的
//   isValidUploadFileName 白名单与 MIME 表都没有这两个扩展名 ⇒ 之后 GET /uploads/{t}/{f}
//   被 BAD_PATH 400 拒掉 ⇒ **上传成功但永远读不回来**（静默数据丢失，不是干净的写入期报错）。
//   amr 尤其要紧：微信 wx.uploadVoice 的原始格式就是 amr（publicReportCreate.ts:54 兜底即 'amr'）。
//
// 【口径】以 schema 为准补齐 uploads.ts，不反向删 schema 的项。
// 【MIME 断言在哪】MIME 表是 uploads.ts 的模块私有常量（刻意不导出，避免扩大公开面）⇒
//   映射正确性在 upload.http.test.ts 用真实响应头验证（㉑/㉒），此处只测纯函数白名单。
// ============================================================================
describe('isValidUploadFileName · webm/amr 补齐（缺陷修复：能存不能读）', () => {
  it('允许 .webm（浏览器 MediaRecorder 录音）', () => {
    expect(isValidUploadFileName('123e4567-e89b-12d3-a456-426614174000.webm')).toBe(true);
    expect(isValidUploadFileName('deadbeef-0.webm')).toBe(true);
  });

  it('允许 .amr（微信 wx.uploadVoice 原始格式）', () => {
    expect(isValidUploadFileName('123e4567-e89b-12d3-a456-426614174000.amr')).toBe(true);
    expect(isValidUploadFileName('deadbeef-0.amr')).toBe(true);
  });

  it('大写扩展名同样放行（与既有 .PNG 同口径）', () => {
    expect(isValidUploadFileName('abc-123.WEBM')).toBe(true);
    expect(isValidUploadFileName('abc-123.AMR')).toBe(true);
  });

  it('补齐后白名单仍不放宽其它任意扩展名（安全边界未被这次修复削弱）', () => {
    expect(isValidUploadFileName('abc-123.webm.exe')).toBe(false);
    expect(isValidUploadFileName('abc-123.exe')).toBe(false);
    expect(isValidUploadFileName('abc-123.mp4')).toBe(false);
    expect(isValidUploadFileName('abc-123.aac')).toBe(false);
    expect(isValidUploadFileName('abc-123.amrw')).toBe(false);
    // 路径字符依旧被拒（正则首段只允许 hex + 连字符）
    expect(isValidUploadFileName('../abc.webm')).toBe(false);
    expect(isValidUploadFileName('a/b.amr')).toBe(false);
  });
});

describe('buildSafeUploadPath · webm/amr 可落盘路径（端到端读回链路的前半段）', () => {
  it('合法租户 + .webm/.amr → 返回位于 UPLOAD_ROOT/{tenant} 内的绝对路径', () => {
    for (const file of ['123e4567-e89b-12d3-a456-426614174000.webm', '123e4567-e89b-12d3-a456-426614174000.amr']) {
      const p = buildSafeUploadPath('t-verification', file);
      expect(p).not.toBeNull();
      expect(path.basename(p!)).toBe(file);
      expect(path.basename(path.dirname(p!))).toBe('t-verification');
    }
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
