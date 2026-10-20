// 业务流程配置中心（整合方案 v2 · 缺口2"下拉生成"的落地）：
// 运营在界面选业务主题 → 生成 starter 状态机 → 微调 → 落库 workflow_def（零代码配置）。
// 读接口任意已认证用户可访问；写接口按权限点校验（requirePermission，租户可经 role_permission 覆盖）。
//
// 流程配置审核一期（2026-09-12《优服家_流程配置审核设计》）：
// 五条写 live 路径收敛为「写草稿 → 提交 → 审核」状态机——
//   PUT /:entityType、generate-from-theme、import、enable-acceptance(added>0) 一律改产草稿（响应追加 draft:true）；
//   唯一豁免 rollback（目标版本曾生效 + 急救场景），权限点 workflow.edit → workflow.approve（把关人亲自即时裁量）。
// live 表仍只被 approve 一条边触碰（saveWorkflowDef reason='approve'），全部读路径零改动。
// 兼容性：原写路径保留、code/ok 不变，仅新增 draft 字段与行为变化（发版说明标注 breaking）。
import { Router } from 'express';
import { z } from 'zod';
import pool, { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requirePermission, requireAnyPermission } from '../middleware/role.js';
import { assertWorkflowConfigEditableByTenant, readWorkflowConfigOwner } from '../middleware/workflowConfigGuard.js';
import { getWorkflowDef, saveWorkflowDef, ensureWorkflowDef, getWorkflowDefVersion, listWorkflowDefHistory, getWorkflowDefHistoryVersion, countInflightByStates } from '../engine/workflowDef.js';
import {
  upsertWorkflowDefDraft,
  getWorkflowDefChange,
  submitWorkflowDefChange,
  rejectWorkflowDefChange,
  listSubmittedWorkflowDefChanges,
  deleteWorkflowDefChange,
  type WorkflowDefChange,
} from '../engine/workflowDefChange.js';
import { THEME_TEMPLATES, themeLabel, type ThemeTemplate } from '../engine/themes.js';
import { ensureAcceptanceEdges } from '../engine/acceptanceEdges.js'; // 批次三：验收边幂等注入
import { assertAutoRuleSavable } from '../engine/autoRules.js'; // 地基④：自动审核规则红线校验
import { listAutoRules, upsertAutoRule, deleteAutoRule } from '../repo/autoRule.js';
import type { WorkflowDef } from '../engine/stateMachine.js';

const router = Router();

