// Base64 严格解码（共享层，2026-11-14 深度探针）。
//
// 根因：`Buffer.from(input, 'base64')` 是**宽松**解码——非法字符被静默丢弃，
// 于是 `"!!!!notbase64!!!!"` 也能“成功”落盘一个空/残缺文件，接口返回 201。
// 上传是公开可写入口，必须 fail-closed：格式不合法就 400，不能产出坏文件。
//
// 规则：仅允许标准字母表、可选末尾 `=` 填充、长度 4 的倍数（允许调用方先去除换行）。
// 解码后再回编码比对，堵住错误填充/截断输入被 Buffer 猜测修正的情况。
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function decodeBase64Strict(input: unknown): Buffer | null {
  if (typeof input !== 'string') return null;
  const s = input.replace(/\s+/g, '');
  if (s.length === 0) return null;
  if (!BASE64_RE.test(s)) return null;
  // 兼容未补齐 `=` 的客户端（浏览器/微信常见两种形态），但非法字符仍拒绝。
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const buf = Buffer.from(padded, 'base64');
  const normalized = s.replace(/=+$/, '');
  if (buf.toString('base64').replace(/=+$/, '') !== normalized) return null;
  return buf;
}
