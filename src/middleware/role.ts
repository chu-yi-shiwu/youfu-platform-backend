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

// 角色层级（数值越大权限越高）；用于账户写接口的"不可越级/不可提权"门禁。
export const ROLE_RANK: Record<Role, number> = {
  worker: 1,
  dispatcher: 2,
  operator: 3,
  admin: 4,
};

/**
 * 角色分配门禁（R15-005 修复）：账户写接口（建/改）据此阻止越级与提权。
 *   - admin 可分配任意角色（含 admin）；
 *   - operator 可分配 operator/dispatcher/worker，但**绝不可分配 admin**（防铸造管理员）；
 *   - 任何非 admin 调用方都不可分配高于自身层级的角色。
 * 说明：账户管理写接口本身由 requireConfigRole 限定为 admin/operator，
 * 本门禁进一步收窄 operator 的授权边界，消除"operator 自提权 / 铸造 admin"的内鬼路径。
 */
export function canAssignRole(caller: Role | undefined, target: Role): boolean {
  if (caller === 'admin') return true;
  const callerRank = ROLE_RANK[caller ?? 'worker'];
  const targetRank = ROLE_RANK[target];
  // 非 admin 既不能分配高于自身的角色，也绝不可分配 admin。
  return target !== 'admin' && targetRank <= callerRank;
}

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

/**
 * #583 归属守卫（异步，需在 withTenantClient 内调用）：
 * 巡检/运送执行端点（checkin/records/complete/exception/tracks/transition）权限模型：
 *  - admin / operator：恒放行（管理不受限，保持原语义）
 *  - worker：仅当任务归属本人（owner 字段 == 当前 worker.id）放行，否则 403
 *  - 孤儿任务（owner 为空）：仅 admin/operator 可操作，worker 无权（防卡死也防越权）
 * dev 模式放行（维持本地联调/测试兼容）。
 */
export async function requireAssigneeOrConfig(
  client: PoolClient,
  auth: AuthLocals,
  owner: string | null | undefined,
  label = 'task',
): Promise<void> {
  if (auth.authMode === 'dev') return;
  if (auth.role === 'admin' || auth.role === 'operator') return;
  if (auth.role !== 'worker') {
    throw new AppError('FORBIDDEN', `only admin/operator or assigned worker can operate ${label}`, 403);
  }
  const wid = auth.userId;
  if (!wid) throw new AppError('UNAUTHORIZED', 'missing identity', 401);
  if (!owner || String(owner).trim() === '') {
    // 孤儿任务：未指派，仅管理角色可操作
    throw new AppError('FORBIDDEN', `unassigned ${label}, only admin/operator can operate`, 403);
  }
  // JWT sub=account_user.id → 经 worker.account_id 反查真实 worker.id（业务编码），再比对 owner
  const r = await client.query(
    'SELECT id FROM worker WHERE tenant_id=$2 AND (account_id=$1 OR id=$1) LIMIT 1',
    [wid, auth.tenantId],
  );
  if (r.rowCount === 0) throw new AppError('FORBIDDEN', 'worker profile not found', 403);
  const myWorkerId: string = r.rows[0].id;
  if (myWorkerId !== String(owner)) {
    throw new AppError('FORBIDDEN', `${label} is assigned to another worker`, 403);
  }
}
