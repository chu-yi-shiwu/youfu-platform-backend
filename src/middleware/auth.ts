// 认证/租户中间件（生产化①：AUTH_MODE=dev|prod）。
//
//  - dev  （默认）：校验 Authorization 头存在；X-Tenant-Id 缺失时落到缺省租户
//          （DEV_DEFAULT_TENANT 环境变量，未设则硬编码 `t-verification`，与种子数据对齐），
//          本地联调/前端令牌探活（只发 Bearer，不发 X-Tenant-Id）直接放行。
//  - prod ：强制校验真实 JWT（HS256，使用 Node 内置 crypto，零依赖），
//          从 token payload 取租户（tid / tenantId，缺省回退 X-Tenant-Id），
//          token 缺失/无效/过期 → 401，JWT_SECRET 未配置 → fail-closed 500。
//
//  登录源（自建账号 / 企业微信 / 微信，见生产化④待拍板项）由外部签发方生成 JWT，
//  本中间件只验不签，不臆造登录系统。
import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';

export interface AuthLocals {
  tenantId: string;
  requestId: string;
  idempotencyKey?: string;
  userId?: string;
  role?: string;
  authMode: 'dev' | 'prod';
}

declare module 'express-serve-static-core' {
  interface Locals {
    auth: AuthLocals;
  }
}

export let AUTH_MODE: 'dev' | 'prod' = 'dev';

export function refreshAuthMode(): void {
  AUTH_MODE = (process.env.AUTH_MODE ?? 'dev').toLowerCase() === 'prod' ? 'prod' : 'dev';
}

// 默认按当前环境计算一次；server.ts 在 dotenv 加载后会再次刷新
refreshAuthMode();

// 公开路径豁免（登录端点必须公开，否则永远拿不到令牌）。
// 中间件挂在 /api 下，req.path 为挂载后相对路径（如 /v1/auth/login）。
const PUBLIC_POST_PATHS = new Set(['/v1/auth/login']);
function isPublicPath(req: Request): boolean {
  return req.method === 'POST' && (PUBLIC_POST_PATHS.has(req.path) || (req.originalUrl ?? '').endsWith('/auth/login'));
}

function parseBearer(auth: string | undefined): string | null {
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1] : null;
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/**
 * 签发 JWT（HS256）。仅供本地测试与未来登录接口参考；
 * 生产环境 JWT 由外部登录系统签发，后端只验不签。
 */
export function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const body = b64url(payload);
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

/**
 * 零依赖 HS256 验证（Node crypto）。
 * 返回 payload 或 null（结构错 / 签名不符 / 已过期）。
 */
export function verifyJwt(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const exp = payload.exp;
  if (typeof exp === 'number' && exp * 1000 < Date.now()) return null;
  return payload;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  // 公开路径（登录）直接放行，不进入任何鉴权分支
  if (isPublicPath(req)) return next();

  const authorization = req.header('Authorization');
  const bearer = parseBearer(authorization);

  if (AUTH_MODE === 'prod') {
    if (!bearer) {
      return res.status(401).json({ ok: false, code: 'AUTH_001', message: 'missing Authorization bearer token' });
    }
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ ok: false, code: 'AUTH_CFG', message: 'JWT_SECRET not configured on server' });
    }
    const payload = verifyJwt(bearer, secret);
    if (!payload) {
      return res.status(401).json({ ok: false, code: 'AUTH_002', message: 'invalid or expired token' });
    }
    const tenantId = str(payload.tid) ?? str(payload.tenantId) ?? req.header('X-Tenant-Id');
    if (!tenantId) {
      return res.status(401).json({
        ok: false,
        code: 'TENANT_001',
        message: 'missing tenant (token has no tid/tenantId and no X-Tenant-Id header)',
      });
    }
    res.locals.auth = {
      tenantId,
      requestId: req.header('X-Request-Id') ?? crypto.randomUUID(),
      idempotencyKey: req.header('Idempotency-Key') ?? undefined,
      userId: str(payload.sub) ?? str(payload.uid),
      role: str(payload.role) ?? undefined,
      authMode: 'prod',
    };
    return next();
  }

  // dev 模式（默认）：仅校验头存在性，Bearer dev 放行（维持 M1 联调兼容）
  if (!authorization) {
    return res.status(401).json({ ok: false, code: 'AUTH_001', message: 'missing Authorization header' });
  }
  // 前端 Login 仅发 Bearer token、不发 X-Tenant-Id（见 client.ts）。
  // pilot 阶段缺省落到种子租户，避免 401；可用 DEV_DEFAULT_TENANT 环境变量覆盖。
  const tenantId = req.header('X-Tenant-Id') ?? process.env.DEV_DEFAULT_TENANT ?? 't-verification';
  res.locals.auth = {
    tenantId,
    requestId: req.header('X-Request-Id') ?? crypto.randomUUID(),
    idempotencyKey: req.header('Idempotency-Key') ?? undefined,
    role: req.header('X-Role') ?? 'admin',
    authMode: 'dev',
  };
  next();
}
