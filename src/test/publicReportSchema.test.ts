import { describe, it, expect } from 'vitest';
import { reportSchema, attachmentSchema, isAudioCType, CTYPE_EXT } from '../routes/publicReportSchema.js';

const ORG = 't-verification';

describe('报修附件模型（DMR：图片/录音为无损耗原始载体随工单流转）', () => {
  it('纯录音附件 + 无描述 + 同意告知 → 通过（允许只录音报修）', () => {
    const r = reportSchema.safeParse({
      org: ORG,
      consent: true,
      attachments: [{ kind: 'audio', url: '/uploads/t/abc.m4a', size: 12345, durationMs: 8000 }],
    });
    expect(r.success).toBe(true);
  });

  it('纯图片附件 + 无描述 + 同意告知 → 通过（允许只拍照报修）', () => {
    const r = reportSchema.safeParse({
      org: ORG,
      consent: true,
      attachments: [{ kind: 'image', url: '/uploads/t/abc.jpg', size: 9999 }],
    });
    expect(r.success).toBe(true);
  });

  it('录音 + 图片混合 + 描述 + 同意告知 → 通过', () => {
    const r = reportSchema.safeParse({
      org: ORG,
      consent: true,
      description: '空调漏水',
      attachments: [
        { kind: 'audio', url: '/uploads/t/a.m4a', durationMs: 5000 },
        { kind: 'image', url: '/uploads/t/b.jpg' },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('空描述且无附件（已同意告知）→ 拒绝（refine 拦截受理）', () => {
    const r = reportSchema.safeParse({ org: ORG, consent: true });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message.includes('受理'))).toBe(true);
    }
  });

  it('短描述（<4字）且无附件 → 拒绝', () => {
    const r = reportSchema.safeParse({ org: ORG, consent: true, description: '漏水' });
    expect(r.success).toBe(false);
  });

  it('附件超过 9 个 → 拒绝', () => {
    const atts = Array.from({ length: 10 }, (_, i) => ({ kind: 'image', url: `/u/${i}.jpg` }));
    const r = reportSchema.safeParse({ org: ORG, consent: true, attachments: atts });
    expect(r.success).toBe(false);
  });

  it('description 超 500 字 → 拒绝', () => {
    const r = reportSchema.safeParse({ org: ORG, consent: true, description: 'x'.repeat(501) });
    expect(r.success).toBe(false);
  });
});

describe('合规硬护栏：隐私告知同意（consent 必须为真）', () => {
  it('缺省 consent → 拒绝', () => {
    const r = reportSchema.safeParse({ org: ORG, description: '空调不制冷了' });
    expect(r.success).toBe(false);
  });

  it('consent=false → 拒绝', () => {
    const r = reportSchema.safeParse({ org: ORG, consent: false, description: '空调不制冷了' });
    expect(r.success).toBe(false);
  });

  it('consent=true（文字报修）→ 通过', () => {
    const r = reportSchema.safeParse({ org: ORG, consent: true, description: '空调不制冷了' });
    expect(r.success).toBe(true);
  });
});

describe('上传白名单 / 音频判定', () => {
  it('音频 contentType 判定正确', () => {
    expect(isAudioCType('audio/m4a')).toBe(true);
    expect(isAudioCType('audio/wav')).toBe(true);
    expect(isAudioCType('image/jpeg')).toBe(false);
  });

  it('音频扩展名映射齐全（无损耗直存，不转码）', () => {
    for (const ct of ['audio/m4a', 'audio/mp4', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm', 'audio/amr']) {
      expect(CTYPE_EXT[ct]).toBeTruthy();
    }
  });

  it('attachment.kind 非法 → 拒绝', () => {
    const r = attachmentSchema.safeParse({ kind: 'video', url: '/u/x.mp4' });
    expect(r.success).toBe(false);
  });
});
