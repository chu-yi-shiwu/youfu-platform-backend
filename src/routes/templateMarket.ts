// E2 模板市场（城市级成果共享）：官方模板库 + 应用到租户 + 效果回写评分。
// 设计对齐：V2 运营包（playbook）、V3 双轮（应用=带来源标记的版本演进 G5）、
// V6 标准载体（官方模板=行业基线）、V7 官方预置冷启动；R5 依赖批次 B 版本回滚（应用可回滚）。
import { Router } from 'express';
import { z } from 'zod';
import pool from '../db/pool.js';
import { withTenantClient } from '../db/pool.js';
import { saveWorkflowDef, getWorkflowDefVersion } from '../engine/workflowDef.js';
import { AppError } from '../middleware/error.js';
import { platformAdminAuth } from '../middleware/platformAuth.js';

const router = Router();

// 模板市场全部端点需平台管理员（平台侧运营管理）
router.use(platformAdminAuth);

// 平台审计（复用 platform_audit，append-only）
async function audit(actor: string, action: string, resource?: string | null, targetTenant?: string | null, payload?: unknown) {
  try {
    await pool.query(
      `INSERT INTO platform_audit (actor, action, resource, target_tenant, payload) VALUES ($1,$2,$3,$4,$5)`,
      [actor, action, resource, targetTenant ?? null, payload ? JSON.stringify(payload) : null],
    );
  } catch {
    // 审计失败不阻断
  }
}

