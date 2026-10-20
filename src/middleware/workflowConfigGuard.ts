// 流程配置权限归属闸门（097）。
//
// 【为什么要有这道闸，光靠 requirePermission 不够】
//   requirePermission → hasPerm（role.ts:235）有两条"租户自己说了算"的口子：
//     ① `auth.role === 'admin'` 恒放行（role.ts:237）——租户自己的管理员天然拥有全部权限点；
//     ② DEFAULT_PERM_MATRIX.admin = [...PERMS]（role.ts:106），新权限点自动进 admin 口袋；
//     ③ 租户还能经 role_permission 表把 workflow.edit 授给任意自建角色（role.ts:238-241）。
//   三条叠加的后果：**每家客户自己的管理员现在就能改流程，还能把权限发给任何人**。
//   在流程引擎尚未对客户开放自助配置的阶段，这是"配置权失控"面：客户改出来的流程
//   一旦和派单/结算/耗材等派生口径对不上，出问题的是我们（且难排查）。
//
// 【这道闸做什么】
//   在 requirePermission **之前**拦一道：归属 = 'platform' 时，租户侧任何身份（含 admin、
//   含被 role_permission 授权过的自建角色）调流程**写端点**一律 403。
//   归属 = 'tenant' 时整闸放行，回到原有权限点逻辑——以后要放开，拨一条配置即可，不改代码。
//
// 【不拦什么】
//   读端点（GET）一律不拦：客户要看得见自己流程长什么样、有哪些状态，否则界面没法用。
//
// 【回滚】删掉 workflowDef.ts 里 13 处 assertWorkflowConfigEditableByTenant() 调用即恢复原状，
//   或把 platform_config.workflow_config_owner 拨成 'tenant'（无需发版）。
import { AppError } from './error.js';
import { getWorkflowConfigOwner, WORKFLOW_CONFIG_OWNER_KEY } from '../repo/platformConfig.js';

export const WORKFLOW_CONFIG_PLATFORM_ONLY = 'WORKFLOW_CONFIG_PLATFORM_ONLY';

/**
 * 租户侧改流程前的归属闸门。无返回值；不满足时抛 403。
 * @param client 可选：调用方已有连接时复用（测试注入 / 同事务读取）。
 */
export async function assertWorkflowConfigEditableByTenant(client?: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ value: string }> }>;
}): Promise<void> {
  const owner = await getWorkflowConfigOwner(client);
  if (owner === 'platform') {
    throw new AppError(
      WORKFLOW_CONFIG_PLATFORM_ONLY,
      `流程配置当前由平台运维统一维护，租户侧暂不开放修改/审批；如需变更请联系平台运维（开关：${WORKFLOW_CONFIG_OWNER_KEY}）`,
      403,
    );
  }
}