// ---- 审计（与 accounts.ts 同口径：append-only platform_audit；失败不阻断主流程）----
// 自动审核规则的建/改/删属"会真实改变工单走向"的高风险配置，必须留痕可追溯。
async function audit(
  actor: string,
  action: string,
  resource?: string | null,
  targetTenant?: string | null,
  payload?: unknown,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO platform_audit (actor, action, resource, target_tenant, payload) VALUES ($1,$2,$3,$4,$5)`,
      [actor, action, resource ?? null, targetTenant ?? null, payload ? JSON.stringify(payload) : null],
    );
  } catch (e) {
    console.warn('[workflowDef] platform_audit 写入失败（不阻断主流程）', {
      actor, action, resource, targetTenant, err: e instanceof Error ? e.message : String(e),
    });
  }
}

// 业务主题模板清单（下拉生成数据源）。
router.get('/themes', async (_req, res) => {
  const items: { entityType: string; name: string }[] = THEME_TEMPLATES.map((t) => ({
    entityType: t.entityType,
    name: t.name,
  }));
  return res.json({ ok: true, code: 0, items });
});

// ============ 流程审核（一期）：在审清单 ============
// 本租户全部 submitted 变更（workflow.approve）。必须注册在 GET /:entityType 之前，
// 否则 /pending 会被 :entityType 参数路由吞掉。
router.get('/pending', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const items = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'workflow.approve');
      const changes = await listSubmittedWorkflowDefChanges(client, tenantId);
      return changes.map((c: WorkflowDefChange) => ({
        entityType: c.entityType,
        name: themeLabel(c.entityType, (c.def.config as any)?.name),
        status: c.status,
        submittedBy: c.submittedBy,
        submittedAt: c.submittedAt,
        note: c.note,
        baseVersion: c.baseVersion,
        rev: c.rev, // V3-D6：草稿修订号随在审清单透出
      }));
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
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
    const def = await withTenantClient(tenantId, async (client) => ({
      def: await getWorkflowDef(client, tenantId, entityType),
      // 097：把「流程配置权归谁」一并带回，前端据此决定写控件禁用与否——
      // 读端点不设闸（客户必须看得见自己的流程），但有权知道能不能改。
      // 好处：平台运维拨开关后前端自动恢复可编辑，**不必再发一次前端版本**。
      owner: await readWorkflowConfigOwner(client),
    }));
    return res.json({ ok: true, code: 0, entityType, def: def.def, configOwner: def.owner });
  } catch (e) {
    next(e);
  }
});

// —— 请求体 schema 与 def 合并（写路径共用）——
export const defSchema = z.object({
  name: z.string().optional(),
  note: z.string().max(500).optional(), // 变更说明（审核清单/详情展示，提交人填写）
  // V3-D6 乐观锁：带 base_rev（草稿当前 rev）→ 原子比对，他人已先保存 → 409 DRAFT_REV_CONFLICT；
  // 不带 → 无条件覆盖（与旧行为一致，FE/mp 零破坏）。
  base_rev: z.number().int().positive().optional(),
  def: z
    .object({
      initial: z.string().min(1),
      states: z.array(z.string().min(1)).min(1),
      transitions: z.array(z.any()).default([]),
      config: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
});

export function assertEntityType(entityType: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(entityType)) {
    throw new AppError('BAD_PARAM', 'entityType must match ^[a-z][a-z0-9_]*$', 400);
  }
}

export function mergeDef(b: z.infer<typeof defSchema>): WorkflowDef {
  return {
    ...b.def,
    config: { ...(b.def.config ?? {}), ...(b.name ? { name: b.name } : {}) },
  } as WorkflowDef;
}

// def 顶层结构摘要（版本 diff 与 draft-diff 共用，前端做并排对比）。
function defSummary(d: WorkflowDef) {
  return {
    initial: d.initial,
    states: d.states,
    transitionCount: (d.transitions ?? []).length,
    fieldCount: Object.keys((d.config as any)?.fields ?? {}).length,
    name: (d.config as any)?.name ?? null,
  };
}

// ============ 写 live 路径 → 一律改产草稿（审核一期裁决） ============

// upsert 单个 workflow_def（兼容原路径）：现改写为保存/覆盖草稿，不直接触 live。
router.put('/:entityType', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const { entityType } = req.params;
    assertEntityType(entityType);
    const b = defSchema.parse(req.body);
    const { rev } = await withTenantClient(tenantId, async (client) => {
      await assertWorkflowConfigEditableByTenant(client); // 097 归属闸门：platform 时租户侧（含 admin）一律 403
      await requirePermission(auth, client, 'workflow.edit');
      return upsertWorkflowDefDraft(client, tenantId, entityType, mergeDef(b), {
        operator: auth.username,
        note: b.note,
        baseRev: b.base_rev,
      });
    });
    return res.json({ ok: true, code: 0, entityType, draft: true, status: 'draft', rev });
  } catch (e) {
    next(e);
  }
});

// 显式草稿端点（PUT /:entityType/draft）：与上面兼容路径同一语义，供 mp/web 新接线使用。
router.put('/:entityType/draft', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const { entityType } = req.params;
    assertEntityType(entityType);
    const b = defSchema.parse(req.body);
    const { rev } = await withTenantClient(tenantId, async (client) => {
      await assertWorkflowConfigEditableByTenant(client); // 097 归属闸门：platform 时租户侧（含 admin）一律 403
      await requirePermission(auth, client, 'workflow.edit');
      return upsertWorkflowDefDraft(client, tenantId, entityType, mergeDef(b), {
        operator: auth.username,
        note: b.note,
        baseRev: b.base_rev,
      });
    });
    return res.json({ ok: true, code: 0, entityType, draft: true, status: 'draft', rev });
  } catch (e) {
    next(e);
  }
});

// 读在途草稿（workflow.edit 或 workflow.approve）：含 status/note/reject_comment/submitted_by；无则 404。
router.get('/:entityType/draft', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const { entityType } = req.params;
    assertEntityType(entityType);
    const change = await withTenantClient(tenantId, async (client) => {
      await requireAnyPermission(auth, client, ['workflow.edit', 'workflow.approve']);
      return getWorkflowDefChange(client, tenantId, entityType);
    });
    if (!change) throw new AppError('NO_DRAFT', `no in-flight change for ${entityType}`, 404);
    return res.json({ ok: true, code: 0, entityType, change });
  } catch (e) {
    next(e);
  }
});

// 提交审核（draft→submitted，workflow.edit）：base_version 锚定提交时刻的 live 版本。
router.post('/:entityType/submit', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const { entityType } = req.params;
    assertEntityType(entityType);
    const submitted = await withTenantClient(tenantId, async (client) => {
      await assertWorkflowConfigEditableByTenant(client); // 097 归属闸门：platform 时租户侧（含 admin）一律 403
      await requirePermission(auth, client, 'workflow.edit');
      return submitWorkflowDefChange(client, tenantId, entityType, { submittedBy: auth.username ?? '' });
    });
    if (!submitted) {
      const existing = await withTenantClient(tenantId, (client) =>
        getWorkflowDefChange(client, tenantId, entityType),
      );
      if (!existing) throw new AppError('NO_DRAFT', `no in-flight change for ${entityType}`, 404);
      throw new AppError('CHANGE_NOT_DRAFT', 'change is already submitted, awaiting review', 409);
    }
    return res.json({
      ok: true,
      code: 0,
      entityType,
      status: 'submitted',
      baseVersion: submitted.baseVersion,
    });
  } catch (e) {
    next(e);
  }
});

// 审核通过（workflow.approve）：三重校验后复用 saveWorkflowDef 生效（版本自增 + history 快照 reason='approve'），
// 然后删除变更行（审计由 history 承担）。
//   ① submitted_by ≠ 当前账号（403 SELF_APPROVAL，按账号非按角色，admin 也不例外）；
//      F16 豁免（初一裁决 2026-09-14）：单 admin 租户（active admin 计数=1）允许自批——
//      审批人池只有自己，硬禁=流程永久死锁；豁免强制同事务写 platform_audit（self_approved=true，
//      留痕失败即整个审批回滚）；多 admin 租户仍硬禁不变
//   ② base_version = 当前 live 版本（409 DRAFT_STALE：live 已被推进，需重存重提）
//   ③ 行必须存在且 status=submitted（404 NO_DRAFT / 409 CHANGE_NOT_SUBMITTED）
// V3-D4 逃生口：body.confirm_inflight_loss:true → saveWorkflowDef(allowInflightLoss)——
//   显式二次确认删态在途损失（把关人知情裁量），留痕走 history operator/reason。
router.post('/:entityType/approve', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const { entityType } = req.params;
    assertEntityType(entityType);
    const b = z.object({ confirm_inflight_loss: z.literal(true).optional() }).parse(req.body ?? {});
    let selfApproved = false; // F16：单 admin 自批豁免标记（响应透出 + audit 已强制留痕）
    await withTenantClient(tenantId, async (client) => {
      await assertWorkflowConfigEditableByTenant(client); // 097 归属闸门：platform 时租户侧（含 admin）一律 403
      await requirePermission(auth, client, 'workflow.approve');
      const change = await getWorkflowDefChange(client, tenantId, entityType);
      if (!change) throw new AppError('NO_DRAFT', `no in-flight change for ${entityType}`, 404);
      if (change.status !== 'submitted') {
        throw new AppError('CHANGE_NOT_SUBMITTED', 'change is not submitted for review', 409);
      }
      // 自审自批禁令按账号（submitted_by vs 当前 username）——权限管"能不能审"，状态机管"能不能审这一单"。
      // F16（初一裁决 2026-09-14）：单 admin 租户豁免——active admin 仅 1 人时审批人池只有自己，
      // 硬禁=提交人即唯一审批人，SELF_APPROVAL 403 后流程永久死锁（横切③④ 实证）。
      // 豁免伴随强制留痕：同事务写 platform_audit（self_approved=true），audit 失败 → 整个审批回滚；
      // 多 admin 租户（计数>1）维持硬禁不变，防止借豁免绕过双人制。
      if (change.submittedBy && change.submittedBy === auth.username) {
        const admins = await client.query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM account_user WHERE tenant_id = $1 AND role = 'admin' AND active = true`,
          [tenantId],
        );
        const adminCount = Number(admins.rows[0]?.c ?? 0);
        if (adminCount > 1) {
          throw new AppError('SELF_APPROVAL', 'submitter cannot approve own change (self-approval forbidden)', 403);
        }
        selfApproved = true;
        // 强制留痕（fail-closed）：platform_audit 与审批同事务，INSERT 失败即整体回滚
        await client.query(
          `INSERT INTO platform_audit (actor, action, resource, target_tenant, payload) VALUES ($1,$2,$3,$4,$5)`,
          [
            auth.username ?? '',
            'workflow_def.self_approve',
            entityType,
            tenantId,
            JSON.stringify({
              self_approved: true,
              submitted_by: change.submittedBy,
              base_version: change.baseVersion,
              note: '单 admin 租户自批豁免（初一裁决 2026-09-14）',
            }),
          ],
        );
      }
      const liveVersion = await getWorkflowDefVersion(client, tenantId, entityType);
      if (change.baseVersion !== liveVersion) {
        throw new AppError(
          'DRAFT_STALE',
          `base_version ${change.baseVersion} != live version ${liveVersion}; re-save and re-submit`,
          409,
        );
      }
      // 生效复用 saveWorkflowDef：版本自增、history 快照（reason='approve'）、审计全免费，不新造写入机制。
      await saveWorkflowDef(client, tenantId, entityType, change.def, {
        operator: auth.username ?? '', // username 缺失时由 saveWorkflowDef 运行期 422 兜底（留痕不为空）
        reason: 'approve',
        allowInflightLoss: b.confirm_inflight_loss === true,
      });
      await deleteWorkflowDefChange(client, tenantId, entityType);
    });
    return res.json({ ok: true, code: 0, entityType, approved: true, selfApproved, version: 'incremented' });
  } catch (e) {
    next(e);
  }
});

