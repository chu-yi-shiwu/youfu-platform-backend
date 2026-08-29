// C1 自适应优化层路由：生成并应用优化决策（飞轮写回 dispatch_rule + workflow 建议落库）。
// 安全：dispatch 写回受 MODEL_AUTO_TUNE 控制（dev 默认关，只记录建议不应用，避免试点炸配置）。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { processMetrics } from '../repo/stats.js';
import { processMining } from '../repo/processMining.js';
import { AppError } from '../middleware/error.js';
import {
  generateOptimizations,
  generateMiningOptimizations,
  getModelParams,
  applyDispatchOptimizations,
  recordWorkflowRecommendations,
  applyWorkflowOptimizations,
} from '../services/optimizer.js';
import { getWorkflowDef, saveWorkflowDef } from '../engine/workflowDef.js';
import { isAutoTuneEffective } from '../repo/tenantSettings.js';
import { DEFAULT_WORK_ORDER_DEF, RICH_WORK_ORDER_DEF, type WorkflowDef } from '../engine/stateMachine.js';
import { requirePermission } from '../middleware/role.js';

const router = Router();

// 生成优化决策：dev 下仅记录 pending 建议；AUTO_TUNE=true 时应用 dispatch 写回 + 记录 workflow 建议。
router.post('/optimize/generate', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const autoTune = process.env.MODEL_AUTO_TUNE === 'true';
    const decisions = await withTenantClient(tenantId, async (client) => {
      const params = await getModelParams(client, tenantId);
      const metrics = await processMetrics(client, tenantId);
      const dec = generateOptimizations(params, metrics);
      if (autoTune) {
        await applyDispatchOptimizations(client, tenantId, dec);
        await recordWorkflowRecommendations(client, tenantId, dec);
      } else {
        for (const d of dec) {
          await client.query(
            `INSERT INTO optimization_feedback (tenant_id, scope, target, recommendation, reason, status)
             VALUES ($1, $2, $3, $4, $5, 'pending')`,
            [tenantId, d.scope, d.target, JSON.stringify(d.recommendation), d.reason],
          );
        }
      }
      const list = await client.query(
        `SELECT id, scope, target, status, reason, created_at
         FROM optimization_feedback WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [tenantId],
      );
      return list.rows;
    });
    return res.json({ ok: true, code: 0, applied: autoTune, decisions });
  } catch (e) {
    next(e);
  }
});

// ⑦P2 自适应优化飞轮：消费过程挖掘（飞轮"眼睛"）产出精确实例级优化建议并落库 pending。
// 与 /optimize/generate（粗粒度 processMetrics）互补，本接口驱动"数据→模型"方向（模数共振）。
// 安全：自动改写 workflow_def 由"自动改流程"租户开关（④）控制——GET/PUT /api/v1/auto-tune 在
//   /workflow-admin 界面自主翻转、实时生效、落库持久化；ENV MODEL_AUTO_TUNE 仅作全局覆盖/熔断。
router.post('/optimize/generate-mining', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const autoTune = await isAutoTuneEffective(tenantId);
    const entityType = typeof req.query.entityType === 'string' ? req.query.entityType : undefined;
    const daysRaw = typeof req.query.days === 'string' ? Number(req.query.days) : undefined;
    if (req.query.days !== undefined && !Number.isFinite(daysRaw)) {
      return res.status(400).json({ ok: false, code: 'BAD_PARAM', message: 'days must be a finite number' });
    }
    const decisions = await withTenantClient(tenantId, async (client) => {
      const result = await processMining(client, tenantId, { entityType, days: daysRaw });
      const dec = generateMiningOptimizations(result);
      for (const d of dec) {
        await client.query(
          `INSERT INTO optimization_feedback (tenant_id, scope, target, recommendation, reason, status)
           VALUES ($1, $2, $3, $4, $5, 'pending')`,
          [tenantId, d.scope, d.target, JSON.stringify(d.recommendation), d.reason],
        );
      }
      if (autoTune) {
        await applyWorkflowOptimizations(client, tenantId);
      }
      return dec;
    });
    return res.json({ ok: true, code: 0, applied: autoTune, generated: decisions });
  } catch (e) {
    next(e);
  }
});

// 查看优化决策（pending/applied/dismissed）。
router.get('/optimize/list', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT id, scope, target, status, recommendation, reason, created_at, applied_at
           FROM optimization_feedback WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100`,
          [tenantId],
        )
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// 查看某业务流当前状态图定义（可配置状态机 T-①）。
router.get('/workflow/def', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const entityType = (req.query.entity as string) || 'work_order';
    const def = await withTenantClient(tenantId, (client) => getWorkflowDef(client, tenantId, entityType));
    return res.json({ ok: true, code: 0, entity_type: entityType, def });
  } catch (e) {
    next(e);
  }
});

// A+ Phase5：返回可选状态图模板（默认最小 4 态 / 富 13 态 UOne 颗粒度），供薄配置器一键应用。
router.get('/workflow/templates', async (_req, res, next) => {
  try {
    return res.json({ ok: true, code: 0, default: DEFAULT_WORK_ORDER_DEF, rich: RICH_WORK_ORDER_DEF });
  } catch (e) {
    next(e);
  }
});

// A+ Phase2：管理员显式保存某业务流状态图（零代码配置 T-① 的写通道；设计支柱②）。
// 与"自动改流程"租户开关（④）解耦：此处为人工配置口径，需 admin 角色；自动改写为 optimize 飞轮路径。
// 校验：states 非空字符串数组、transitions 每项含 from/to/event；其余字段透传。
const putDefSchema = z.object({
  entity: z.string().min(1).optional(),
  def: z.object({
    initial: z.string().min(1),
    states: z.array(z.string().min(1)).min(1),
    transitions: z
      .array(
        z.object({
          from: z.string().min(1),
          to: z.string().min(1),
          event: z.string().min(1),
          requiredFields: z.array(z.string()).optional(),
          allowedRoles: z.array(z.string()).optional(),
          sideEffects: z.array(z.string()).optional(),
        }),
      )
      .optional()
      .default([]),
    config: z.record(z.string(), z.unknown()).optional(),
  }),
});

router.put('/workflow/def', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { entity, def } = putDefSchema.parse(req.body);
    const entityType = entity || 'work_order';
    // 诚实校验：所有 transition 的 from/to 必须落在 states 集合内，initial 也须在 states 内（避免写坏引擎）
    if (!def.states.includes(def.initial)) {
      throw new AppError('BAD_REQUEST', `initial "${def.initial}" not in states`, 422);
    }
    const unknown = def.transitions.filter((t) => !def.states.includes(t.from) || !def.states.includes(t.to));
    if (unknown.length) {
      throw new AppError('BAD_REQUEST', `transition references unknown state: ${JSON.stringify(unknown[0])}`, 422);
    }
    const cleanDef: WorkflowDef = {
      initial: def.initial,
      states: def.states,
      transitions: def.transitions,
      config: def.config ?? {},
    };
    const version = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'workflow.edit');
      await saveWorkflowDef(client, tenantId, entityType, cleanDef);
      const r = await client.query<{ version: number }>(
        `SELECT version FROM workflow_def WHERE tenant_id = $1 AND entity_type = $2`,
        [tenantId, entityType],
      );
      return r.rows[0]?.version ?? 1;
    });
    return res.json({ ok: true, code: 0, entity_type: entityType, version, def: cleanDef });
  } catch (e) {
    next(e);
  }
});

// 消费 workflow 类 pending 优化建议，改写 workflow_def（收口自我优化闭环）。
// 受 MODEL_AUTO_TUNE 控制（与 dispatch 写回一致）：dev 默认仅记录不应用；AUTO_TUNE=true 才真正改写流程定义。
router.post('/optimize/apply-workflow', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const autoTune = await isAutoTuneEffective(tenantId);
    if (!autoTune) {
      return res.json({
        ok: true,
        code: 0,
        applied: false,
        reason: '自动改流程未开启（租户开关关闭或全局熔断），仅记录建议不应用；在 /workflow-admin 开启开关后调用本接口才改写流程定义',
      });
    }
    const result = await withTenantClient(tenantId, (client) => applyWorkflowOptimizations(client, tenantId));
    return res.json({ ok: true, code: 0, ...result });
  } catch (e) {
    next(e);
  }
});

export default router;
