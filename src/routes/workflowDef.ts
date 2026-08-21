// 业务流程配置中心（整合方案 v2 · 缺口2"下拉生成"的落地）：
// 运营在界面选业务主题 → 生成 starter 状态机 → 微调 → 落库 workflow_def（零代码配置）。
// 读接口任意已认证用户可访问；写接口（upsert）需 admin/operator（requireConfigRole）。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requirePermission } from '../middleware/role.js';
import { getWorkflowDef, saveWorkflowDef } from '../engine/workflowDef.js';
import { THEME_TEMPLATES, themeLabel, type ThemeTemplate } from '../engine/themes.js';
import type { WorkflowDef } from '../engine/stateMachine.js';

const router = Router();

// 业务主题模板清单（下拉生成数据源）。
router.get('/themes', async (_req, res) => {
  const items: { entityType: string; name: string }[] = THEME_TEMPLATES.map((t) => ({
    entityType: t.entityType,
    name: t.name,
  }));
  return res.json({ ok: true, code: 0, items });
});

// 列出本租户所有 workflow_def（轻量：不含完整 def，供左侧列表）。
router.get('/', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT entity_type, version, def, updated_at FROM workflow_def WHERE tenant_id = $1 ORDER BY entity_type`,
          [tenantId],
        )
        .then((r) => r.rows),
    );
    const list = items.map((row: any) => {
      const def = typeof row.def === 'string' ? JSON.parse(row.def) : row.def;
      const cfg = def?.config ?? {};
      return {
        entityType: row.entity_type,
        version: row.version,
        name: themeLabel(row.entity_type, cfg?.name),
        initial: def?.initial ?? null,
        stateCount: Array.isArray(def?.states) ? def.states.length : 0,
        transitionCount: Array.isArray(def?.transitions) ? def.transitions.length : 0,
        updatedAt: row.updated_at,
      };
    });
    return res.json({ ok: true, code: 0, items: list });
  } catch (e) {
    next(e);
  }
});

// 取单个 workflow_def 的完整 def。
router.get('/:entityType', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { entityType } = req.params;
    const def = await withTenantClient(tenantId, (client) => getWorkflowDef(client, tenantId, entityType));
    return res.json({ ok: true, code: 0, entityType, def });
  } catch (e) {
    next(e);
  }
});

// upsert 单个 workflow_def（配置中心保存；写操作需 admin/operator）。
const defSchema = z.object({
  name: z.string().optional(),
  def: z
    .object({
      initial: z.string().min(1),
      states: z.array(z.string().min(1)).min(1),
      transitions: z.array(z.any()).default([]),
      config: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
});

router.put('/:entityType', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const { entityType } = req.params;
    if (!/^[a-z][a-z0-9_]*$/.test(entityType)) {
      throw new AppError('BAD_PARAM', 'entityType must match ^[a-z][a-z0-9_]*$', 400);
    }
    const b = defSchema.parse(req.body);
    const merged: WorkflowDef = {
      ...b.def,
      config: { ...(b.def.config ?? {}), ...(b.name ? { name: b.name } : {}) },
    } as WorkflowDef;
    await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'workflow.edit');
      await saveWorkflowDef(client, tenantId, entityType, merged);
    });
    return res.json({ ok: true, code: 0, entityType, version: 'incremented' });
  } catch (e) {
    next(e);
  }
});

// 从主题模板生成（下拉生成）：用主题 starter def upsert 到该 entity_type。
router.post('/generate-from-theme', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const { entityType } = z.object({ entityType: z.string().min(1) }).parse(req.body);
    const tpl: ThemeTemplate | undefined = THEME_TEMPLATES.find((t) => t.entityType === entityType);
    if (!tpl) throw new AppError('NOT_FOUND', `unknown theme: ${entityType}`, 404);
    const merged: WorkflowDef = { ...tpl.def, config: { ...(tpl.def.config ?? {}), name: tpl.name } } as WorkflowDef;
    await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'workflow.edit');
      await saveWorkflowDef(client, tenantId, entityType, merged);
    });
    return res.json({ ok: true, code: 0, entityType, name: tpl.name });
  } catch (e) {
    next(e);
  }
});

export default router;