// 审核驳回（workflow.approve，comment 必填）：status 回 draft + reject_comment；live 不动、不产生新版本。
router.post('/:entityType/reject', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const { entityType } = req.params;
    assertEntityType(entityType);
    const b = z.object({ comment: z.string().min(1) }).parse(req.body);
    const rejected = await withTenantClient(tenantId, async (client) => {
      await assertWorkflowConfigEditableByTenant(client); // 097 归属闸门：platform 时租户侧（含 admin）一律 403
      await requirePermission(auth, client, 'workflow.approve');
      return rejectWorkflowDefChange(client, tenantId, entityType, b.comment);
    });
    if (!rejected) {
      const existing = await withTenantClient(tenantId, (client) =>
        getWorkflowDefChange(client, tenantId, entityType),
      );
      if (!existing) throw new AppError('NO_DRAFT', `no in-flight change for ${entityType}`, 404);
      throw new AppError('CHANGE_NOT_SUBMITTED', 'change is not submitted for review', 409);
    }
    return res.json({ ok: true, code: 0, entityType, rejected: true, status: 'draft' });
  } catch (e) {
    next(e);
  }
});

// 草稿 vs live 并排差异（workflow.approve 或 workflow.edit）：复用版本 diff 的 summary 结构。
router.get('/:entityType/draft-diff', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const { entityType } = req.params;
    assertEntityType(entityType);
    const data = await withTenantClient(tenantId, async (client) => {
      await requireAnyPermission(auth, client, ['workflow.edit', 'workflow.approve']);
      const version = await getWorkflowDefVersion(client, tenantId, entityType);
      const liveDef = await getWorkflowDef(client, tenantId, entityType);
      const change = await getWorkflowDefChange(client, tenantId, entityType);
      return { version, liveDef, change };
    });
    if (!data.change) throw new AppError('NO_DRAFT', `no in-flight change for ${entityType}`, 404);
    return res.json({
      ok: true,
      code: 0,
      entityType,
      live: { version: data.version, def: data.liveDef, summary: defSummary(data.liveDef) },
      draft: {
        def: data.change.def,
        summary: defSummary(data.change.def),
        status: data.change.status,
        submittedBy: data.change.submittedBy,
        submittedAt: data.change.submittedAt,
        note: data.change.note,
        rejectComment: data.change.rejectComment,
      },
    });
  } catch (e) {
    next(e);
  }
});

