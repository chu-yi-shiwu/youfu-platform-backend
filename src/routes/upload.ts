// B0 文件上传接口（移动 H5 拍照落库硬依赖，零新增依赖）。
// 采用 base64 JSON 上传（规避 multer 的 npm install 网络风险）：
//   前端（H5）拍照 → base64 → POST /api/v1/upload { filename, contentType, base64 }
//   后端解码 → 落盘 /opt/youfu/uploads/{tenantId}/{uuid}.{ext} → 返回公开 URL /uploads/{tenantId}/{uuid}.{ext}
//   前端再把 URL 塞进工单/报修的 data.attachments（复用现有 data 通道，零表结构改动）。
// 安全：扩展名白名单 + 5MB 上限 + 文件名仅取 uuid（防路径遍历）；租户目录隔离。
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const router = Router();

const UPLOAD_ROOT = process.env.UPLOAD_DIR ?? '/opt/youfu/uploads';
const MAX_BYTES = 5 * 1024 * 1024; // 5MB
// D1：加入语音（工人语音留言/报修语音说明）
const EXT_WHITELIST = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'm4a', 'mp3', 'wav', 'ogg'];
const CTYPE_EXT: Record<string, string> = {
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
};

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

router.post('/upload', (req, res, next) => {
  try {
    const tenantId = res.locals.auth?.tenantId;
    if (!tenantId) {
      return res.status(401).json({ ok: false, code: 'NO_TENANT', message: 'missing tenant' });
    }
    if (/[/\\]/.test(tenantId) || tenantId.includes('..')) {
      return res.status(400).json({ ok: false, code: 'BAD_TENANT', message: 'invalid tenant id' });
    }
      return res.status(401).json({ ok: false, code: 'NO_TENANT', message: 'missing tenant' });
    }
    const body = (req.body ?? {}) as { filename?: string; contentType?: string; base64?: string };
    const { filename, contentType, base64 } = body;
    if (!base64 || typeof base64 !== 'string') {
      return res.status(400).json({ ok: false, code: 'BAD_PARAM', message: 'base64 required' });
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(base64, 'base64');
    } catch {
      return res.status(400).json({ ok: false, code: 'BAD_PARAM', message: 'invalid base64' });
    }
    if (buf.length === 0 || buf.length > MAX_BYTES) {
      return res.status(413).json({ ok: false, code: 'TOO_LARGE', message: 'max 5MB' });
    }
    // 扩展名：优先从 filename 取，否则从 contentType 推导
    let ext = (typeof filename === 'string' ? path.extname(filename).replace(/^\./, '').toLowerCase() : '') || '';
    if (!ext) ext = CTYPE_EXT[contentType ?? ''] ?? 'bin';
    if (!EXT_WHITELIST.includes(ext)) {
      return res.status(400).json({ ok: false, code: 'BAD_EXT', message: 'unsupported file type' });
    }
    const dir = path.join(UPLOAD_ROOT, tenantId);
    ensureDir(dir);
    const savedName = `${crypto.randomUUID()}.${ext}`;
    fs.writeFileSync(path.join(dir, savedName), buf);
    const url = `/uploads/${tenantId}/${savedName}`;
    return res.json({ ok: true, code: 0, url, size: buf.length });
  } catch (e) {
    next(e);
  }
});

export default router;