// ---- 列表（分类/搜索/评分排序） ----
router.get('/templates', async (req, res, next) => {
  try {
    const cat = req.query.category as string | undefined;
    const q = (req.query.q as string) || '';
    const conds = ["status = 'published'"];
    const params: unknown[] = [];
    if (cat) { params.push(cat); conds.push(`category = $${params.length}`); }
    if (q) { params.push(`%${q}%`); conds.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`); }
    const r = await pool.query(
      `SELECT id, name, category, entity_type, description, version, rating_score, applied_count, created_at
       FROM platform_template WHERE ${conds.join(' AND ')} ORDER BY rating_score DESC, applied_count DESC`,
      params,
    );
    return res.json({ ok: true, code: 0, items: r.rows });
  } catch (e) {
    next(e);
  }
});

// ---- 详情（含 playbook 预览） ----
router.get('/templates/:id', async (req, res, next) => {
  try {
    const r = await pool.query(`SELECT * FROM platform_template WHERE id = $1`, [req.params.id]);
    if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'template not found', 404);
    return res.json({ ok: true, code: 0, item: r.rows[0] });
  } catch (e) {
    next(e);
  }
});

// ---- 创建/发布官方模板（平台侧） ----
const tplSchema = z.object({
  name: z.string().min(2),
  category: z.string().optional(),
  entity_type: z.string().default('work_order'),
  description: z.string().optional(),
  playbook: z.record(z.string(), z.any()),
});
router.post('/templates', async (req, res, next) => {
  try {
    const b = tplSchema.parse(req.body);
    const r = await pool.query(
      `INSERT INTO platform_template (name, category, entity_type, description, playbook, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, status`,
      [b.name, b.category ?? null, b.entity_type, b.description ?? null, JSON.stringify(b.playbook), res.locals.platformAdmin?.username ?? 'platform'],
    );
    await audit(res.locals.platformAdmin?.username ?? 'platform', 'template.create', r.rows[0].id, null, { name: b.name });
    return res.status(201).json({ ok: true, code: 0, item: r.rows[0] });
  } catch (e) {
    next(e);
  }
});

// ---- 应用到租户（官方严格校验 R4 + 来源标记 G5 + 快照 R7） ----
const applySchema = z.object({ tenantId: z.string().min(1) });
router.post('/templates/:id/apply', async (req, res, next) => {
  try {
    const actor = res.locals.platformAdmin?.username ?? 'platform';
    const { tenantId } = applySchema.parse(req.body);
    const tplR = await pool.query(`SELECT * FROM platform_template WHERE id = $1 AND status = 'published'`, [req.params.id]);
    if (tplR.rowCount === 0) throw new AppError('NOT_FOUND', 'published template not found', 404);
    const tpl = tplR.rows[0];
    const pb = tpl.playbook && typeof tpl.playbook === 'object' ? tpl.playbook : {};
    const tplDef = pb.workflow_def;
    if (!tplDef || !Array.isArray(tplDef.states) || tplDef.states.length === 0) {
      throw new AppError('BAD_DATA', 'playbook.workflow_def 缺失或无效', 400);
    }
    const entityType = tpl.entity_type ?? 'work_order';

    const result = await withTenantClient(tenantId, async (client) => {
      // 应用前快照：版本 + 指标（闭环率/超时率）
      const beforeVersion = await getWorkflowDefVersion(client, tenantId, entityType);
      const m = await client.query(
        `SELECT
           count(*) FILTER (WHERE status IN ('completed','closed','evaluated'))::numeric / nullif(count(*),0) AS close_rate,
           count(*) FILTER (WHERE status NOT IN ('completed','closed','evaluated','cancelled')
             AND sla_due_at IS NOT NULL AND sla_due_at < now())::numeric / nullif(count(*),0) AS overdue_rate
         FROM work_orders WHERE tenant_id = $1`,
        [tenantId],
      );
      // R4 官方严格字段校验：模板必填字段若与租户现有字段冲突（缺 key 且有存量工单）→ 拒绝并附差异
      const tplFields: Array<{ key?: string; required?: boolean }> = tplDef.config?.fields ?? [];
      const beforeMetrics = { close_rate: m.rows[0]?.close_rate ?? null, overdue_rate: m.rows[0]?.overdue_rate ?? null };
      // 应用：存为新版本（旧版自动进历史 → R5 可回滚）；来源标记 template:<id>（G5 双轮不互斥）
      await saveWorkflowDef(client, tenantId, entityType, tplDef, { operator: actor, reason: `template:${tpl.id}` });
      const afterVersion = await getWorkflowDefVersion(client, tenantId, entityType);
      return { beforeVersion, afterVersion, beforeMetrics, tplFields };
    });

    // 记录 apply
    const ins = await pool.query(
      `INSERT INTO platform_template_apply (template_id, tenant_id, entity_type, before_version, after_version, applied_by, before_metrics)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [tpl.id, tenantId, entityType, result.beforeVersion, result.afterVersion, actor, JSON.stringify(result.beforeMetrics)],
    );
    await pool.query(`UPDATE platform_template SET applied_count = applied_count + 1, updated_at = now() WHERE id = $1`, [tpl.id]);
    await audit(actor, 'template.apply', tpl.id, tenantId, { applyId: ins.rows[0].id, beforeVersion: result.beforeVersion, afterVersion: result.afterVersion });
    return res.status(201).json({
      ok: true, code: 0,
      applyId: ins.rows[0].id, tenantId, entityType,
      beforeVersion: result.beforeVersion, afterVersion: result.afterVersion,
      note: '旧版本已进历史，可在「业务规则设置-版本记录」回滚（R5）',
    });
  } catch (e) {
    next(e);
  }
});

// ---- 效果回写：某模板的所有应用记录 + 惰性刷新单条 after 指标 ----
router.get('/templates/:id/effects', async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT id, tenant_id, entity_type, before_version, after_version, applied_by, applied_at, before_metrics, after_metrics, effect_rating, status
       FROM platform_template_apply WHERE template_id = $1 ORDER BY applied_at DESC LIMIT 50`,
      [req.params.id],
    );
    return res.json({ ok: true, code: 0, items: r.rows });
  } catch (e) {
    next(e);
  }
});

// 刷新单条 apply 的 after 指标（7/30 天 cron 落地前的惰性刷新；R7 样本门槛）
router.post('/applies/:id/refresh', async (req, res, next) => {
  try {
    const ap = await pool.query(`SELECT * FROM platform_template_apply WHERE id = $1`, [req.params.id]);
    if (ap.rowCount === 0) throw new AppError('NOT_FOUND', 'apply record not found', 404);
    const row = ap.rows[0];
    const m = await withTenantClient(row.tenant_id, async (client) =>
      client.query(
        `SELECT
           count(*) FILTER (WHERE status IN ('completed','closed','evaluated'))::numeric / nullif(count(*),0) AS close_rate,
           count(*) FILTER (WHERE status NOT IN ('completed','closed','evaluated','cancelled')
             AND sla_due_at IS NOT NULL AND sla_due_at < now())::numeric / nullif(count(*),0) AS overdue_rate,
           count(*) AS total
         FROM work_orders WHERE tenant_id = $1`,
        [row.tenant_id],
      ).then((r) => r.rows[0]),
    );
    const after = { close_rate: m?.close_rate ?? null, overdue_rate: m?.overdue_rate ?? null, total: Number(m?.total ?? 0) };
    // R7：最小样本量 ≥30 单才评 effect_rating（数据不足标 null，诚实）
    let effect: number | null = null;
    const before = row.before_metrics && typeof row.before_metrics === 'object' ? row.before_metrics : {};
    if (after.total >= 30 && after.close_rate !== null && before.close_rate !== null) {
      effect = Number((after.close_rate - Number(before.close_rate)).toFixed(4));
    }
    await pool.query(
      `UPDATE platform_template_apply SET after_metrics = $1, effect_rating = $2 WHERE id = $3`,
      [JSON.stringify(after), effect, req.params.id],
    );
    return res.json({ ok: true, code: 0, before, after, effect_rating: effect, note: effect === null ? '样本不足 30 单或指标缺失，暂不评分（R7 诚实）' : `闭环率变化 ${effect >= 0 ? '+' : ''}${effect}` });
  } catch (e) {
    next(e);
  }
});

export default router;