// V3-D4 预演端点（UI 糖，非闸门）：POST /:entityType/preflight——body 带新 def，
// 返回 { removed, inflight_total, by_state }：FE 在保存前展示删态影响面，与硬闸构成"提示 + 强制"两层。
router.post('/:entityType/preflight', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { entityType } = req.params;
    assertEntityType(entityType);
    const b = defSchema.parse(req.body);
    const data = await withTenantClient(tenantId, async (client) => {
      await requireAnyPermission(res.locals.auth, client, ['workflow.edit', 'workflow.approve']);
      const liveDef = await getWorkflowDef(client, tenantId, entityType);
      const newDef = mergeDef(b);
      const removed = (liveDef.states ?? []).filter((s) => !newDef.states.includes(s));
      const inflight = removed.length > 0 ? await countInflightByStates(client, tenantId, entityType, removed) : { total: 0, byState: {} };
      return { removed, inflight };
    });
    return res.json({
      ok: true,
      code: 0,
      entityType,
      removed: data.removed,
      inflight_total: data.inflight.total,
      by_state: data.inflight.byState,
    });
  } catch (e) {
    next(e);
  }
});

// 从主题模板生成（下拉生成）：改产草稿——模板只是起点，微调后仍需过审。
router.post('/generate-from-theme', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const { entityType } = z.object({ entityType: z.string().min(1) }).parse(req.body);
    const tpl: ThemeTemplate | undefined = THEME_TEMPLATES.find((t) => t.entityType === entityType);
    if (!tpl) throw new AppError('NOT_FOUND', `unknown theme: ${entityType}`, 404);
    const merged: WorkflowDef = { ...tpl.def, config: { ...(tpl.def.config ?? {}), name: tpl.name } } as WorkflowDef;
    await withTenantClient(tenantId, async (client) => {
      await assertWorkflowConfigEditableByTenant(client); // 097 归属闸门：platform 时租户侧（含 admin）一律 403
      await requirePermission(auth, client, 'workflow.edit');
      await upsertWorkflowDefDraft(client, tenantId, entityType, merged, {
        operator: auth.username,
        note: `从主题模板「${tpl.name}」生成`,
      });
    });
    return res.json({ ok: true, code: 0, entityType, name: tpl.name, draft: true });
  } catch (e) {
    next(e);
  }
});

