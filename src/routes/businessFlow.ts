// 通用业务流路由（P3 横向克隆核心）。
// 一张 business_flow_tasks 表 + 按 entity_type 区分，流转内核统一由 workflow_def 引擎驱动。
// 当前支持：transport_task(运送) / emergency_plan(应急预案)。cycle_check 等经 config 中心生成 def 后亦可接入。
// 所有响应均附 available（availableTransitions(def, status)），前端据此动态渲染动作按钮，不硬编码状态机。
//
// ─────────────────────────────────────────────────────────────────────────────
// 【S4：四个 handler 开头加查表分派】
//   `proxyFor(entityType)` 命中 registry ⇒ 走 adapter（读写该业务的**原生表**）；
//   未命中 ⇒ **原样**走 business_flow_tasks 逻辑。
//   🔴 **响应外壳 {ok, code, items/item, label} 一律不变**——代理是"换数据源"，
//      不是"换接口"；前端 BusinessFlowPage 不应感知到任何差别。
//   🔴 **未命中路径零改动**：本笔对未代理实体的行为必须逐字节不变
//      （`t5TransportProxy.http.test.ts` 里的 cycle_check 对照用例守着这点）。
import { Router } from 'express';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requirePermission, ENTITY_RE } from '../middleware/role.js';
import { getWorkflowDefOrDefault } from '../engine/workflowDef.js';
import { availableTransitions, type WorkflowDef } from '../engine/stateMachine.js';
import { transitionEntity } from '../engine/transition.js';
import { TRANSPORT_DEF, EMERGENCY_DEF, themeLabel } from '../engine/themes.js';
import { emitDomainEvent } from '../db/eventBus.js';
import { proxyFor, type FlowProxyCtx } from '../engine/flowProxy.js';
import { assertRequiredFields } from '../engine/flowRequiredFields.js';

// entity_type → 内置兜底 def（与 themes.ts 保持一致；租户经配置中心生成后优先用 DB 定义）。
const ENTITY_DEF: Record<string, WorkflowDef> = {
  transport_task: TRANSPORT_DEF,
  emergency_plan: EMERGENCY_DEF,
};
// 🔴 ENTITY_RE **不再在本文件定义**——已上收到 middleware/role.ts（全仓唯一一份）。
// 原因：T3 实例级权限要在 role.ts 里校验 `perm@entityType` 的 entityType 形状，
// 而 businessFlow 已 import role ⇒ role 不能反向 import businessFlow（运行时循环依赖），
// 只能把正则放在依赖上游。两份副本迟早漂移（此处曾与 role.ts 各留一份）。

// D2 收口名单：这些 entityType **不走通用业务流通道**，命中即 410 Gone + 指路。
// 🔴 理由（写在这里，别当小事）：`034_emergency_transport.sql:7-21` 建的 `emergency_plan`
//   表**没有 status 列**（只有 `enabled` 布尔），而 `themes.ts:38-51 EMERGENCY_DEF` 是
//   6 态状态机 ⇒ **代理无落点**（状态写不进去，流转也无意义）；
//   且应急预案本质是**知识库目录**，不是带状态的业务流，给它配 EMERGENCY_DEF 是**历史误配**。
// 🔴 **明确否决"加 status 列"方案**：触碰生产库 DDL，与"不动存量"冲突。
// 🟢 顺带：走 410 自动满足 C2 —— 应急两端本来就都叫 emergency_plan。
const RETIRED_FLOW_ENTITY: Record<string, string> = {
  emergency_plan: '/emergency/plans',
};

/** 命中收口名单 ⇒ 410 Gone（响应体指路到正确端点）。 */
function assertFlowAlive(entityType: string): void {
  const replacement = RETIRED_FLOW_ENTITY[entityType];
  if (!replacement) return;
  throw new AppError(
    'GONE',
    `${entityType} 不再走通用业务流通道：应急预案是知识库目录，不是带状态的业务流，` +
      `emergency_plan 表也没有 status 列，状态机对它无落点。请改用 ${replacement}`,
    410,
  );
}

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

