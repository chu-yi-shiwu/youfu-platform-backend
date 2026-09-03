// 通用业务流路由（P3 横向克隆核心）。
// 一张 business_flow_tasks 表 + 按 entity_type 区分，流转内核统一由 workflow_def 引擎驱动。
// 当前支持：transport_task(运送) / emergency_plan(应急预案)。cycle_check 等经 config 中心生成 def 后亦可接入。
// 所有响应均附 available（availableTransitions(def, status)），前端据此动态渲染动作按钮，不硬编码状态机。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requireConfigRole } from '../middleware/role.js';
import { getWorkflowDefOrDefault } from '../engine/workflowDef.js';
import { availableTransitions, type WorkflowDef } from '../engine/stateMachine.js';
import { transitionEntity } from '../engine/transition.js';
import { TRANSPORT_DEF, EMERGENCY_DEF, themeLabel } from '../engine/themes.js';
import { emitDomainEvent } from '../db/eventBus.js';

// entity_type → 内置兜底 def（与 themes.ts 保持一致；租户经配置中心生成后优先用 DB 定义）。
const ENTITY_DEF: Record<string, WorkflowDef> = {
  transport_task: TRANSPORT_DEF,
  emergency_plan: EMERGENCY_DEF,
};
const ENTITY_RE = /^[a-z][a-z0-9_]*$/;

// 宽松兜底：无内置 def 时返回默认 4 态（DB 有配置则 getWorkflowDefOrDefault 优先 DB，
// 完全无配置的 entity 也可用默认流程跑——"零配置即可建单"而非报错）。
function fallbackFor(entityType: string): WorkflowDef {
  const d = ENTITY_DEF[entityType];
  if (d) return d;
  return { initial: 'draft', states: ['draft', 'assigned', 'processing', 'completed'], transitions: [], config: {} };
}

function authInfo(res: any): { actor: string } {
  const a = res.locals?.auth as any;
  return { actor: a?.userId ?? a?.username ?? 'user' };
}

const router = Router();

// A3 入口接线：实体类型清单（内置主题 ∪ 租户 workflow_def 已配置的 entity_type）。
// 数据源：mp entity-hub 宫格 + admin 配置中心「进入业务流」入口。label 走 themeLabel，不硬编码中文。
export async function listEntityTypes(client: any, tenantId: string) {
  const r = await client.query(
    `SELECT DISTINCT entity_type FROM workflow_def WHERE tenant_id = $1 ORDER BY entity_type`,
    [tenantId],
  );
  const configured = r.rows.map((row: any) => String(row.entity_type));
  const builtins = Object.keys(ENTITY_DEF);
  const all = Array.from(new Set([...builtins, ...configured]));
  return all.map((t) => ({ entityType: t, label: themeLabel(t), builtin: builtins.includes(t) }));
}

// 实体类型清单：GET /flow/entities → { ok, code, entities:[{entityType,label,builtin}] }
// 注意：必须注册在 /:entityType 之前，否则 'entities' 会被当成 entity_type 参数吞掉。
router.get('/entities', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const entities = await withTenantClient(tenantId, (client) => listEntityTypes(client, tenantId));
    return res.json({ ok: true, code: 0, entities });
  } catch (e) {
    next(e);
  }
});

// 列表（含每行的 available 动态动作）
router.get('/:entityType', async (req, res, next) => {
  try {
    const entityType = req.params.entityType;
    if (!ENTITY_RE.test(entityType)) throw new AppError('BAD_REQUEST', 'invalid entity_type', 400);
    const tenantId = res.locals.auth.tenantId;
    const { status } = req.query as Record<string, string>;
    const items = await withTenantClient(tenantId, async (client) => {
      const def = await getWorkflowDefOrDefault(client, tenantId, entityType, fallbackFor(entityType));
      const clauses = ['tenant_id = $1', 'entity_type = $2'];
      const params: unknown[] = [tenantId, entityType];
      if (status) {
        params.push(status);
        clauses.push(`status = $${params.length}`);
      }
      const r = await client.query(
        `SELECT * FROM business_flow_tasks WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`,
        params,
      );
      return r.rows.map((row: any) => ({ ...row, available: availableTransitions(def, row.status) }));
    });
    return res.json({ ok: true, code: 0, items, label: themeLabel(entityType) });
  } catch (e) {
    next(e);
  }
});

