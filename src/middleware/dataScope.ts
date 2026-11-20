// 角色 → 数据范围（单一事实源）。
//
// 口径（2026-11-08 已确认）：
//   worker                 → self   （师傅：只看本人）
//   operator/admin/reviewer → tenant（运营/管理/审核：看全租户）
//   dispatcher/service_desk → tenant（已退场角色，存量 token 仍按管理侧处理）
//   自定义角色              → self   （安全默认；以后需要租户级再给 role_def 加 data_scope）
//
// 注意：这不是权限点，权限点决定“能不能做”，data scope 决定“能看哪些行”。
// 路由层不要再写 MASTER_ROLES / role === 'worker' 来决定行可见性。
import type { DataScope } from '../db/authContext.js';

const TENANT_SCOPED = new Set(['admin', 'operator', 'reviewer', 'dispatcher', 'service_desk']);

export function resolveDataScope(role: string | undefined | null): DataScope {
  if (!role) return 'self';
  if (role === 'system') return 'system';
  if (TENANT_SCOPED.has(role)) return 'tenant';
  return 'self';
}

export function isSelfScope(role: string | undefined | null): boolean {
  return resolveDataScope(role) === 'self';
}