// ============ 批次三 卡4：老租户自愿升级——给 work_order def 追加验收边 ============
// POST /api/v1/workflow-defs/:entityType/enable-acceptance（门禁：workflow.edit 权限点）
// 审核一期裁决：added>0（结构性变更）改产草稿待审；added=0 幂等无操作原样放行（no-op 不产生内容）。
router.post('/:entityType/enable-acceptance', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const { entityType } = req.params;
    assertEntityType(entityType);
    const result = await withTenantClient(tenantId, async (client) => {
      await assertWorkflowConfigEditableByTenant(client); // 097 归属闸门：platform 时租户侧（含 admin）一律 403
      await requirePermission(auth, client, 'workflow.edit');
      // 无 def 行的租户先落引擎默认图（显式落库后再注入，保证升级可追溯）
      const cur = await ensureWorkflowDef(client, tenantId, entityType);
      const { def, added } = ensureAcceptanceEdges(cur);
      if (added.length > 0) {
        await upsertWorkflowDefDraft(client, tenantId, entityType, def, {
          operator: auth.username,
          note: '开启完工验收（追加验收边）',
        });
      }
      return { added };
    });
    return res.json({
      ok: true,
      code: 0,
      entityType,
      added_count: result.added.length,
      added_edges: result.added,
      ...(result.added.length > 0
        ? { draft: true, version: 'draft-pending-approval' }
        : { version: 'unchanged' }),
    });
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
    assertEntityType(entityType);
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
    return res.json({
      ok: true,
      code: 0,
      entityType,
      from: { version: a, def: defs[0], summary: defSummary(defs[0]) },
      to: { version: b, def: defs[1], summary: defSummary(defs[1]) },
    });
  } catch (e) {
    next(e);
  }
});