// 新建（status 取 def.initial，零代码落地）
router.post('/:entityType', async (req, res, next) => {
  try {
    const entityType = req.params.entityType;
    if (!ENTITY_RE.test(entityType)) throw new AppError('BAD_REQUEST', 'invalid entity_type', 400);
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = z
      .object({
        title: z.string().min(1),
        data: z.record(z.any()).optional(),
        assignee: z.string().optional(),
        location: z.string().optional(),
        scheduled_at: z.string().optional(),
      })
      .parse(req.body);
    const { actor } = authInfo(res);
    const item = await withTenantClient(tenantId, async (client) => {
      const def = await getWorkflowDefOrDefault(client, tenantId, entityType, fallbackFor(entityType));
      const r = await client.query(
        `INSERT INTO business_flow_tasks (tenant_id, entity_type, title, status, data, assignee, location, scheduled_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          tenantId,
          entityType,
          b.title,
          def.initial,
          JSON.stringify(b.data ?? {}),
          b.assignee ?? null,
          b.location ?? null,
          b.scheduled_at ?? null,
          actor,
        ],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType, entityId: row.id, type: 'create', actor: 'config_role' });
      return { ...row, available: availableTransitions(def, row.status) };
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 详情（含 available 动态动作）
router.get('/:entityType/:id', async (req, res, next) => {
  try {
    const entityType = req.params.entityType;
    if (!ENTITY_RE.test(entityType)) throw new AppError('BAD_REQUEST', 'invalid entity_type', 400);
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      const def = await getWorkflowDefOrDefault(client, tenantId, entityType, fallbackFor(entityType));
      const r = await client.query(
        `SELECT * FROM business_flow_tasks WHERE id = $1 AND tenant_id = $2 AND entity_type = $3`,
        [req.params.id, tenantId, entityType],
      );
      if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'not found', 404);
      const row = r.rows[0];
      return { ...row, available: availableTransitions(def, row.status) };
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 引擎驱动流转（event + data，requiredFields 在 def 中声明并校验）
router.post('/:entityType/:id/transition', async (req, res, next) => {
  try {
    const entityType = req.params.entityType;
    if (!ENTITY_RE.test(entityType)) throw new AppError('BAD_REQUEST', 'invalid entity_type', 400);
    const tenantId = res.locals.auth.tenantId;
    const b = z
      .object({ event: z.string().min(1), data: z.record(z.any()).optional() })
      .parse(req.body);

    const item = await withTenantClient(tenantId, async (client) => {
      const def = await getWorkflowDefOrDefault(client, tenantId, entityType, fallbackFor(entityType));
      // requiredFields 校验（引用 data 内字段）
      const cur = await client.query(
        `SELECT status FROM business_flow_tasks WHERE id = $1 AND tenant_id = $2 AND entity_type = $3`,
        [req.params.id, tenantId, entityType],
      );
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'not found', 404);
      const tr = def.transitions.find((x) => x.from === cur.rows[0].status && x.event === b.event);
      if (!tr) throw new AppError('BAD_STATE', `illegal transition ${cur.rows[0].status} --${b.event}-->`, 422);
      if (tr.requiredFields && tr.requiredFields.length) {
        const data = b.data ?? {};
        const missing = tr.requiredFields.filter((f) => data[f] == null || data[f] === '');
        if (missing.length) {
          throw new AppError('BAD_REQUEST', `missing required field: ${missing.join(',')}`, 422);
        }
      }
      const { actor } = authInfo(res);
      const row = await transitionEntity(client, tenantId, {
        table: 'business_flow_tasks',
        id: req.params.id,
        event: b.event,
        extra: b.data ?? {},
        entityType,
        fallbackDef: fallbackFor(entityType),
        actor,
      });
      return { ...row, available: availableTransitions(def, row.status) };
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

export default router;
