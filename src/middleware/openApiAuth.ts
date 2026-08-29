// E0_open 开放 API 认证（app_key + app_secret 双因子；scopes 校验；调用审计）。
// 与租户 JWT、平台 JWT 三套身份并行（G1 认证三层：人=JWT / 应用=AppKey / 系统=SECURITY DEFINER）。
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import pool from '../db/pool.js';
import { AppError } from './error.js';

export interface OpenApiLocals {
  app: { id: string; app_key: string; app_name: string; scopes: string[] };
}

declare module 'express-serve-static-core' {
  interface Locals {
    openApp?: OpenApiLocals['app'];
  }
}

// #5 修复：salt 环境化（APP_SECRET_SALT），默认值保持兼容；生产应配置随机值
const SECRET_SALT = process.env.APP_SECRET_SALT ?? 'youfu-app-secret-salt';

function sha256(s: string): string {
  return crypto.createHmac('sha256', SECRET_SALT).update(s).digest('hex');
}

/** 常量时间比较两段 hex（防时序旁路攻击）；长度不同直接 false。 */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** 从请求提取凭据：X-App-Key/X-App-Secret 或 Authorization: Bearer key:secret */
export function extractCreds(req: Request): { key: string; secret: string } | null {
  const k = req.header('X-App-Key');
  const s = req.header('X-App-Secret');
  if (k && s) return { key: k, secret: s };
  const auth = req.header('Authorization');
  if (auth?.startsWith('Bearer ')) {
    // 审查修复 #735-LATENT：app_secret 可能含冒号，须只切首个冒号，
    // 否则 secret 被截断→恒 AUTH_004。改用 indexOf 定位首个 ':'。
    const raw = auth.slice(7);
    const idx = raw.indexOf(':');
    if (idx > 0) {
      const key = raw.slice(0, idx);
      const secret = raw.slice(idx + 1);
      if (key && secret) return { key, secret };
    }
  }
  return null;
}

/** 开放 API 认证中间件：校验 key/secret + active + 配额(qps) + 写入调用审计。 */
export async function openApiAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const creds = extractCreds(req);
    if (!creds) throw new AppError('AUTH_001', 'missing app credentials (X-App-Key/X-App-Secret)', 401);
    const r = await pool.query(
      `SELECT id, app_key, app_name, secret_hash, scopes, quotas, status FROM open_api_app WHERE app_key = $1`,
      [creds.key],
    );
    if (r.rowCount === 0) throw new AppError('AUTH_002', 'unknown app_key', 401);
    const app = r.rows[0];
    if (app.status !== 'active') throw new AppError('AUTH_003', 'app revoked or disabled', 403);
    // 纵深防御：app_secret 比较须 timing-safe（与 auth.ts verifyJwt 一致），避免旁路时序攻击
    const provided = sha256(creds.secret);
    if (!safeEqualHex(provided, app.secret_hash ?? '')) throw new AppError('AUTH_004', 'invalid app_secret', 401);
    // 收尾#1：qps 配额校验（60s 窗口调用数 > quotas.qps → 429；未配置配额=不限制）
    const quotas = app.quotas && typeof app.quotas === 'object' ? app.quotas : {};
    const qps = Number(quotas.qps ?? 0);
    if (qps > 0) {
      const cnt = await pool.query(
        `SELECT count(*)::int AS c FROM open_api_call_log
         WHERE app_id = $1 AND at > now() - interval '60 seconds'`,
        [app.id],
      );
      if ((cnt.rows[0]?.c ?? 0) >= qps) {
        throw new AppError('RATE_LIMIT', `qps quota exceeded (${qps}/60s)`, 429);
      }
    }
    res.locals.openApp = {
      id: app.id,
      app_key: app.app_key,
      app_name: app.app_name,
      scopes: Array.isArray(app.scopes) ? app.scopes : [],
    };
    // 调用审计（append-only）；失败不阻断主流程（同 platform audit 模式）
    try {
      await pool.query(
        `INSERT INTO open_api_call_log (app_id, endpoint, method, status_code) VALUES ($1,$2,$3,$4)`,
        [app.id, req.path, req.method, 200],
      );
    } catch {
      // 审计链路故障不影响开放 API 正常响应
    }
    next();
  } catch (e) {
    next(e);
  }
}

/** 权限域校验：app 需含指定 scope。 */
export function requireScope(scope: string) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    // 中间件把 app 信息写进 res.locals.openApp（Express 4 无 req.locals，须从 res 读）
    const scopes = res.locals?.openApp?.scopes ?? [];
    if (!scopes.includes(scope) && !scopes.includes('*')) {
      next(new AppError('FORBIDDEN', `missing scope: ${scope}`, 403));
      return;
    }
    next();
  };
}