/**
 * 【D2 收口】已废弃的"通用业务流入口"：命中即 **410 Gone**，并在响应体里指路到正确端点。
 *
 * 🔴 **为什么是 410 而不是代理、也不是加列**：
 *   · `034_emergency_transport.sql:7-21` 建的 `emergency_plan` 表**没有 status 列**
 *     （只有 `enabled` 布尔），而 `themes.ts:38-51 EMERGENCY_DEF` 是 6 态状态机
 *     ⇒ **代理无落点**：状态写不进去，流转也无意义。
 *   · 🔴 **明确否决"给 emergency_plan 加 status 列"**：那是生产库 DDL，与"不动存量"冲突。
 *   · 应急预案本质是**知识库目录**，不是带状态的业务流；给它配 EMERGENCY_DEF 是历史误配。
 *   ⇒ 走 410 = 把这个误配**显式关掉**，而不是继续装作它能跑。
 *
 * ⚠️ 已知连带问题（**本次不一并改，留给下一步决策**）：
 *   `listEntityTypes()`（本文件 :40）的 builtins 来自 `ENTITY_DEF`，仍**包含** emergency_plan
 *   ⇒ `GET /flow/entities` 仍会把它列出来 ⇒ mp 宫格 / admin「进入业务流」入口里
 *   仍有一个点进去就 410 的入口。要不要从清单里摘掉（会改 UI 可见项），需单独拍板。
 */
const RETIRED_FLOW_ENDPOINT: Record<string, string> = {
  emergency_plan: '/emergency/plans',
};

/** 命中废弃入口 ⇒ 410 Gone + 指路（放在四个 handler 校验之后、业务逻辑之前）。 */
function assertFlowEndpointAlive(entityType: string): void {
  const replacement = RETIRED_FLOW_ENDPOINT[entityType];
  if (!replacement) return;
  throw new AppError(
    'GONE',
    `${entityType} 不再走通用业务流通道 /flow（应急预案是知识库目录，不是带状态的业务流；` +
      `emergency_plan 表没有 status 列，状态机对它无落点）。请改用 ${replacement}`,
    410,
  );
}

/**
 * 组装代理调用上下文（四个 handler 共用）。
 * ⚠️ `client` 必须是 `withTenantClient` 事务内的那个（租户隔离 + RLS 已生效），
 *    adapter 内不得再开新连接。
 */
function proxyCtx(client: PoolClient, res: any, entityType: string): FlowProxyCtx {
  return {
    client,
    tenantId: res.locals.auth.tenantId,
    entityType,
    auth: res.locals.auth,
    actor: authInfo(res).actor,
  };
}

const router = Router();

