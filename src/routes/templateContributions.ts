// UGC 模板贡献（二期）：租户把自建流程打包提交为标准模板（status=draft 待平台审核）。
// V3 双轮另一半：租户轮（AUTO_TUNE 自优化）→ 平台轮（对比→贡献→审核→发布→分发→效果回写）。
// 挂载 /api/v1/template-contributions，走租户 JWT + requirePermission('template.contribute')（默认 admin/operator，租户可按角色授予）。
import { Router } from 'express';
import { z } from 'zod';
import pool, { withTenantClient } from '../db/pool.js';
import { getWorkflowDef } from '../engine/workflowDef.js';
import { AppError } from '../middleware/error.js';
import { requirePermission } from '../middleware/role.js';
import { recordPlatformAudit } from '../repo/platformAudit.js';

const router = Router();

const contributeSchema = z.object({
  name: z.string().min(2).max(64),
  category: z.string().max(32).optional(),
  entity_type: z.string().default('work_order'),
  description: z.string().max(500).optional(),
});

// POST /template-contributions —— 把当前租户的流程 def 打包为模板提交（draft 待审）
// 挂载 app.use('/api/v1', router) → 完整路径 /api/v1/template-contributions
// 注意：requireConfigRole 是同步校验函数（匹配时无副作用、不匹配时 throw），须处理器内显式调用（同 config.ts 模式），不能当中间件传入。
router.post('/template-contributions', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    // T8 第十五批：原 requireConfigRole（同步角色白名单、**不查权限表**）⇒ 可配置的权限点。
    //   🔴 守卫单独一个事务，**不合并进下面查 workflow_def 的事务**：
    //   原顺序是「守卫 403 → zod 422 → 业务类型未配置 400」，若把守卫塞进下面那个事务，
    //   zod 校验和业务校验就得跟着挪进去才能保序，控制流无谓地被改写（同批 14 webhook 的取舍）。
    //   单独事务 ⇒ 403 → 422 → 400 的顺序原样保持，且改动最小。
    //   本事务只为取得 client 做权限查询、不写库 ⇒ 额外的事务开销可接受。
    await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'template.contribute');
    });
    const actor = auth.username ?? auth.role;
    const b = contributeSchema.parse(req.body);

    // 审查修复：entity_type 须为租户已显式配置的业务类型（有 workflow_def 行），
    // 否则 getWorkflowDef 会回退默认 def → 误把默认流程当租户实践贡献。
    // 注意：workflow_def 有 RLS，须在 withTenantClient（租户上下文）内查询。
    const def = await withTenantClient(tenantId, async (client) => {
      const ex = await client.query(
        `SELECT 1 FROM workflow_def WHERE tenant_id = $1 AND entity_type = $2 LIMIT 1`,
        [tenantId, b.entity_type],
      );
      if (ex.rowCount === 0) {
        throw new AppError('BAD_DATA', `业务类型 ${b.entity_type} 未配置流程规则，请先保存配置后再贡献`, 400);
      }
      return getWorkflowDef(client, tenantId, b.entity_type);
    });
    if (!def || !Array.isArray(def.states) || def.states.length === 0) {
      throw new AppError('BAD_DATA', '当前流程规则无效（states 为空），无法贡献', 400);
    }
    // 打包运营包：workflow_def 为真源，其余默认（sla/terms/report 由平台审核时补充）
    const playbook = { workflow_def: def, default_fields: {}, sla: {}, dispatch: {}, terms: {}, report: {} };
    const r = await pool.query(
      `INSERT INTO platform_template (name, category, entity_type, description, playbook, status, source, contributor_tenant, created_by)
       VALUES ($1,$2,$3,$4,$5,'draft','ugc',$6,$7) RETURNING id, name, status, source`,
      [b.name, b.category ?? null, b.entity_type, b.description ?? null, JSON.stringify(playbook), tenantId, actor ?? 'tenant'],
    );
    // 审计（平台审计表 append-only）—— 统一走 repo/platformAudit.ts，不再内联重复实现
    await recordPlatformAudit(pool, {
      actor: actor ?? 'tenant',
      action: 'template.contribute',
      resource: r.rows[0].id,
      targetTenant: tenantId,
      payload: { name: b.name },
      scope: 'templateContributions',
    });
    return res.status(201).json({
      ok: true, code: 0, item: r.rows[0],
      note: '已提交为草稿，待平台审核通过后进入模板市场',
    });
  } catch (e) {
    next(e);
  }
});

export default router;
