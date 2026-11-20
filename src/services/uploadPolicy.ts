// 上传类型策略（2026-11-20）：上传、下载、资产附件三处共用同一份白名单与 MIME 映射。
// 根因：此前 upload.ts / uploads.ts / asset.ts 各自维护扩展名与 MIME，容易出现“能传不能读”或附件伪造类型。
export const UPLOAD_EXT_WHITELIST = [
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf',
  'm4a', 'mp3', 'wav', 'ogg', 'webm', 'amr',
] as const;

export type UploadExt = (typeof UPLOAD_EXT_WHITELIST)[number];

export const UPLOAD_MIME_BY_EXT: Record<UploadExt, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
  amr: 'audio/amr',
};

export const UPLOAD_EXT_BY_MIME: Record<string, UploadExt> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/amr': 'amr',
};

export function isAllowedUploadExt(ext: string): ext is UploadExt {
  return (UPLOAD_EXT_WHITELIST as readonly string[]).includes(ext.toLowerCase());
}

export function mimeForUploadExt(ext: string): string {
  const e = ext.toLowerCase();
  return isAllowedUploadExt(e) ? UPLOAD_MIME_BY_EXT[e] : 'application/octet-stream';
}

/** 从文件名取扩展名；没有扩展名时按 contentType 推导。返回 null 表示不允许。 */
export function resolveUploadExt(filename: unknown, contentType: unknown): UploadExt | null {
  const rawName = typeof filename === 'string' ? filename.trim() : '';
  const dot = rawName.lastIndexOf('.');
  const fromName = dot >= 0 ? rawName.slice(dot + 1).toLowerCase() : '';
  // 文件名带扩展名时以文件名为准：不允许“evil.exe + image/jpeg”靠 contentType 绕过白名单。
  if (fromName) return isAllowedUploadExt(fromName) ? fromName : null;
  const fromType = typeof contentType === 'string' ? UPLOAD_EXT_BY_MIME[contentType.toLowerCase()] : undefined;
  return fromType ?? null;
}

/** 只允许图片/PDF 作为“可预览”类型；音频不进入预览弹窗。 */
export function isPreviewableMime(mime: string | null | undefined): boolean {
  if (!mime) return false;
  return mime.startsWith('image/') || mime === 'application/pdf';
}