// A3 入口接线：实体类型清单（内置主题 ∪ 租户 workflow_def 已配置的 entity_type）。
// 数据源：mp entity-hub 宫格 + admin 配置中心「进入业务流」入口。label 走 themeLabel，不硬编码中文。
export async function listEntityTypes(client: any, tenantId: string) {
  const r = await client.query(
    `SELECT DISTINCT entity_type FROM workflow_def WHERE tenant_id = $1 ORDER BY entity_type`,
    [tenantId],
  );
  const configured: string[] = r.rows.map((row: any) => String(row.entity_type));
  // #948 语义分治：*_form 后缀的 workflow_def 行是表单/对话配置（config.fields），
  // 不是业务流——不进实体清单（否则 mp 宫格/后台入口会漏出"报修表单"假业务）。
  const flowConfigs = configured.filter((t) => !/_form$/.test(t));
  const builtins = Object.keys(ENTITY_DEF);
  const all = Array.from(new Set([...builtins, ...flowConfigs]));
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
    assertFlowAlive(entityType); // D2：emergency_plan 等收口实体 ⇒ 410 Gone + 指路
    assertFlowEndpointAlive(entityType); // D2：废弃入口（emergency_plan）⇒ 410 + 指路
    const tenantId = res.locals.auth.tenantId;
    const { status } = req.query as Record<string, string>;
    // S4 分派：命中代理 ⇒ 走原生表（响应外壳不变：仍带 label）
    const adapter = proxyFor(entityType);
    if (adapter) {
      const items = await withTenantClient(tenantId, (client) =>
        adapter.list(proxyCtx(client, res, entityType), { status }),
      );
      return res.json({ ok: true, code: 0, items, label: themeLabel(entityType) });
    }
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
    assertFlowAlive(entityType); // D2：emergency_plan 等收口实体 ⇒ 410 Gone + 指路
    assertFlowEndpointAlive(entityType); // D2：废弃入口（emergency_plan）⇒ 410 + 指路
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const { actor } = authInfo(res);
    // S4 分派：命中代理 ⇒ 走原生表（响应外壳不变：201 + {ok, code, item}）
    const adapter = proxyFor(entityType);
    const item = await withTenantClient(tenantId, async (client) => {
      // 守卫保持在事务首行 ⇒ 非授权角色的 403 优先于 zod 的 400（与原 requireConfigRole 顺序一致）。
      // 权限点与 `POST /transport/orders` 共用 `flow.create`：见 role.ts 该点的注释；
      // 「同一笔业务的两个入口必须同答案」由 t5RouteParity.transport.test.ts D 组钉住。
      await requirePermission(auth, client, 'flow.create');
      const b = z
        .object({
          title: z.string().min(1),
          data: z.record(z.any()).optional(),
          assignee: z.string().optional(),
          location: z.string().optional(),
          scheduled_at: z.string().optional(),
        })
        .parse(req.body);
      if (adapter) return adapter.create(proxyCtx(client, res, entityType), b);
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
    assertFlowAlive(entityType); // D2：emergency_plan 等收口实体 ⇒ 410 Gone + 指路
    assertFlowEndpointAlive(entityType); // D2：废弃入口（emergency_plan）⇒ 410 + 指路
    const tenantId = res.locals.auth.tenantId;
    // S4 分派：命中代理 ⇒ 走原生表（响应外壳不变：{ok, code, item}）
    const adapter = proxyFor(entityType);
    if (adapter) {
      const item = await withTenantClient(tenantId, (client) =>
        adapter.detail(proxyCtx(client, res, entityType), req.params.id),
      );
      return res.json({ ok: true, code: 0, item });
    }
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
    assertFlowAlive(entityType); // D2：emergency_plan 等收口实体 ⇒ 410 Gone + 指路
    assertFlowEndpointAlive(entityType); // D2：废弃入口（emergency_plan）⇒ 410 + 指路
    const tenantId = res.locals.auth.tenantId;
    const b = z
      .object({ event: z.string().min(1), data: z.record(z.any()).optional() })
      .parse(req.body);

    // S4 分派：命中代理 ⇒ 走原生表（响应外壳不变：{ok, code, item}）
    // ⚠️ 分派在本 handler 的**最前**（业务校验之前）——代理侧自己会做
    //   requiredFields 校验（同一个 assertRequiredFields），不会少一道。
    const adapter = proxyFor(entityType);
    if (adapter) {
      const item = await withTenantClient(tenantId, (client) =>
        adapter.transition(proxyCtx(client, res, entityType), req.params.id, b),
      );
      return res.json({ ok: true, code: 0, item });
    }

    const item = await withTenantClient(tenantId, async (client) => {
      const def = await getWorkflowDefOrDefault(client, tenantId, entityType, fallbackFor(entityType));
      // requiredFields 校验（引用 data 内字段）
      const cur = await client.query(
        `SELECT status FROM business_flow_tasks WHERE id = $1 AND tenant_id = $2 AND entity_type = $3`,
        [req.params.id, tenantId, entityType],
      );
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'not found', 404);
      assertRequiredFields(def, cur.rows[0].status, b.event, b.data ?? {});
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