// 一键回滚：把指定历史版本存为新版本（版本自增，reason=rollback）。
// 审核一期裁决：豁免审批（目标版本曾生效 + 急救场景，过审会延误止血），但把关责任不消失——
// 权限点由 workflow.edit 收紧为 workflow.approve（把关人亲自即时裁量）。
// V3-D4 逃生口：body.confirm_inflight_loss:true → allowInflightLoss（与 approve 同款显式二次确认）。
router.post('/:entityType/versions/:version/rollback', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const { entityType } = req.params;
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version < 1) throw new AppError('BAD_PARAM', 'bad version', 400);
    const b = z.object({ confirm_inflight_loss: z.literal(true).optional() }).parse(req.body ?? {});
    const target = await withTenantClient(tenantId, (client) =>
      getWorkflowDefHistoryVersion(client, tenantId, entityType, version),
    );
    // X-13：404 文案区分「无历史快照」vs「版本不存在」——零历史实体报 NO_HISTORY（提示先过审产生快照），
    // 有历史但目标版本号越界报 VERSION_NOT_FOUND（提示查历史范围）。
    if (!target) {
      const hist = await withTenantClient(tenantId, (client) => listWorkflowDefHistory(client, tenantId, entityType));
      if (hist.length === 0) {
        throw new AppError('NO_HISTORY', `该配置无历史快照，无可回滚版本：${entityType}（历史快照在审批通过时产生）`, 404);
      }
      throw new AppError('VERSION_NOT_FOUND', `版本 ${version} 不存在于 ${entityType} 的历史中（范围见版本历史接口）`, 404);
    }
    await withTenantClient(tenantId, async (client) => {
      await assertWorkflowConfigEditableByTenant(client); // 097 归属闸门：platform 时租户侧（含 admin）一律 403
      await requirePermission(auth, client, 'workflow.approve');
      await saveWorkflowDef(client, tenantId, entityType, target, {
        operator: auth.username ?? '', // username 缺失时由 saveWorkflowDef 运行期 422 兜底（留痕不为空）
        reason: `rollback-to-${version}`,
        allowInflightLoss: b.confirm_inflight_loss === true,
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
    assertEntityType(entityType);
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

// 导入 def：改产草稿——外部文件风险最高，最需要人把关（来源标记 G5）。
router.post('/:entityType/import', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const { entityType } = req.params;
    assertEntityType(entityType);
    const b = defSchema.parse(req.body);
    await withTenantClient(tenantId, async (client) => {
      await assertWorkflowConfigEditableByTenant(client); // 097 归属闸门：platform 时租户侧（含 admin）一律 403
      await requirePermission(auth, client, 'workflow.edit');
      await upsertWorkflowDefDraft(client, tenantId, entityType, mergeDef(b), {
        operator: auth.username,
        note: b.note ?? '导入外部文件',
      });
    });
    return res.json({
      ok: true,
      code: 0,
      entityType,
      imported: true,
      draft: true,
      version: 'draft-pending-approval',
    });
  } catch (e) {
    next(e);
  }
});

// ============ 自动审核规则（地基④：租户可配，**默认关闭**） ============
// 用户原意（stateMachine.ts:22 原文）：「审核员不是单独一个人，是一个权限属性，
//   它可以加给谁一个审核权限，或者配置自动审核规则。」
// 前半句（审核 = 可叠加权限属性）由 allowedPerms 落地；这组分端点是后半句。
//
// 🔴 红线（stateMachine.ts:5-6）：引擎绝不自动推进到终态。
//   自动审核只能推到中间态（pending_review → review_passed / processing），
//   绝不能自动 close / cancel / satisfy。守线三道闸：
//     ① schema 层 z.enum 只收 approve / reject；
//     ② engine/autoRules.ts 的 assertAutoRuleSavable：按本租户 def 解析真实 to_state，
//        命中终态 → 422 拒绝保存（写库前就挡住，不等运行期出事）；
//     ③ 094 迁移 DB CHECK 同款白名单。
//   另：`enabled` 为必填且不默认 true —— 建规则 ≠ 启用，杜绝"配了就自动跑"误伤存量。
//   启用（enabled=true）额外要 workflow.approve：开自动审核是把关人级别的决定。

const autoRuleSchema = z.object({
  from_state: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'from_state 形状非法'),
  event: z.enum(['approve', 'reject']),
  // 维度严格对应 work_orders 真实列（priority / catalog / ext.has_exception）；
  // 本表无金额列，故不提供金额条件——不实现取不到数的假条件。
  conditions: z
    .object({
      priority_in: z.array(z.string()).optional(),
      categories: z.array(z.string()).optional(),
      no_exception: z.boolean().nullable().optional(),
    })
    .optional()
    .default({}),
  // 必填：不允许"不传就默认启用"。默认启用 = 配了就自动跑，属误伤风险。
  enabled: z.boolean(),
  note: z.string().max(200).nullable().optional(),
});

/** GET /api/v1/workflow/def/:entityType/auto-rules —— 列出本租户全部自动审核规则（含未启用）。 */
router.get('/:entityType/auto-rules', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const { entityType } = req.params;
    assertEntityType(entityType);
    const items = await withTenantClient(tenantId, async (client) => {
      await requireAnyPermission(auth, client, ['workflow.edit', 'workflow.approve']);
      return listAutoRules(client, tenantId, entityType);
    });
    return res.json({ ok: true, code: 0, entityType, items });
  } catch (e) {
    next(e);
  }
});

