// 平台运维代客配置流程（097）+ 流程配置归属开关。
// 挂在 /api/v1/platform/*，全部走 platformAdminAuth（与 platform.ts:85 同款）；
// 操作目标租户由路径 :id 指定——复用既有「平台运维改指定租户数据」模式
// （platform.ts 的 /tenants/:id/locations、/tenants/:id/reporters 同款）。
//
// 【为什么要有这套端点】
//   097 把租户侧流程配置写端点全部收口（归属=platform 时租户含 admin 一律 403）。
//   锁上之后必须留一条**正规通道**给平台运维改客户流程，否则"客户不能改 + 运维也改不了"，
//   流程就彻底死锁了。这里是那条通道：仅限平台运维，全程 platform_audit 留痕。
//
// 【与租户侧端点的关系】引擎函数完全复用（upsertWorkflowDefDraft / submit / approve / reject），
//   不另造一套写入机制——保证平台侧与租户侧产出的草稿结构、版本锚、状态机语义逐字一致。
//   唯一差异：① 不走租户侧归属闸门（本就是平台身份）；② 不走 requirePermission（平台 token 无租户角色）。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { platformAdminAuth } from '../middleware/platformAuth.js';
import { recordPlatformAudit } from '../repo/platformAudit.js';
import {
  getWorkflowDef, saveWorkflowDef,
} from '../engine/workflowDef.js';
import {
  upsertWorkflowDefDraft, getWorkflowDefChange, submitWorkflowDefChange,
  rejectWorkflowDefChange, listSubmittedWorkflowDefChanges, deleteWorkflowDefChange,
} from '../engine/workflowDefChange.js';
import { defSchema, assertEntityType, mergeDef } from './workflowDef.js';
import {
  getWorkflowConfigOwner, setWorkflowConfigOwner, WORKFLOW_CONFIG_OWNER_KEY,
} from '../repo/platformConfig.js';

const router = Router();
router.use(platformAdminAuth);

// 审计（与 platform.ts 同口径：append-only platform_audit；失败不阻断主流程）
async function audit(
  actor: string,
  action: string,
  resource?: string | null,
  targetTenant?: string | null,
  payload?: unknown,
): Promise<void> {
  // 统一走 repo/platformAudit.ts —— 平台审计是 append-only 证据链，
  // 「写什么字段 / 失败是否留痕」必须只有一个地方能决定（此前 7 份逐字重复实现）。
  // pool 沿用本文件原有的**动态 import**形态（原实现即如此，推测为规避循环依赖，不擅自改成静态）。
  const { default: pool } = await import('../db/pool.js');
  await recordPlatformAudit(pool, { actor, action, resource, targetTenant, payload, scope: 'platformWorkflow' });
}

/** 平台运维在留痕里的身份标记（与租户 username 可区分）。 */
function actorOf(res: any): string {
  return `platform:${res.locals.platformAdmin?.username ?? 'unknown'}`;
}

// ============ 归属开关（平台运维在后台切换，无需发版） ============

router.get('/config/workflow-config-owner', async (_req, res, next) => {
  try {
    const owner = await getWorkflowConfigOwner();
    return res.json({ ok: true, code: 0, key: WORKFLOW_CONFIG_OWNER_KEY, owner });
  } catch (e) { next(e); }
});

router.put('/config/workflow-config-owner', async (req, res, next) => {
  try {
    const b = z.object({ owner: z.enum(['platform', 'tenant']) }).parse(req.body ?? {});
    const actor = actorOf(res);
    const owner = await setWorkflowConfigOwner(b.owner, actor);
    await audit(actor, 'platform_config.set', WORKFLOW_CONFIG_OWNER_KEY, null, { owner: b.owner });
    return res.json({ ok: true, code: 0, key: WORKFLOW_CONFIG_OWNER_KEY, owner });
  } catch (e) { next(e); }
});

// ============ 平台运维代客配置流程 ============

// 读指定租户的流程定义（含引擎机制注入后的最终形态）。
router.get('/tenants/:id/workflow-def/:entityType', async (req, res, next) => {
  try {
    const tenantId = (req.params.id || '').trim();
    const { entityType } = req.params;
    assertEntityType(entityType);
    const def = await withTenantClient(tenantId, (client) => getWorkflowDef(client, tenantId, entityType));
    return res.json({ ok: true, code: 0, tenantId, entityType, def });
  } catch (e) { next(e); }
});

// 存草稿（不触 live）：与租户侧 PUT /:entityType 同语义。
router.put('/tenants/:id/workflow-def/:entityType', async (req, res, next) => {
  try {
    const tenantId = (req.params.id || '').trim();
    const { entityType } = req.params;
    assertEntityType(entityType);
    const b = defSchema.parse(req.body);
    const actor = actorOf(res);
    const { rev } = await withTenantClient(tenantId, (client) =>
      upsertWorkflowDefDraft(client, tenantId, entityType, mergeDef(b), {
        operator: actor, note: b.note, baseRev: b.base_rev,
      }),
    );
    await audit(actor, 'workflow_def.draft_save', entityType, tenantId, { rev, note: b.note ?? null });
    return res.json({ ok: true, code: 0, tenantId, entityType, draft: true, status: 'draft', rev });
  } catch (e) { next(e); }
});

