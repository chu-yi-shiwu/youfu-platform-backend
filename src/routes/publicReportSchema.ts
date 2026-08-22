// 报修入参 schema 与上传白名单（独立模块，便于单测；与 intakeEnrich 一致）
import { z } from 'zod';

// 上传白名单（与 B0 upload.ts 一致）
// 关键：音频与图片同为「最原始需求载体」——原文件无损耗直存（不转码、不压缩），随工单流转
export const CTYPE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  // 音频：原始录音无损耗直存（m4a/mp3/wav/ogg/webm/amr 等），不转码
  'audio/m4a': 'm4a',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/amr': 'amr',
};
export const isAudioCType = (ct: string) => ct.startsWith('audio/');

// 整改 v3.1（DMR：用最小的操作完成最全面的信息填写）：
// 前端只给「种子」——一段描述 / 一段录音 / 一张照片（任选其一，甚至只给录音或只给照片）。
// 位置/电话选填（扫码 URL 带 loc 自动带出，否则系统置「待核实」）。
// 分类/优先级/关联资产全部由服务端模型（关键词+字典）自动补全，不要求报修人选择。
// 图片与录音是最原始的需求载体：原文件无损耗作为 attachments 随工单整行流转，文字只是其派生索引。
export const attachmentSchema = z.object({
  kind: z.enum(['image', 'audio']),
  url: z.string().min(1).max(200),
  name: z.string().max(100).optional(),
  size: z.number().int().nonnegative().max(30 * 1024 * 1024).optional(),
  durationMs: z.number().int().nonnegative().max(30 * 60 * 1000).optional(),
});
export const reportSchema = z.object({
  org: z.string().min(3).max(64),          // tenant_id（扫码 URL 带）
  name: z.string().min(1).max(32).optional(), // 报修人姓名（选填）
  phone: z.string().regex(/^1\d{10}$/, '联系电话应为 11 位手机号').optional(), // 选填（用于回访）
  location: z.string().max(128).optional(), // 位置选填：扫码 URL 带 loc 自动带出；不填则系统置「待核实」
  description: z.string().max(500).optional(), // 「种子」之一：可空——允许纯语音/纯图片报修（最原始需求载体，无损耗随工单流转）
  catalog: z.string().uuid().optional(),  // 允许前端显式指定（一般留空，由服务端推断）
  attachments: z.array(attachmentSchema).max(9).optional(), // 无损耗原始媒体：图片/录音（≤9 个）
  // 合规硬护栏：提交即表示同意《隐私与录音照片留存告知》。缺省/ false 一律拒绝受理（绝不静默通过）
  consent: z.boolean().refine((v) => v === true, { message: '提交即表示同意《隐私与录音照片留存告知》' }),
}).refine(
  (b) => (b.description?.trim().length ?? 0) >= 4 || (b.attachments?.length ?? 0) > 0,
  { message: '请至少提供一段描述、一张照片或一段录音，我们才能受理' },
);
