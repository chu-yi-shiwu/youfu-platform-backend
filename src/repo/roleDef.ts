/**
 * 角色定义（role_def）仓储 —— 地基第二步：让"角色"从内置 6 个常量变成租户可配置。
 *
 * 【为什么单独成文件】
 *   role_def 由 090_role_def.sql 建立（租户级自建岗位表，RLS + 租户隔离 policy），
 *   内置 6 角色**不在**该表内（090 的 role_def_code_reserved CHECK 明令禁止占用内置 code），
 *   因此"全部可用角色" = 内置 ROLES ∪ 本租户 role_def。这个并集逻辑必须只有一处，
 *   否则又会出现"DB 放开、代码仍锁死"的老毛病（090 放宽 CHECK 后 canAssignRole 仍恒 false 即前车之鉴）。
 *
 * 【边界】
 *   - 只做查询与存在性判定，不做写（角色增删改走 accounts 路由 + role.manage 权限点）；
 *   - 所有查询经 withTenantClient 的连接（已 SET LOCAL app.tenant_id），RLS 自动生效；
 *   - 表不存在（090 未应用的库）时降级为"仅内置角色"，不得抛错打挂启动。
 */
import type { PoolClient } from 'pg';
import { isRetiredRole, ROLES } from '../middleware/role.js';

export interface RoleDefRow {
  code: string;
  name: string;
  description: string | null;
  enabled: boolean;
  sort: number;
}

/** 内置角色恒可用（不查表）。 */
export function isBuiltinRole(role: string | undefined | null): boolean {
  return !!role && (ROLES as readonly string[]).includes(role);
}

/**
 * 角色是否可**新分配**给账号（建号 / 改号的 role 字段校验口径）。
 *  - 已退场内置角色（dispatcher / service_desk）→ false（用户要求①：不再可分配）；
 *  - 其余内置角色 → true；
 *  - 自定义角色 → 必须在 role_def 中存在且启用；
 *  - 表缺失（090 未应用）→ 仅内置可用（安全降级，不抛错）。
 *
 * ⚠️ 本函数只管"能不能再分出去"，**不改动任何存量账号**——
 *    存量 dispatcher/service_desk 账号的角色值与权限原样保留，由管理员自行改派。
 */
export async function isRoleUsable(client: PoolClient, tenantId: string, role: string): Promise<boolean> {
  if (!role) return false;
  if (isBuiltinRole(role)) return !isRetiredRole(role);
  try {
    const r = await client.query(
      `SELECT 1 FROM role_def WHERE tenant_id = $1 AND code = $2 AND enabled = true LIMIT 1`,
      [tenantId, role],
    );
    return (r.rowCount ?? 0) > 0;
  } catch {
    // 090 未应用或表不可见 → 自定义角色一律不可用（fail-closed），但不得拖垮整个请求
    return false;
  }
}

/** 列出本租户启用中的自定义角色（按 sort、code 排序）；内置角色不在其中。 */
export async function listCustomRoles(client: PoolClient, tenantId: string): Promise<RoleDefRow[]> {
  try {
    const r = await client.query(
      `SELECT code, name, description, enabled, sort
         FROM role_def
        WHERE tenant_id = $1 AND enabled = true
        ORDER BY sort, code`,
      [tenantId],
    );
    return r.rows as RoleDefRow[];
  } catch {
    return [];
  }
}

/**
 * 本租户全部**可选项**角色 code = 内置（剔除已退场）+ 自定义（去重、内置在前）。
 * 用途：权限矩阵列表、角色下拉、前端菜单渲染。
 *
 * 退场的 dispatcher/service_desk 不出现在下拉里（用户要求①），
 * 但存量账号仍带着这两个角色值正常工作——下拉不可见 ≠ 存量被清理。
 */
export async function listAllRoles(client: PoolClient, tenantId: string): Promise<string[]> {
  const custom = await listCustomRoles(client, tenantId);
  const merged: string[] = ROLES.filter((r) => !isRetiredRole(r));
  for (const c of custom) if (!merged.includes(c.code)) merged.push(c.code);
  return merged;
}
