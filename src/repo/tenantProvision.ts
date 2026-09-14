// 新租户开通内容补全（SaaS 前置 · 2026-09-01）：此前 POST /platform/tenants 只建 registry + 复制 fault_category，
// 新机构「无人可登录、无流程可流转」——开通断链。本模块在开通事务内一次建齐最小可运行租户：
//   ① fault_category 行业分类（沿用既有模板复制逻辑，从模板源租户读）
//   ② workflow_def 业务流状态图（优先复制模板源 work_order def，保持行业流程一致；源未配置则落引擎默认 4 态）
//   ③ account_user 机构管理员（role=admin，密码 scrypt 哈希落库；自动生成时明文仅本次响应返回一次）
//   ④ 行业权限基线（注册制批次二 卡3 · 混合式）：仅当行业 preset 存在且 ≠ 默认矩阵才写 role_permission 行
//      （覆盖替换语义，落库即定格快照）；preset 缺失或与默认一致 → 0 行落库 → 继承官方推荐基线，
//      随平台升级自动受益（架构评审定案口径）。
// 诚实边界（DMR）：reporter_dict / location_dict 属机构私有数据（含手机号 PII / 机构专属位置），绝不跨租户复制。
// 事务契约：调用方持 BEGIN 后的单一 client；本函数负责 SET LOCAL app.tenant_id / SET LOCAL ROLE youfu_app 的
// 读写上下文切换（读=模板源租户，写=新租户），全成或随调用方 ROLLBACK 整体回滚。
// （架构🔴4：一律 SET LOCAL，不用会话级 SET ROLE —— 连接归还池后角色不复位会造成越权读。）
import type { PoolClient } from 'pg';
import crypto from 'node:crypto';
import { hashPassword } from '../account.js';
import { DEFAULT_WORK_ORDER_DEF } from '../engine/stateMachine.js';
import { ensureAcceptanceEdges } from '../engine/acceptanceEdges.js'; // 批次三 卡4：验收边幂等注入
import { ensureClaimHallState } from '../engine/claimHallEdges.js'; // V2-F7：抢单大厅机制态幂等注入
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
  onboardingHints: string[];              // V2-F1（租户纵切 P0-3）：开通「最后一公里」待办提示（位置字典/报修人为空）
}

export function generateAdminPassword(): string {
  return crypto.randomBytes(9).toString('base64url');
}

/**
 * 集合相等比较（无序）：判定行业 preset 是否与官方默认矩阵一致。
 * 2026-09-14 纵切① P0-1 复用：PUT /accounts/roles/:role/permissions 判定
 * 「保存值 == 默认矩阵」→ 只 DELETE 不 INSERT（保存默认值 = 删除覆盖行 = 解除定格）。
 * 生产实证：不改权限直接点保存会落 2 条与默认矩阵逐字相同的僵尸覆盖行，成因即缺少此判定。
 * 注意：本实现含长度短路（a.length !== b.length → false），调用方传入含重复项的数组时
 * 会判为"不等"而正常落行——INSERT 侧有 ON CONFLICT DO NOTHING 兜底，不会产生脏数据。
 */
