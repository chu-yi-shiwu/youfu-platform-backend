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
  username?: string;
  role?: string;
  authMode: 'dev' | 'prod';
}

declare module 'express-serve-static-core' {
  interface Locals {
    auth: AuthLocals;
  }
}

export let AUTH_MODE: 'dev' | 'prod' = 'prod';

// 默认租户（与种子数据对齐）。集中一处，避免 't-verification' 字面量散落多处（C-1）。
export const DEFAULT_TENANT_ID = 't-verification';

export function refreshAuthMode(): void {
  AUTH_MODE = (process.env.AUTH_MODE ?? 'dev').toLowerCase() === 'prod' ? 'prod' : 'dev';
}

// 默认按当前环境计算一次；server.ts 在 dotenv 加载后会再次刷新
refreshAuthMode();

// 公开路径豁免（登录端点必须公开，否则永远拿不到令牌）。
// 中间件挂在 /api 下，req.path 为挂载后相对路径（如 /v1/auth/login）。
// v5.0 P0：+ /v1/auth/wx-login（微信 openid 免密登录，免登录）
const PUBLIC_POST_PATHS = new Set(['/v1/auth/login', '/v1/auth/wx-login']);
function isPublicPath(req: Request): boolean {
  return req.method === 'POST' && (PUBLIC_POST_PATHS.has(req.path) || (req.originalUrl ?? '').endsWith('/auth/login') || (req.originalUrl ?? '').endsWith('/auth/wx-login'));
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

/**
 * C-3：统一身份解析纯函数（替代 authMiddleware 内 dev/prod 两条重复分支）。
 * 主流程只调一次；返回成功 AuthLocals 或结构化失败（status/code/message），由调用方转 HTTP。
 * 行为与原内联实现逐字节等价（prod：缺 bearer→401 / 缺密钥→500 / 无效令牌→401 / 缺租户→401；
 * dev：缺 Authorization 头→401，否则落到缺省租户 + X-Role??'admin'）。
 */
type IdentityResult =
  | { ok: true; auth: AuthLocals }
  | { ok: false; status: number; code: string; message: string };

export function resolveIdentity(req: Request): IdentityResult {
  const authorization = req.header('Authorization');
  const bearer = parseBearer(authorization);
  const requestId = req.header('X-Request-Id') ?? crypto.randomUUID();
  const idempotencyKey = req.header('Idempotency-Key') ?? undefined;

  if (AUTH_MODE === 'prod') {
    if (!bearer) {
      return { ok: false, status: 401, code: 'AUTH_001', message: 'missing Authorization bearer token' };
    }
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return { ok: false, status: 500, code: 'AUTH_CFG', message: 'JWT_SECRET not configured on server' };
    }
    const payload = verifyJwt(bearer, secret);
    if (!payload) {
      return { ok: false, status: 401, code: 'AUTH_002', message: 'invalid or expired token' };
    }
    // 审查修复 #735-MEDIUM（根因）：prod 下租户只取自签名 JWT（tid/tenantId），
    // 不接受客户端可伪造的 X-Tenant-Id 头兜底，防越权 / 路径穿越写任意租户目录。
    const tenantId = str(payload.tid) ?? str(payload.tenantId);
    if (!tenantId) {
      return { ok: false, status: 401, code: 'TENANT_001', message: 'missing tenant (token has no tid/tenantId)' };
    }
    return {
      ok: true,
      auth: {
        tenantId,
        requestId,
        idempotencyKey,
        userId: str(payload.sub) ?? str(payload.uid),
        username: str(payload.username) ?? undefined,
        role: str(payload.role) ?? undefined,
        authMode: 'prod',
      },
    };
  }

  // dev 模式（默认）：仅校验头存在性，Bearer dev 放行（维持 M1 联调兼容）
  if (!authorization) {
    return { ok: false, status: 401, code: 'AUTH_001', message: 'missing Authorization header' };
  }
  // 前端 Login 仅发 Bearer token、不发 X-Tenant-Id（见 client.ts）。
  // pilot 阶段缺省落到种子租户，避免 401；可用 DEV_DEFAULT_TENANT 环境变量覆盖。
  const tenantId = req.header('X-Tenant-Id') ?? process.env.DEV_DEFAULT_TENANT ?? DEFAULT_TENANT_ID;
  return {
    ok: true,
    auth: {
      tenantId,
      requestId,
      idempotencyKey,
      role: req.header('X-Role') ?? 'admin',
      authMode: 'dev',
    },
  };
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  // 公开路径（登录）直接放行，不进入任何鉴权分支
  if (isPublicPath(req)) return next();

  const result = resolveIdentity(req);
  if (!result.ok) {
    return res.status(result.status).json({ ok: false, code: result.code, message: result.message });
  }
  res.locals.auth = result.auth;
  return next();
}

/**
 * S-2：登录速率限制（内存滑动窗口，单进程部署足够）。
 * 仅 prod 生效；dev 放行以免干扰本地联调与测试。
 */
// 登录限流计数（内存）。上限保护防长期运行内存无限增长（🔴 审查修复 F-D2）。
export const loginAttempts = new Map<string, number[]>();
let MAX_LOGIN_IP_ENTRIES = 100_000;
// 仅供测试注入极小上限以锁定驱逐逻辑；生产默认值不变
export function __setLoginIpCapForTest(n: number): void {
  MAX_LOGIN_IP_ENTRIES = n;
}
// 仅供测试切换认证模式以锁定限流/鉴权分支（不用于生产）。
export function __setAuthModeForTest(mode: 'dev' | 'prod'): void {
  AUTH_MODE = mode;
}
export function loginRateLimit(max = 10, windowMs = 60_000) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (AUTH_MODE !== 'prod') return next();
    const ip = (req.ip || req.socket.remoteAddress || 'unknown') as string;
    const now = Date.now();
    const arr = (loginAttempts.get(ip) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      return res.status(429).json({ ok: false, code: 'RATE_001', message: 'too many login attempts, please slow down' });
    }
    arr.push(now);
    loginAttempts.set(ip, arr);
    // 内存上限保护：超限时先清理窗口外过期项；仍超则减半（避免 Map 随独立 IP 数无限增长）
    if (loginAttempts.size > MAX_LOGIN_IP_ENTRIES) {
      const cutoff = now - windowMs;
      for (const [k, v] of loginAttempts) {
        if (v.length === 0 || v[v.length - 1] < cutoff) loginAttempts.delete(k);
      }
      if (loginAttempts.size > MAX_LOGIN_IP_ENTRIES) {
        const keys = [...loginAttempts.keys()];
        for (const k of keys.slice(0, keys.length >> 1)) loginAttempts.delete(k);
      }
    }
    next();
  };
}

/**
 * C-2：统一角色守卫（纯函数）。prod 下要求 auth.role ∈ roles；dev 放行。
 * 用法：if (!requireRole(auth, 'admin')) return res.status(403)...；
 *      取代散落的 requireAdmin / requireConfigRole 重复实现。
 */
export function requireRole(auth: AuthLocals, ...roles: string[]): boolean {
  if (auth.authMode === 'dev') return true;
  return auth.role != null && roles.includes(auth.role);
}
