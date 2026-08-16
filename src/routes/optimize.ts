// C1 自适应优化层路由：生成并应用优化决策（飞轮写回 dispatch_rule + workflow 建议落库）。
// 安全：dispatch 写回受 MODEL_AUTO_TUNE 控制（dev 默认关，只记录建议不应用，避免试点炸配置）。
import { Router } from 'express';
import { withTenantClient } from '../db/pool.js';
import { processMetrics } from '../repo/stats.js';
import { processMining } from '../repo/processMining.js';
import {
  generateOptimizations,
  generateMiningOptimizations,
  getModelParams,
  applyDispatchOptimizations,
  recordWorkflowRecommendations,
  applyWorkflowOptimizations,
} from '../services/optimizer.js';
import { getWorkflowDef } from '../engine/workflowDef.js';

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
// 安全：dev（MODEL_AUTO_TUNE 未开）仅记录建议不应用；AUTO_TUNE=true 时调用 applyWorkflowOptimizations
//   改写 workflow_def 收口闭环（与 dispatch 写回受同一开关控制，避免试点误改流程定义）。
router.post('/optimize/generate-mining', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const autoTune = process.env.MODEL_AUTO_TUNE === 'true';
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

// 消费 workflow 类 pending 优化建议，改写 workflow_def（收口自我优化闭环）。
// 受 MODEL_AUTO_TUNE 控制（与 dispatch 写回一致）：dev 默认仅记录不应用；AUTO_TUNE=true 才真正改写流程定义。
router.post('/optimize/apply-workflow', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const autoTune = process.env.MODEL_AUTO_TUNE === 'true';
    if (!autoTune) {
      return res.json({
        ok: true,
        code: 0,
        applied: false,
        reason: 'MODEL_AUTO_TUNE 未开启，仅记录建议不应用（dev 安全）；生产试点开启后调用本接口才改写流程定义',
      });
    }
    const result = await withTenantClient(tenantId, (client) => applyWorkflowOptimizations(client, tenantId));
    return res.json({ ok: true, code: 0, ...result });
  } catch (e) {
    next(e);
  }
});

export default router;
