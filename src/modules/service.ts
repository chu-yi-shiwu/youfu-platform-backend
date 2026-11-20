// 模块授权服务：租户默认全开；部门只能在租户已启用范围内进一步收紧。
// 数据来源：tenant_module / department_module 只存“覆盖行”，无行 = 继承默认（启用）。
import type { PoolClient } from 'pg';
import type { AuthLocals } from '../middleware/auth.js';
import { AppError } from '../middleware/error.js';
import { canAssignRole, DEFAULT_PERM_MATRIX, PERMS, permBase, requirePermission } from '../middleware/role.js';
import { isRoleUsable, listAllRoles } from '../repo/roleDef.js';
import { MODULE_DEFS, MODULE_KEYS, moduleLabel } from './catalog.js';

export interface ModuleItem {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
}

export interface DepartmentModuleItem extends ModuleItem {
  tenant_enabled: boolean;
  /** 部门覆盖值；null = 未覆盖、继承租户 */
  override: boolean | null;
  effective: boolean;
}

async function tenantModuleMap(client: PoolClient, tenantId: string): Promise<Map<string, boolean>> {
  const r = await client.query(`SELECT module_key, enabled FROM tenant_module WHERE tenant_id=$1`, [tenantId]);
  return new Map(r.rows.map((row: { module_key: string; enabled: boolean }) => [row.module_key, row.enabled]));
}

async function departmentModuleMap(client: PoolClient, tenantId: string, departmentId: string): Promise<Map<string, boolean>> {
  const r = await client.query(
    `SELECT module_key, enabled FROM department_module WHERE tenant_id=$1 AND department_id=$2`,
    [tenantId, departmentId],
  );
  return new Map(r.rows.map((row: { module_key: string; enabled: boolean }) => [row.module_key, row.enabled]));
}

export async function tenantModules(client: PoolClient, tenantId: string): Promise<ModuleItem[]> {
  const map = await tenantModuleMap(client, tenantId);
  return MODULE_DEFS.map((m) => ({ ...m, enabled: map.get(m.key) ?? true }));
}

export async function departmentModules(
  client: PoolClient,
  tenantId: string,
  departmentId: string,
): Promise<DepartmentModuleItem[]> {
  const [tenantMap, deptMap] = await Promise.all([
    tenantModuleMap(client, tenantId),
    departmentModuleMap(client, tenantId, departmentId),
  ]);
  return MODULE_DEFS.map((m) => {
    const tenantEnabled = tenantMap.get(m.key) ?? true;
    const override = deptMap.has(m.key) ? deptMap.get(m.key)! : null;
    const effective = tenantEnabled && (override ?? true);
    return { ...m, enabled: effective, tenant_enabled: tenantEnabled, override, effective };
  });
}

/** 当前登录人所属部门（worker.account_id 关联登录账号；无则 null）。 */
export async function userDepartmentId(
  client: PoolClient,
  tenantId: string,
  userId: string | undefined,
): Promise<string | null> {
  if (!userId) return null;
  const r = await client.query(
    `SELECT department_id FROM worker WHERE tenant_id=$1 AND account_id=$2::text AND department_id IS NOT NULL LIMIT 1`,
    [tenantId, userId],
  );
  return (r.rows[0]?.department_id as string | undefined) ?? null;
}

/**
 * 当前用户可见模块：
 * - 租户模块是所有用户的硬上限；
 * - 部门模块只对部门成员进一步收紧；
 * - admin 不受部门收紧影响（租户管理员始终能管理全租户），但仍受租户开关约束。
 */
export async function userModuleKeys(
  client: PoolClient,
  tenantId: string,
  userId: string | undefined,
  role: string | undefined,
): Promise<string[]> {
  const [tenantMap, deptId] = await Promise.all([
    tenantModuleMap(client, tenantId),
    role === 'admin' ? Promise.resolve(null) : userDepartmentId(client, tenantId, userId),
  ]);
  const deptMap = deptId ? await departmentModuleMap(client, tenantId, deptId) : new Map<string, boolean>();
  return MODULE_KEYS.filter((key) => (tenantMap.get(key) ?? true) && (deptMap.get(key) ?? true));
}

