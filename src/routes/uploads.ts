// R19-005 / R27-2：以鉴权路由取代零鉴权 express.static 静态托管。
//
// 根因：原 server.ts 用 `app.use('/uploads', express.static(UPLOAD_ROOT))` 把报修人上传的
// 语音/照片（PII，含声纹等生物特征）零鉴权暴露到公网（nginx 再 proxy_pass 到 4001）。
// 任何拿到 URL 的人都能直接下载——持 URL 即下载，构成重大隐私泄漏。
//
// 修复：删除 express.static，改为受控路由 `GET /uploads/:tenant/:file`，双通道鉴权：
//   A) 登录种下的 httpOnly cookie `youfu_dash`（JWT，同源 <img>/<audio> 自动携带）：
//      verifyJwt 成功且 token 中的 tid 等于请求 :tenant → 放行（dashboard 管理员看本租户文件）。
//   B) 公开"我的报修"页：URL 追加 `?token=<public_view_token>`（工单创建时随机生成，
//      存于 work_orders.ext.public_view_token），且该文件确属该工单附件 → 放行。
//
// URL 形态保持不变（/uploads/{tenantId}/{uuid}.{ext}），前端几乎零改动（仅 H5 我的报修追加 ?token）。
// 安全纵深：:tenant 过 isValidTenantDirName；:file 严格扩展名正则；path.resolve 后强制位于
// UPLOAD_ROOT/{tenant} 之内（防任何路径穿越）。文件以流式 + nosniff 返回，Content-Disposition: inline。
import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { verifyJwt, AUTH_MODE } from '../middleware/auth.js';
import { isValidTenantDirName, UPLOAD_ROOT } from './upload.js';
import { withTenantClient } from '../db/pool.js';

const router = Router();

// 与 upload.ts 扩展名白名单对齐（D1 含语音）。
const EXT_WHITELIST = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'pdf', 'm4a', 'mp3', 'wav', 'ogg'];
const MIME: Record<string, string> = {
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
};

/** R19-005：文件名严格白名单——仅允许 uuid 形态（hex+连字符）+ 已知扩展名，杜绝任何路径字符。 */
export function isValidUploadFileName(file: string): boolean {
  if (typeof file !== 'string' || file.length === 0 || file.length > 255) return false;
  return /^[a-f0-9-]+\.(jpg|jpeg|png|gif|webp|pdf|m4a|mp3|wav|ogg)$/i.test(file);
}

/**
 * R19-005：在已通过租户名校验的前提下，构造并校验落盘绝对路径。
 * 返回绝对路径（已 path.resolve）或 null（存在路径穿越企图）。
 * 即便 :tenant / :file 已各自校验，仍做一次 resolve 后前缀校验作为纵深防御。
 */
export function buildSafeUploadPath(tenant: string, file: string): string | null {
  if (!isValidTenantDirName(tenant) || !isValidUploadFileName(file)) return null;
  const base = path.resolve(UPLOAD_ROOT, tenant);
  const resolved = path.resolve(UPLOAD_ROOT, tenant, file);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

/** 解析 Cookie 头为键值对象（仅取需要的 youfu_dash，拒绝畸形值）。 */
function parseCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === name) {
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return null;
}

/**
 * 通道 B：view_token 匹配。验证该 token 属于某工单且其附件确实包含此文件。
 * 仅查本租户（withTenantClient 已强制 tenant 隔离）。返 true 表示放行。
 */
async function matchViewToken(tenant: string, file: string, token: string): Promise<boolean> {
  if (token.length === 0) return false;
  const target = `/uploads/${tenant}/${file}`;
  try {
    return await withTenantClient(tenant, async (client) => {
      const r = await client.query(
        `SELECT ext->'attachments' AS att FROM work_orders WHERE ext->>'public_view_token' = $1`,
        [token],
      );
      const rows = r.rows as Array<{ att: Array<{ url?: string }> | null }>;
      for (const row of rows) {
        const atts = row.att;
        if (!Array.isArray(atts)) continue;
        if (atts.some((a) => typeof a.url === 'string' && a.url.endsWith(target))) return true;
      }
      return false;
    });
  } catch {
    // DB/租户异常统一按"不匹配"处理，fail-closed。
    return false;
  }
}

async function serveUpload(req: Request, res: Response): Promise<Response | void> {
  const tenant = req.params.tenant;
  const file = req.params.file;

  const filePath = buildSafeUploadPath(tenant, file);
  if (!filePath) return res.status(400).json({ ok: false, code: 'BAD_PATH', message: 'invalid upload path' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ ok: false, code: 'NO_FILE', message: 'file not found' });

  // —— 通道 A：登录 cookie（youfu_dash）——
  let allowed = false;
  const secret = process.env.JWT_SECRET;
  const dashCookie = parseCookie(req, 'youfu_dash');
  if (secret && dashCookie) {
    const payload = verifyJwt(dashCookie, secret);
    if (payload) {
      const tid = typeof payload.tid === 'string' ? payload.tid : typeof payload.tenantId === 'string' ? payload.tenantId : undefined;
      // 仅放行"令牌所属租户 == 请求租户"，避免跨租户读取（比原设计更紧，覆盖所有合法场景）。
      if (tid === tenant) allowed = true;
    }
  }

  // —— 通道 B：公开"我的报修" view_token ——
  if (!allowed) {
    const q = req.query.token;
    let token = '';
    if (typeof q === 'string') token = q;
    else if (Array.isArray(q)) token = typeof q[0] === 'string' ? q[0] : '';
    if (token) allowed = await matchViewToken(tenant, file, token);
  }

  if (!allowed) {
    return res.status(401).json({ ok: false, code: 'UPLOAD_AUTH', message: 'unauthorized upload access' });
  }

  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  const mime = MIME[ext] ?? 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `inline; filename="${file}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');

  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  stream.pipe(res);
}

// R31-QC（2026-08-31 审查）：原 handler 是全库唯一无 try/catch 的 async 路由——Express 4 下
// 未捕获异常会挂起请求而非统一 500。主体提取为 serveUpload，此处补防御兜底（fail-closed）。
router.get('/:tenant/:file', async (req: Request, res: Response) => {
  try {
    await serveUpload(req, res);
  } catch (e) {
    console.error('[uploads] handler error', e);
    if (!res.headersSent) res.status(500).json({ ok: false, code: 'INTERNAL', message: 'internal error' });
    else res.end();
  }
});

void AUTH_MODE; // 保留引用（未来如需按模式放宽可在路由内使用；当前 fail-closed，不依赖模式）

export default router;