// 提交（draft → submitted）
router.post('/tenants/:id/workflow-def/:entityType/submit', async (req, res, next) => {
  try {
    const tenantId = (req.params.id || '').trim();
    const { entityType } = req.params;
    assertEntityType(entityType);
    const actor = actorOf(res);
    // 099 起可有多份在途草稿：平台运维代客提交同样需要能指定哪一份（不传时仅一份草稿才提交）
    const b = z.object({ change_id: z.number().int().positive().optional() }).parse(req.body ?? {});
    const submitted = await withTenantClient(tenantId, (client) =>
      submitWorkflowDefChange(client, tenantId, entityType, { submittedBy: actor, changeId: b.change_id }),
    );
    if (!submitted) {
      const existing = await withTenantClient(tenantId, (client) =>
        getWorkflowDefChange(client, tenantId, entityType),
      );
      if (!existing) throw new AppError('NO_DRAFT', `no in-flight change for ${entityType}`, 404);
      throw new AppError('CHANGE_NOT_DRAFT', 'change is already submitted, awaiting review', 409);
    }
    await audit(actor, 'workflow_def.submit', entityType, tenantId, { base_version: submitted.baseVersion });
    return res.json({ ok: true, code: 0, tenantId, entityType, status: 'submitted' });
  } catch (e) { next(e); }
});

// 审批生效（submitted → live，版本自增）。
// 【自审自批】租户侧的 SELF_APPROVAL 禁令针对的是**租户内部双人制**（submitted_by 与租户账号比对），
//   平台运维是外部代客操作、且本端点强制 platform_audit 留痕，不适用该禁令——
//   若照搬，单运维场景下会永久死锁（提交人即唯一审批人，与 F16 裁决处理的是同一个坑）。
router.post('/tenants/:id/workflow-def/:entityType/approve', async (req, res, next) => {
  try {
    const tenantId = (req.params.id || '').trim();
    const { entityType } = req.params;
    assertEntityType(entityType);
    const b = z.object({ confirm_inflight_loss: z.literal(true).optional() }).parse(req.body ?? {});
    const actor = actorOf(res);
    await withTenantClient(tenantId, async (client) => {
      const change = await getWorkflowDefChange(client, tenantId, entityType);
      if (!change) throw new AppError('NO_DRAFT', `no in-flight change for ${entityType}`, 404);
      if (change.status !== 'submitted') {
        throw new AppError('CHANGE_NOT_SUBMITTED', 'change is not submitted for review', 409);
      }
      // T0：删掉 check-then-act（先读版本再比对再写，两条语句间无锁 ⇒ 并发可双双通过），
      //   改用 saveWorkflowDef 的单语句条件更新（WHERE version = expectVersion），版本不符 ⇒ 409 DRAFT_STALE。
      //   错误码/文案口径不变，前端零改动。
      await saveWorkflowDef(client, tenantId, entityType, change.def, {
        operator: actor, reason: 'approve', allowInflightLoss: b.confirm_inflight_loss === true,
        expectVersion: change.baseVersion,
      });
      await deleteWorkflowDefChange(client, tenantId, entityType, change.id);
    });
    await audit(actor, 'workflow_def.approve', entityType, tenantId, { by_platform: true });
    return res.json({ ok: true, code: 0, tenantId, entityType, approved: true, version: 'incremented' });
  } catch (e) { next(e); }
});

// 驳回（submitted → draft，comment 必填）
router.post('/tenants/:id/workflow-def/:entityType/reject', async (req, res, next) => {
  try {
    const tenantId = (req.params.id || '').trim();
    const { entityType } = req.params;
    assertEntityType(entityType);
    const b = z.object({ comment: z.string().min(1) }).parse(req.body ?? {});
    const actor = actorOf(res);
    const rejected = await withTenantClient(tenantId, (client) =>
      rejectWorkflowDefChange(client, tenantId, entityType, b.comment),
    );
    if (!rejected) {
      const existing = await withTenantClient(tenantId, (client) =>
        getWorkflowDefChange(client, tenantId, entityType),
      );
      if (!existing) throw new AppError('NO_DRAFT', `no in-flight change for ${entityType}`, 404);
      throw new AppError('CHANGE_NOT_SUBMITTED', 'change is not submitted for review', 409);
    }
    await audit(actor, 'workflow_def.reject', entityType, tenantId, { comment: b.comment });
    return res.json({ ok: true, code: 0, tenantId, entityType, rejected: true, status: 'draft' });
  } catch (e) { next(e); }
});

// 待审批清单
router.get('/tenants/:id/workflow-def-pending', async (req, res, next) => {
  try {
    const tenantId = (req.params.id || '').trim();
    const items = await withTenantClient(tenantId, (client) =>
      listSubmittedWorkflowDefChanges(client, tenantId),
    );
    return res.json({ ok: true, code: 0, tenantId, items });
  } catch (e) { next(e); }
});

export default router;