export function assertModuleKeys(items: Array<{ key: string }>): void {
  const bad = items.map((i) => i.key).filter((k) => !MODULE_KEYS.includes(k));
  if (bad.length > 0) {
    throw new AppError('BAD_MODULE', `未知模块：${[...new Set(bad)].join('、')}`, 400);
  }
  const dup = items.map((i) => i.key).filter((k, idx, arr) => arr.indexOf(k) !== idx);
  if (dup.length > 0) {
    throw new AppError('BAD_MODULE', `模块重复：${[...new Set(dup)].join('、')}`, 400);
  }
}

/** admin 才能配置租户模块；部门管理员不能改租户级开关。 */
export function assertTenantAdmin(auth: AuthLocals): void {
  if (auth.role !== 'admin') {
    throw new AppError('FORBIDDEN', '只有租户管理员可以配置租户模块', 403);
  }
}

/**
 * 部门管理员校验：
 * - admin 可管理任意部门；
 * - 非 admin 需 `dept.manage` 权限，且账号必须绑定该部门内的 worker。
 * 注意：`dept.manage` 由租户管理员在角色权限矩阵中授予，部门管理员不能自造权限点。
 */
export async function assertDepartmentManager(
  auth: AuthLocals,
  client: PoolClient,
  departmentId: string,
): Promise<void> {
  if (auth.role === 'admin') return;
  await requirePermission(auth, client, 'dept.manage');
  const r = await client.query(
    `SELECT 1 FROM worker
      WHERE tenant_id=$1 AND department_id=$2 AND account_id=$3::text
      LIMIT 1`,
    [auth.tenantId, departmentId, auth.userId ?? ''],
  );
  if ((r.rowCount ?? 0) === 0) {
    throw new AppError('FORBIDDEN', '只能管理本人所在部门', 403);
  }
}

/** 角色有效权限集合：role_permission 覆盖优先，否则用内置默认矩阵；自定义角色默认空集。 */
export async function rolePermSet(client: PoolClient, tenantId: string, role: string): Promise<Set<string>> {
  if (role === 'admin') return new Set(PERMS);
  const r = await client.query(`SELECT perm FROM role_permission WHERE tenant_id=$1 AND role=$2`, [tenantId, role]);
  if ((r.rowCount ?? 0) > 0) {
    return new Set(r.rows.map((row: { perm: string }) => permBase(row.perm)));
  }
  return new Set(DEFAULT_PERM_MATRIX[role as keyof typeof DEFAULT_PERM_MATRIX] ?? []);
}

/**
 * 部门管理员可分配角色：
 * - 只能从租户已有、启用中的角色里选（不能新建角色/改权限）；
 * - 不能分配 admin；
 * - 不能分配高于自己层级的角色；
 * - 非 admin 不能分配权限集合超出自己的角色（防提权）。
 */
export async function assignableRoles(
  client: PoolClient,
  tenantId: string,
  auth: AuthLocals,
): Promise<string[]> {
  const roles = await listAllRoles(client, tenantId);
  const callerPerms = auth.role === 'admin' ? null : await rolePermSet(client, tenantId, auth.role ?? '');
  const out: string[] = [];
  for (const role of roles) {
    if (role === 'admin') continue;
    if (!canAssignRole(auth.role, role)) continue;
    if (!(await isRoleUsable(client, tenantId, role))) continue;
    if (callerPerms) {
      const target = await rolePermSet(client, tenantId, role);
      if ([...target].some((p) => !callerPerms.has(p))) continue;
    }
    out.push(role);
  }
  return out;
}

export function moduleDisplayName(key: string): string {
  return moduleLabel(key);
}
