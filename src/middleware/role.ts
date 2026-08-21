// 角色鉴权中间件（批次 A2 升级：轻量 RBAC）。
// - requireConfigRole：保持向后兼容（admin/operator 可写管理类资源），不改动既有调用点。
// - requirePermission(perm)：按角色权限点校验（默认矩阵 + 租户 role_permission 覆盖）。
// - admin 恒全放行；dev 模式放行（本地联调）。
import { AppError } from './error.js';
import type { PoolClient } from 'pg';
import type { AuthLocals } from './auth.js';

export const ROLES = ['admin', 'operator', 'dispatcher', 'worker'] as const;
export type Role = (typeof ROLES)[number];

export const PERMS = [
  'dashboard.view',
  'intake.create',
  'ticket.manage',
  'workflow.edit',
  'basicdata.edit',
  'dispatch.override',
  'role.manage',
  'inspect.execute',
  'asset.scan',
  'optimize.tune',
] as const;
export type Perm = (typeof PERMS)[number];

// 默认权限矩阵（内置；租户可经 role_permission 表覆盖）
export const DEFAULT_PERM_MATRIX: Record<Role, readonly Perm[]> = {
  admin: [...PERMS],
  operator: ['dashboard.view', 'intake.create', 'ticket.manage', 'basicdata.edit', 'dispatch.override', 'inspect.execute', 'asset.scan'],
  dispatcher: ['dashboard.view', 'ticket.manage', 'dispatch.override', 'inspect.execute', 'asset.scan'],
  worker: ['inspect.execute', 'asset.scan'],
};

/** 默认矩阵判定（无租户覆盖时用）；admin 恒 true */
export function hasPermDefault(role: string | undefined, perm: string): boolean {
  if (!role) return false;
  if (role === 'admin') return true;
  return (DEFAULT_PERM_MATRIX[role as Role] ?? []).includes(perm as Perm);
}

/**
 * 租户级权限判定：role_permission 表有该租户该角色的行 → 用覆盖集合；
 * 无覆盖行 → 回退默认矩阵。admin 恒 true；dev 恒 true。
 */
export async function hasPerm(auth: AuthLocals, client: PoolClient, perm: string): Promise<boolean> {
  if (auth.authMode === 'dev') return true;
  if (auth.role === 'admin') return true;
  const r = await client.query(
    `SELECT perm FROM role_permission WHERE tenant_id = $1 AND role = $2`,
    [auth.tenantId, auth.role ?? ''],
  );
  if (r.rowCount && r.rowCount > 0) {
    const set = new Set(r.rows.map((x: { perm: string }) => x.perm));
    return set.has(perm);
  }
  return hasPermDefault(auth.role, perm);
}

/** 列出该租户该角色最终生效的全部权限点（/auth/me 与前端菜单过滤用） */
export async function listPerms(auth: AuthLocals, client: PoolClient): Promise<string[]> {
  if (auth.authMode === 'dev') return [...PERMS];
  if (auth.role === 'admin') return [...PERMS];
  const r = await client.query(
    `SELECT perm FROM role_permission WHERE tenant_id = $1 AND role = $2`,
    [auth.tenantId, auth.role ?? ''],
  );
  if (r.rowCount && r.rowCount > 0) {
    return r.rows.map((x: { perm: string }) => x.perm);
  }
  return [...(DEFAULT_PERM_MATRIX[(auth.role as Role) ?? 'worker'] ?? [])];
}

/** 权限守卫（async，需在 withTenantClient 内调用）：无权限抛 403 */
export async function requirePermission(auth: AuthLocals, client: PoolClient, perm: string): Promise<void> {
  if (!(await hasPerm(auth, client, perm))) {
    throw new AppError('FORBIDDEN', `permission denied: ${perm}`, 403);
  }
}

/** 旧守卫（同步、throw）：admin/operator 可管理配置类资源。保持兼容。 */
export function requireConfigRole(_req: unknown, res: any): void {
  const role = res.locals.auth.role;
  if (role !== 'admin' && role !== 'operator') {
    throw new AppError('FORBIDDEN', 'only admin/operator can manage', 403);
  }
}
