// G1 平台认证中间件（城市级平台层 E_min）。
// 平台管理员与租户账号是两套体系：token 带 platform:true + role=platform_admin，
// 与租户 JWT（tid/role）互不干扰（R1：平台上下文独立，租户层零影响）。
// dev 模式放行（联调）；prod 强制校验 token + platform_admin.active。
import type { Request, Response, NextFunction } from 'express';
import pool from '../db/pool.js';
import { verifyJwt, AUTH_MODE } from './auth.js';

export interface PlatformAdminLocals {
  id: string;
  username: string;
  display_name: string | null;
}

declare module 'express-serve-static-core' {
  interface Locals {
    platformAdmin?: PlatformAdminLocals;
  }
}

export async function platformAdminAuth(req: Request, res: Response, next: NextFunction) {
  try {
    if (AUTH_MODE === 'dev') {
      res.locals.platformAdmin = { id: 'dev', username: 'dev', display_name: '平台管理员(dev)' };
      return next();
    }
    const auth = req.header('Authorization');
    const m = auth ? /^Bearer\s+(.+)$/i.exec(auth.trim()) : null;
    const token = m ? m[1] : null;
    if (!token) {
      return res.status(401).json({ ok: false, code: 'PLATFORM_AUTH_001', message: 'missing platform bearer token' });
    }
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ ok: false, code: 'AUTH_CFG', message: 'JWT_SECRET not configured' });
    }
    const payload = verifyJwt(token, secret);
    if (!payload || payload.platform !== true || payload.role !== 'platform_admin') {
      return res.status(401).json({ ok: false, code: 'PLATFORM_AUTH_002', message: 'invalid platform token' });
    }
    const r = await pool.query(
      `SELECT id, username, display_name FROM platform_admin WHERE id = $1 AND active = true`,
      [payload.sub],
    );
    if (r.rowCount === 0) {
      return res.status(401).json({ ok: false, code: 'PLATFORM_AUTH_003', message: 'platform admin inactive or not found' });
    }
    res.locals.platformAdmin = r.rows[0];
    return next();
  } catch (e) {
    next(e);
  }
}
