// 业务流程配置中心（整合方案 v2 · 缺口2"下拉生成"的落地）：
// 运营在界面选业务主题 → 生成 starter 状态机 → 微调 → 落库 workflow_def（零代码配置）。
// 读接口任意已认证用户可访问；写接口（upsert）需 admin/operator（requireConfigRole）。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requirePermission } from '../middleware/role.js';
import { getWorkflowDef, saveWorkflowDef, getWorkflowDefVersion, listWorkflowDefHistory, getWorkflowDefHistoryVersion } from '../engine/workflowDef.js';
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
      await saveWorkflowDef(client, tenantId, entityType, merged, {
        operator: auth.username,
        reason: 'manual-save',
      });
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
      await saveWorkflowDef(client, tenantId, entityType, merged, {
        operator: auth.username,
        reason: 'generate-from-theme',
      });
    });
    return res.json({ ok: true, code: 0, entityType, name: tpl.name });
  } catch (e) {
    next(e);
  }
});

// ============ S2 · 版本历史 / 差异 / 回滚 / 导入导出 ============

// 版本历史列表（含快照）。
router.get('/:entityType/versions', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { entityType } = req.params;
    if (!/^[a-z][a-z0-9_]*$/.test(entityType)) throw new AppError('BAD_PARAM', 'bad entityType', 400);
    const [current, history] = await withTenantClient(tenantId, async (client) => {
      const cur = await getWorkflowDefVersion(client, tenantId, entityType);
      const hist = await listWorkflowDefHistory(client, tenantId, entityType);
      return [cur, hist];
    });
    return res.json({ ok: true, code: 0, entityType, currentVersion: current, history });
  } catch (e) {
    next(e);
  }
});

// 查看单个历史版本快照。
router.get('/:entityType/versions/:version', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { entityType } = req.params;
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version < 1) throw new AppError('BAD_PARAM', 'bad version', 400);
    const def = await withTenantClient(tenantId, (client) =>
      getWorkflowDefHistoryVersion(client, tenantId, entityType, version),
    );
    if (!def) throw new AppError('NOT_FOUND', `version ${version} not found in history`, 404);
    return res.json({ ok: true, code: 0, entityType, version, def });
  } catch (e) {
    next(e);
  }
});

// 两版本差异（返回两版完整内容 + 顶层结构摘要，前端做并排对比）。
router.get('/:entityType/versions/:a/diff/:b', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { entityType } = req.params;
    const a = Number(req.params.a);
    const b = Number(req.params.b);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1 || a === b) {
      throw new AppError('BAD_PARAM', 'bad version pair', 400);
    }
    const defs = await withTenantClient(tenantId, async (client) => {
      const da = await getWorkflowDefHistoryVersion(client, tenantId, entityType, a);
      const db = await getWorkflowDefHistoryVersion(client, tenantId, entityType, b);
      return [da, db];
    });
    if (!defs[0] || !defs[1]) throw new AppError('NOT_FOUND', 'one of versions not found', 404);
    const summary = (d: WorkflowDef) => ({
      initial: d.initial,
      states: d.states,
      transitionCount: (d.transitions ?? []).length,
      fieldCount: Object.keys(d.config?.fields ?? {}).length,
      name: (d.config as any)?.name ?? null,
    });
    return res.json({
      ok: true,
      code: 0,
      entityType,
      from: { version: a, def: defs[0], summary: summary(defs[0]) },
      to: { version: b, def: defs[1], summary: summary(defs[1]) },
    });
  } catch (e) {
    next(e);
  }
});

// 一键回滚：把指定历史版本存为新版本（版本自增，reason=rollback）。
router.post('/:entityType/versions/:version/rollback', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const { entityType } = req.params;
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version < 1) throw new AppError('BAD_PARAM', 'bad version', 400);
    const target = await withTenantClient(tenantId, (client) =>
      getWorkflowDefHistoryVersion(client, tenantId, entityType, version),
    );
    if (!target) throw new AppError('NOT_FOUND', `version ${version} not found in history`, 404);
    await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'workflow.edit');
      await saveWorkflowDef(client, tenantId, entityType, target, {
        operator: auth.username,
        reason: `rollback-to-${version}`,
      });
    });
    return res.json({ ok: true, code: 0, entityType, rolledBackTo: version, version: 'incremented' });
  } catch (e) {
    next(e);
  }
});

// 导出当前 def（带版本与导出时间，供备份/迁移）。
router.post('/:entityType/export', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { entityType } = req.params;
    if (!/^[a-z][a-z0-9_]*$/.test(entityType)) throw new AppError('BAD_PARAM', 'bad entityType', 400);
    const [version, def] = await withTenantClient(tenantId, async (client) => {
      const v = await getWorkflowDefVersion(client, tenantId, entityType);
      const d = await getWorkflowDef(client, tenantId, entityType);
      return [v, d];
    });
    return res.json({ ok: true, code: 0, entityType, version, def, exportedAt: new Date().toISOString() });
  } catch (e) {
    next(e);
  }
});

// 导入 def（校验后存为新版本，reason=import；来源标记 G5）。
router.post('/:entityType/import', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const { entityType } = req.params;
    if (!/^[a-z][a-z0-9_]*$/.test(entityType)) throw new AppError('BAD_PARAM', 'bad entityType', 400);
    const b = defSchema.parse(req.body);
    const merged: WorkflowDef = {
      ...b.def,
      config: { ...(b.def.config ?? {}), ...(b.name ? { name: b.name } : {}) },
    } as WorkflowDef;
    await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'workflow.edit');
      await saveWorkflowDef(client, tenantId, entityType, merged, {
        operator: auth.username,
        reason: 'import',
      });
    });
    return res.json({ ok: true, code: 0, entityType, imported: true, version: 'incremented' });
  } catch (e) {
    next(e);
  }
});

export default router;
