// 模块门禁中间件：只用于“管理面”端点，不用于移动端个人任务执行。
// - 租户关闭模块：所有账号（含 admin）在该模块管理端点得到 403 MODULE_DISABLED；
// - 部门关闭模块：该部门成员（admin 除外）在管理端点得到 403；
// - 个人任务/志愿参与路由必须显式豁免，见各路由文件 allow 列表。
import type { RequestHandler } from 'express';
import type { AuthLocals } from './auth.js';
import { withTenantClient } from '../db/pool.js';
import { userModuleKeys, moduleDisplayName } from '../modules/service.js';
import { AppError } from './error.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function assertModuleEnabled(auth: AuthLocals, key: string): Promise<void> {
  // dev 模式与权限点同口径：本地开发不查模块表（部署后 prod 才执行真实门禁）。
  if (auth.authMode === 'dev') return;
  const allowed = await withTenantClient(auth.tenantId, (client) =>
    userModuleKeys(client, auth.tenantId, auth.userId, auth.role),
  );
  if (!allowed.includes(key)) {
    throw new AppError('MODULE_DISABLED', `模块未启用：${moduleDisplayName(key)}`, 403);
  }
}

/** 全路由模块门禁（仅用于纯管理面 router）。 */
export function requireModule(key: string): RequestHandler {
  return async (req, res, next) => {
    try {
      const auth = res.locals.auth as AuthLocals | undefined;
      if (!auth) return next();
      await assertModuleEnabled(auth, key);
      return next();
    } catch (e) {
      return next(e);
    }
  };
}

/**
 * 写端点模块门禁：GET/HEAD/OPTIONS 默认放行（移动端查询/扫码读取不受限）。
 * @param only  仅这些路径需要门禁（正则，相对 router 挂载路径）
 * @param allow 这些路径豁免门禁（个人任务执行/志愿参与）
 */
export function requireModuleWrites(
  key: string,
  opts?: { only?: RegExp[]; allow?: RegExp[] },
): RequestHandler {
  return async (req, res, next) => {
    try {
      if (!WRITE_METHODS.has(req.method)) return next();
      const p = req.path;
      if (opts?.only && !opts.only.some((re) => re.test(p))) return next();
      if (opts?.allow?.some((re) => re.test(p))) return next();
      const auth = res.locals.auth as AuthLocals | undefined;
      if (!auth) return next();
      await assertModuleEnabled(auth, key);
      return next();
    } catch (e) {
      return next(e);
    }
  };
}