/** PUT /api/v1/workflow/def/:entityType/auto-rules —— 新建或更新一条自动审核规则。 */
router.put('/:entityType/auto-rules', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const { entityType } = req.params;
    assertEntityType(entityType);
    const b = autoRuleSchema.parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      await assertWorkflowConfigEditableByTenant(client); // 097 归属闸门：platform 时租户侧（含 admin）一律 403
      await requirePermission(auth, client, 'workflow.edit');
      // 启用自动审核是把关人级别的决定：额外要 workflow.approve（关掉只需 workflow.edit）
      if (b.enabled) await requirePermission(auth, client, 'workflow.approve');
      const def = await getWorkflowDef(client, tenantId, entityType as never);
      // 红线闸②：按本租户真实流程解析目标态，指向终态直接 422 拒绝保存
      const { to } = assertAutoRuleSavable(def, { fromState: b.from_state, event: b.event });
      const saved = await upsertAutoRule(client, tenantId, {
        entityType,
        fromState: b.from_state,
        event: b.event,
        conditions: {
          priorityIn: b.conditions.priority_in ?? null,
          categories: b.conditions.categories ?? null,
          noException: b.conditions.no_exception ?? null,
        },
        enabled: b.enabled,
        note: b.note ?? null,
      });
      return { ...saved, to_state: to };
    });
    await audit(auth.username ?? 'unknown', 'workflow.autorule.upsert', `${entityType}/${b.from_state}/${b.event}`, tenantId, {
      enabled: b.enabled,
      conditions: b.conditions,
    });
    return res.json({ ok: true, code: 0, entityType, item });
  } catch (e) {
    next(e);
  }
});

/** DELETE /api/v1/workflow/def/:entityType/auto-rules/:fromState/:event —— 删除一条规则。 */
router.delete('/:entityType/auto-rules/:fromState/:event', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const { entityType, fromState, event } = req.params;
    assertEntityType(entityType);
    const ok = await withTenantClient(tenantId, async (client) => {
      await assertWorkflowConfigEditableByTenant(client); // 097 归属闸门：platform 时租户侧（含 admin）一律 403
      await requirePermission(auth, client, 'workflow.edit');
      return deleteAutoRule(client, tenantId, entityType, fromState, event);
    });
    if (!ok) throw new AppError('NOT_FOUND', `auto rule not found: ${fromState}/${event}`, 404);
    await audit(auth.username ?? 'unknown', 'workflow.autorule.delete', `${entityType}/${fromState}/${event}`, tenantId, {});
    return res.json({ ok: true, code: 0, entityType, deleted: true });
  } catch (e) {
    next(e);
  }
});

export default router;
