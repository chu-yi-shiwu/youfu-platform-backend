// 新租户开通内容补全（SaaS 前置 · 2026-09-01）：此前 POST /platform/tenants 只建 registry + 复制 fault_category，
// 新机构「无人可登录、无流程可流转」——开通断链。本模块在开通事务内一次建齐最小可运行租户：
//   ① fault_category 行业分类（沿用既有模板复制逻辑，从模板源租户读）
//   ② workflow_def 业务流状态图（优先复制模板源 work_order def，保持行业流程一致；源未配置则落引擎默认 4 态）
//   ③ account_user 机构管理员（role=admin，密码 scrypt 哈希落库；自动生成时明文仅本次响应返回一次）
//   ④ 行业权限基线（注册制批次二 卡3 · 混合式）：仅当行业 preset 存在且 ≠ 默认矩阵才写 role_permission 行
//      （覆盖替换语义，落库即定格快照）；preset 缺失或与默认一致 → 0 行落库 → 继承官方推荐基线，
//      随平台升级自动受益（架构评审定案口径）。
// 诚实边界（DMR）：reporter_dict / location_dict 属机构私有数据（含手机号 PII / 机构专属位置），绝不跨租户复制。
// 事务契约：调用方持 BEGIN 后的单一 client；本函数负责 SET LOCAL app.tenant_id / SET ROLE youfu_app 的
// 读写上下文切换（读=模板源租户，写=新租户），全成或随调用方 ROLLBACK 整体回滚。
import type { PoolClient } from 'pg';
import crypto from 'node:crypto';
import { hashPassword } from '../account.js';
import { DEFAULT_WORK_ORDER_DEF } from '../engine/stateMachine.js';
import { ensureAcceptanceEdges } from '../engine/acceptanceEdges.js'; // 批次三 卡4：验收边幂等注入
import { ROLES, DEFAULT_PERM_MATRIX, type Role } from '../middleware/role.js';

// 行业取值与 platform.ts 注册向导 category 枚举一致（z.enum 为事实源，此处保持同步）
export type IndustryCategory = 'hospital' | 'property' | 'school' | 'municipal' | 'other';

// 行业权限基线预设（混合式权限模型）。
// 第一版所有行业均不配置（空对象）→ 行为 = 继承官方推荐默认矩阵（DEFAULT_PERM_MATRIX）。
// 未来行业差异化时在此登记；注意：与默认矩阵一致的 preset 不会落库（见 provisionNewTenantContent 第④步），
// 只有 ≠ 默认矩阵才写 role_permission 行——落库即快照定格，不再随平台升级自动更新，请谨慎登记。
export const INDUSTRY_PERM_PRESETS: Partial<Record<IndustryCategory, Partial<Record<Role, string[]>>>> = {
  // 示例（登记即对该角色落库定格）：
  // hospital: { worker: ['inspect.execute', 'asset.scan'] },
};

export interface ProvisionInput {
  tenantId: string;      // 新租户
  name: string;          // 机构名称（管理员 display_name 用）
  sourceTenantId: string; // 行业模板源租户
  category?: IndustryCategory; // 行业（决定第④步权限基线；缺省 = 继承默认矩阵）
  adminUsername?: string; // 缺省 'admin'
  adminPassword?: string; // 缺省自动生成（base64url 12 位）
}

export interface ProvisionResult {
  categoriesCopied: number;
  workflowDefSource: 'template' | 'default';
  adminUsername: string;
  adminPassword: string; // 明文仅经由本次返回值透出，调用方决定是否回显；DB 只存 scrypt 哈希
  permBaseline: 'inherited' | 'snapshot'; // ④：inherited=继承官方推荐基线（0 行落库）；snapshot=行业基线已定格
  permRolesSnapshotted: string[];         // snapshot 时为落库定格的角色清单；inherited 时为空数组
}

export function generateAdminPassword(): string {
  return crypto.randomBytes(9).toString('base64url');
}

/** 集合相等比较（无序）：判定行业 preset 是否与官方默认矩阵一致 */
function samePermSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((p) => set.has(p));
}

