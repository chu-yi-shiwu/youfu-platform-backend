// 角色鉴权中间件（批次 A2 升级：轻量 RBAC）。
// - requireConfigRole：保持向后兼容（admin/operator 可写管理类资源），不改动既有调用点。
// - requirePermission(perm)：按角色权限点校验（默认矩阵 + 租户 role_permission 覆盖）。
// - admin 恒全放行；dev 模式放行（本地联调）。
import { AppError } from './error.js';
import type { PoolClient } from 'pg';
import type { AuthLocals } from './auth.js';

// AL-002 修复（2026-09-04）：补 reviewer / service_desk 两角色。
// 背景：workflow_def allowedRoles 与 stateMachine 转移（accept/dispatch/forward/claim 用
// service_desk；approve/reject 用 reviewer）早已引用这两角色，workOrder 抢单门禁也含
// service_desk，但账号层（z.enum / AccountRole / DB CHECK）建不出 → 审核支线实际仅 admin
// 可做。此处 ROLES 为角色单一事实源，account.ts/accounts.ts/auth.ts 均派生自本清单。
export const ROLES = ['admin', 'operator', 'dispatcher', 'worker', 'reviewer', 'service_desk'] as const;
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
  // 批次三 卡4：结算三凭证（读列表/详情/导出 = settlement.read；建/改/删/确认 = settlement.edit）
  'settlement.read',
  'settlement.edit',
] as const;
export type Perm = (typeof PERMS)[number];

// 默认权限矩阵（内置；租户可经 role_permission 表覆盖）。
// 新角色按最小权限给默认：reviewer 审核工单（看板+工单）；service_desk 接线派单（+派单覆盖）。
// 批次三：settlement.read（列表/详情/导出）默认 admin/operator；settlement.edit 仅 admin；
// 其余角色不给结算权限点（未覆盖存量租户随默认矩阵自动生效，批次二已实证该机制）。
export const DEFAULT_PERM_MATRIX: Record<Role, readonly Perm[]> = {
  admin: [...PERMS],
  operator: ['dashboard.view', 'intake.create', 'ticket.manage', 'basicdata.edit', 'dispatch.override', 'inspect.execute', 'asset.scan', 'settlement.read'],
  dispatcher: ['dashboard.view', 'ticket.manage', 'dispatch.override', 'inspect.execute', 'asset.scan'],
  worker: ['inspect.execute', 'asset.scan'],
  reviewer: ['dashboard.view', 'ticket.manage'],
  service_desk: ['dashboard.view', 'ticket.manage', 'dispatch.override'],
};

// 角色层级（数值越大权限越高）；用于账户写接口的"不可越级/不可提权"门禁。
// service_desk 与 dispatcher 同层（2）：接线派单属执行管理层；reviewer 与 operator 同层（3）：
// 质量审核属管理动作。同层仅影响 canAssignRole 的 <= 比较，不破坏 worker<dispatcher<operator<admin 严格序。
export const ROLE_RANK: Record<Role, number> = {
  worker: 1,
  service_desk: 2,
  dispatcher: 2,
  reviewer: 3,
  operator: 3,
  admin: 4,
};

// —— 角色分组（单一事实源，架构🟡12）——
// 此前 'admin'/'operator' 这类角色名以字面量散落在 config.ts / llmUsage.ts / accounts.ts /
// workOrder.ts 等处，新增角色要改 N 处。集中到这里，各处只引用分组常量与判定函数。
/** 管理配置类资源（派单规则 / 术语 / 系统配置 / 账户写）的角色：admin 全权 + operator 业务配置。 */
export const CONFIG_ROLES: readonly Role[] = ['admin', 'operator'];
/** 运维类后台动作（SLA 扫描 / 通知自检 / 巡检报表导出）的角色：一线 worker / reviewer 不参与。 */
export const OPS_ROLES: readonly Role[] = ['admin', 'operator', 'dispatcher'];

/** admin 判定：按 ROLE_RANK 取最高层级（admin=4 且唯一），避免 role === 'admin' 字面量散落。 */
export function isAdmin(role: string | undefined): boolean {
  if (!role) return false;
  return (ROLE_RANK[role as Role] ?? 0) >= ROLE_RANK.admin;
}
/** 配置类角色判定（与 requireConfigRole 同口径）。 */
export function isConfigRole(role: string | undefined): boolean {
  return !!role && CONFIG_ROLES.includes(role as Role);
}
/** 运维类角色判定。 */
export function isOpsRole(role: string | undefined): boolean {
  return !!role && OPS_ROLES.includes(role as Role);
}
/** admin 判定的"含 dev 放行"版（dev 模式恒 true，与既有 dev 约定一致）。 */
export function isAdminOrDev(auth: AuthLocals): boolean {
  return auth.authMode === 'dev' || isAdmin(auth.role);
}
/** admin 门禁：非 admin → 403。 */
export function assertAdmin(auth: AuthLocals, message = 'admin only'): void {
  if (!isAdminOrDev(auth)) throw new AppError('FORBIDDEN', message, 403);
}
/**
 * 运维后台动作门禁（QA🟡7 / 架构🟡12）：非运维角色 → 403。
 * 用途：/sla/scan、/open/notify/selftest 等会真实消耗外部配额或改动全租户数据的端点。
 */
export function assertOpsRole(auth: AuthLocals): void {
  if (auth.authMode === 'dev') return;
  if (!isOpsRole(auth.role)) {
    throw new AppError('FORBIDDEN', `role ${auth.role ?? '(none)'} not allowed for this operation`, 403);
  }
}

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

/**
 * 权限守卫（async，需在 withTenantClient 内调用）：无权限抛 403。
 * 审查修复（架构🔴1⑤）：参数类型由 string 收紧为 Perm——编译期就暴露拼错/未登记的权限点
 * （此前传入 'settlment.read' 这类错字也能通过编译，运行期恒 403 且难排查）。
 */
export async function requirePermission(auth: AuthLocals, client: PoolClient, perm: Perm): Promise<void> {
  if (!(await hasPerm(auth, client, perm))) {
    throw new AppError('FORBIDDEN', `permission denied: ${perm}`, 403);
  }
}

/**
 * 旧守卫（同步、throw）：admin/operator 可管理配置类资源。保持兼容。
 * 审查修复（架构🟡12）：白名单改引 CONFIG_ROLES 单一事实源（不再内联 role !== 'admin' && ...）。
 */
export function requireConfigRole(_req: unknown, res: any): void {
  const role = res.locals.auth.role;
  if (!isConfigRole(role)) {
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
