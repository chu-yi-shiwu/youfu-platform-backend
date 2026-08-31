// 新租户开通内容补全（SaaS 前置 · 2026-09-01）：此前 POST /platform/tenants 只建 registry + 复制 fault_category，
// 新机构「无人可登录、无流程可流转」——开通断链。本模块在开通事务内一次建齐最小可运行租户：
//   ① fault_category 行业分类（沿用既有模板复制逻辑，从模板源租户读）
//   ② workflow_def 业务流状态图（优先复制模板源 work_order def，保持行业流程一致；源未配置则落引擎默认 4 态）
//   ③ account_user 机构管理员（role=admin，密码 scrypt 哈希落库；自动生成时明文仅本次响应返回一次）
// 诚实边界（DMR）：reporter_dict / location_dict 属机构私有数据（含手机号 PII / 机构专属位置），绝不跨租户复制。
// 事务契约：调用方持 BEGIN 后的单一 client；本函数负责 SET LOCAL app.tenant_id / SET ROLE youfu_app 的
// 读写上下文切换（读=模板源租户，写=新租户），全成或随调用方 ROLLBACK 整体回滚。
import type { PoolClient } from 'pg';
import crypto from 'node:crypto';
import { hashPassword } from '../account.js';
import { DEFAULT_WORK_ORDER_DEF } from '../engine/stateMachine.js';

export interface ProvisionInput {
  tenantId: string;      // 新租户
  name: string;          // 机构名称（管理员 display_name 用）
  sourceTenantId: string; // 行业模板源租户
  adminUsername?: string; // 缺省 'admin'
  adminPassword?: string; // 缺省自动生成（base64url 12 位）
}

export interface ProvisionResult {
  categoriesCopied: number;
  workflowDefSource: 'template' | 'default';
  adminUsername: string;
  adminPassword: string; // 明文仅经由本次返回值透出，调用方决定是否回显；DB 只存 scrypt 哈希
}

export function generateAdminPassword(): string {
  return crypto.randomBytes(9).toString('base64url');
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
  }

  // ② 业务流状态图：模板源有则 1:1 复制（行业流程一致）；无则落引擎默认 4 态
  //   （与 getWorkflowDef 运行时兜底同口径；显式落库让租户后台可直接可视化调流程）。
  const wfDef = templateDef ?? DEFAULT_WORK_ORDER_DEF;
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

  return { categoriesCopied, workflowDefSource, adminUsername, adminPassword };
}