export async function provisionNewTenantContent(
  client: PoolClient,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const adminUsername = input.adminUsername ?? 'admin';
  const adminPassword = input.adminPassword ?? generateAdminPassword();
  const setTenantCtx = (tenantId: string) =>
    client.query(`SET LOCAL app.tenant_id = '${tenantId.replace(/'/g, "''")}'`);

  let categoriesCopied = 0;
  let workflowDefSource: 'template' | 'default' = 'default';
  let templateDef: unknown = null;

  if (input.sourceTenantId !== input.tenantId) {
    // —— 读模板源（RLS 上下文 = 源租户）——
    await setTenantCtx(input.sourceTenantId);
    await client.query('SET ROLE youfu_app');
    const cats = await client.query(
      `SELECT code, name, sort, enabled FROM fault_category WHERE tenant_id = $1 AND enabled = true`,
      [input.sourceTenantId],
    );
    const defRow = await client.query(
      `SELECT def FROM workflow_def WHERE tenant_id = $1 AND entity_type = 'work_order' LIMIT 1`,
      [input.sourceTenantId],
    );
    templateDef = defRow.rows[0]?.def ?? null;

    // —— 写新租户（RLS WITH CHECK 保证 tenant_id=新租户）——
    await setTenantCtx(input.tenantId);
    for (const row of cats.rows) {
      const ins = await client.query(
        `INSERT INTO fault_category (id, tenant_id, code, name, sort, enabled)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, code) DO NOTHING`,
        [input.tenantId, row.code, row.name, row.sort, row.enabled],
      );
      categoriesCopied += ins.rowCount ?? 0;
    }
  } else {
    // 自指（source=自身）路径：跳过了①的读写上下文切换，必须在此补齐写上下文，
    // 保证后续 ②workflow_def / ③account_user / ④role_permission 的写入全部在 RLS 门内
    //（QA 修正：原补在④，导致自指路径下②③仍 42501）。
    await setTenantCtx(input.tenantId);
    await client.query('SET ROLE youfu_app');
  }

  // ② 业务流状态图：模板源有则 1:1 复制（行业流程一致）；无则落引擎默认 4 态
  //   （与 getWorkflowDef 运行时兜底同口径；显式落库让租户后台可直接可视化调流程）。
  //   批次三 卡4：落库前幂等注入两条验收边（acceptance_pass / acceptance_reject，仅当不存在时），
  //   新租户开通即具备「完工验收」能力；老租户走 POST /workflow-defs/:entityType/enable-acceptance 自愿升级。
  const wfDefRaw = templateDef ?? DEFAULT_WORK_ORDER_DEF;
  const wfDef = typeof wfDefRaw === 'string'
    ? ensureAcceptanceEdges(JSON.parse(wfDefRaw) as import('../engine/stateMachine.js').WorkflowDef).def
    : ensureAcceptanceEdges(wfDefRaw as import('../engine/stateMachine.js').WorkflowDef).def;
  if (templateDef) workflowDefSource = 'template';
  await client.query(
    `INSERT INTO workflow_def (tenant_id, entity_type, def, version) VALUES ($1, 'work_order', $2, 1)
     ON CONFLICT (tenant_id, entity_type) DO NOTHING`,
    [input.tenantId, typeof wfDef === 'string' ? wfDef : JSON.stringify(wfDef)],
  );

  // ③ 机构管理员账号（新租户必无同名账号，UNIQUE(tenant_id,username) 兜底）
  await client.query(
    `INSERT INTO account_user (tenant_id, username, password_hash, display_name, role, active)
     VALUES ($1, $2, $3, $4, $5, true)`,
    [input.tenantId, adminUsername, hashPassword(adminPassword), `${input.name} 管理员`, 'admin'],
  );

  // ④ 行业权限基线（混合式）：写行前 RLS 上下文必须已切到新租户——
  //   正常路径①写段已完成切换；自指路径已在①后补齐（见上方 else 分支），此处直接写。
  let permBaseline: 'inherited' | 'snapshot' = 'inherited';
  const permRolesSnapshotted: string[] = [];
  const preset = input.category ? INDUSTRY_PERM_PRESETS[input.category] : undefined;
  if (preset) {
    for (const role of ROLES) {
      if (role === 'admin') continue; // admin 恒全放行，不参与基线
      const snapshot = preset[role];
      // preset 缺失（该角色未登记）或与官方默认矩阵一致 → 不写任何行（继承基线，随平台升级自动受益）
      if (!snapshot || snapshot.length === 0 || samePermSet(snapshot, DEFAULT_PERM_MATRIX[role])) continue;
      for (const perm of snapshot) {
        await client.query(
          `INSERT INTO role_permission (tenant_id, role, perm) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, role, perm) DO NOTHING`,
          [input.tenantId, role, perm],
        );
      }
      permBaseline = 'snapshot';
      permRolesSnapshotted.push(role);
    }
  }

  return {
    categoriesCopied,
    workflowDefSource,
    adminUsername,
    adminPassword,
    permBaseline,
    permRolesSnapshotted,
  };
}