export function samePermSet(a: readonly string[], b: readonly string[]): boolean {
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
    // 审查修复（架构🔴4）：SET LOCAL ROLE 替代会话级 SET ROLE——本函数在调用方 BEGIN 后的
    // 单连接事务内执行（platform.ts:139 起事务），事务结束自动复位，避免连接归还后角色泄漏。
    await client.query('SET LOCAL ROLE youfu_app');
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
    // 同上（架构🔴4）：自指路径也在调用方事务内，SET LOCAL ROLE 自动复位。
    await client.query('SET LOCAL ROLE youfu_app');
  }

  // ② 业务流状态图：模板源有则 1:1 复制（行业流程一致）；无则落引擎默认 4 态
  //   （与 getWorkflowDef 运行时兜底同口径；显式落库让租户后台可直接可视化调流程）。
  //   批次三 卡4：落库前幂等注入两条验收边（acceptance_pass / acceptance_reject，仅当不存在时），
  //   新租户开通即具备「完工验收」能力；老租户走 POST /workflow-defs/:entityType/enable-acceptance 自愿升级。
  //   审查修复（架构🟡12 · 注释诚实）：下行是 ON CONFLICT DO **NOTHING** —— 若该租户的
  //   work_order def 行已存在（重跑/重试开租户），本条被静默跳过，已有 def **不会被**补验收边。
  //   即"开通即具备验收能力"只对首次落库成立；重跑场景由 enable-acceptance 端点兜底（幂等）。
  const wfDefRaw = templateDef ?? DEFAULT_WORK_ORDER_DEF;
  // V2-F7（2026-09-14）：落库前再幂等注入抢单大厅机制态（claim_hall + 三条出边）——
  //   引擎派单未命中兜底会把单直落 claim_hall，4 态 def 租户若缺此态，出厅流转 422 卡死。
  //   开通落库即含机制态，与运行时读路径注入（workflowDef.withMechanismStates）双保险同构。
  const wfDefInjected = typeof wfDefRaw === 'string'
    ? ensureAcceptanceEdges(JSON.parse(wfDefRaw) as import('../engine/stateMachine.js').WorkflowDef).def
    : ensureAcceptanceEdges(wfDefRaw as import('../engine/stateMachine.js').WorkflowDef).def;
  const wfDef = ensureClaimHallState(wfDefInjected).def;
  if (templateDef) workflowDefSource = 'template';
  await client.query(
    `INSERT INTO workflow_def (tenant_id, entity_type, def, version) VALUES ($1, 'work_order', $2, 1)
     ON CONFLICT (tenant_id, entity_type) DO NOTHING`,
    [input.tenantId, typeof wfDef === 'string' ? wfDef : JSON.stringify(wfDef)],
  );

  // ③ 机构管理员账号
  //   审查修复（架构🟡12 · 注释诚实）：本条 INSERT **没有** ON CONFLICT——
  //   一旦同租户同名账号已存在（重跑/重试/手工补过账号），UNIQUE(tenant_id, username) 会抛 23505，
  //   经 error.ts 映射为 409，并让**整个开租户事务回滚**（②流程/④权限基线一并撤销，不留半截租户）。
  //   这是刻意的 fail-closed：宁可开不出来，也不开出一个管理员归属不清的租户；
  //   旧注释写「约束兜底」易被误读为"冲突会自动跳过"，故在此写明真实后果。
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

  // ⑤ V2-F1（租户纵切 P0-3，2026-09-14）：开通「最后一公里」待办检测。
  //   四件套保证「能登录/能流转/有分类」，但 reporter_dict / location_dict 属机构私有数据
  //   （DMR 红线：含 PII，绝不跨租户复制）→ 新租户天然为空 → 报修流程实际走不通。
  //   此处在新租户 RLS 上下文内实测两张字典行数，为空则产出待办提示，由调用方
  //   （platform.ts POST /tenants）拼进响应 note——把「开通完成」与「客户能用」之间的
  //   gap 显式透出，而不是让客户第一次建单时才卡住。
  const dictCounts = await client.query<{ loc: string; rep: string }>(
    `SELECT (SELECT COUNT(*) FROM location_dict WHERE tenant_id = $1)::text AS loc,
            (SELECT COUNT(*) FROM reporter_dict WHERE tenant_id = $1)::text AS rep`,
    [input.tenantId],
  );
  const locCount = Number(dictCounts.rows[0]?.loc ?? 0);
  const repCount = Number(dictCounts.rows[0]?.rep ?? 0);
  const onboardingHints: string[] = [];
  if (locCount === 0 || repCount === 0) {
    const missing: string[] = [];
    if (locCount === 0) missing.push('位置字典');
    if (repCount === 0) missing.push('报修人名单');
    onboardingHints.push(
      `请先维护${missing.join('与')}（当前 位置字典 ${locCount} 条 / 报修人 ${repCount} 条），否则建单缺少必填关联`,
    );
  }

  return {
    categoriesCopied,
    workflowDefSource,
    adminUsername,
    adminPassword,
    permBaseline,
    permRolesSnapshotted,
    onboardingHints,
  };
}
