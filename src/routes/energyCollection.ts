// 能耗采集任务路由（T303a 优服家第四源 · 收单 + token 三链 + 账号 JWT 桥接）。
// 数据来源：能源平台派单 webhook（HMAC-SHA256 验签 + task_ref 幂等）→
// workflow_def 配置驱动建单（entity_type=energy_collection，business_flow_tasks）→
// service_key 换 worker token（worker_ref=youfu:{worker_id}，15min）→ worker 只读列表。
// T-bridge（2026-09-11 初一"继续推进"核准）：只读接口新增账号 JWT 链——
// 登录 token（role∈worker/operator）按 worker.account_id 反查业务 worker.id；
// 修复 mp 第四源 401→api.js 全局登出循环。service_key 机器链语义不变。
// 红线：结构化采集字段零进优服家 PG——收单 body 走 z.strict() 白名单，
// 多一个字段即 422 拒收，任务壳只有 task_ref/site/deadline/form_url。
import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { signJwt, verifyJwt, DEFAULT_TENANT_ID } from '../middleware/auth.js';
import { getWorkflowDefOrDefault } from '../engine/workflowDef.js';
import { availableTransitions } from '../engine/stateMachine.js';
import { transitionEntity } from '../engine/transition.js';
import { ENERGY_COLLECTION_DEF } from '../engine/themes.js';
import { emitDomainEvent } from '../db/eventBus.js';

const router = Router();

const ENTITY = 'energy_collection';
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000; // 与能源侧 dispatchToYoufu 对齐的防重放窗口
const TOKEN_TTL_SECONDS = 15 * 60; // worker token 时效 15min（任务书口径）

// ---------------------------------------------------------------------------
// webhook 验签（能源侧 X-Energy-Timestamp / X-Energy-Signature 三头协议对齐）
// 签名域 = `${ts}.${rawBody}`；密钥 ENERGY_WEBHOOK_SECRET（env，fail-closed）。
// ---------------------------------------------------------------------------
function verifyEnergySignature(req: any): void {
  const secret = process.env.ENERGY_WEBHOOK_SECRET;
  if (!secret) {
    throw new AppError('AUTH_CFG', 'ENERGY_WEBHOOK_SECRET not configured on server (fail-closed)', 500);
  }
  const ts = Number(req.header('X-Energy-Timestamp'));
  const sig = req.header('X-Energy-Signature') || '';
  if (!Number.isFinite(ts) || !sig) {
    throw new AppError('AUTH_001', 'missing X-Energy-Timestamp / X-Energy-Signature', 401);
  }
  if (Math.abs(Date.now() - ts) > SIGNATURE_WINDOW_MS) {
    throw new AppError('AUTH_003', 'energy webhook timestamp outside window', 401);
  }
  const raw = req.rawBody as Buffer | undefined;
  if (!raw) {
    throw new AppError('AUTH_002', 'raw body unavailable for signature verification', 401);
  }
  const expected = crypto.createHmac('sha256', secret).update(`${ts}.${raw.toString('utf8')}`, 'utf8').digest('hex');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // 定长比较防时序侧信道（与 svcAuth/openApiAuth 同一纪律）
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new AppError('AUTH_002', 'energy webhook signature mismatch', 401);
  }
}

// P2-6（QA 深审登记）：webhook body 硬上限。合法 G1/G4 payload（任务壳/回执）
// 均在 1KB 以内，200KB 级 body 只可能是异常/滥用流量——在验签（HMAC 计算）
// 之前直接 413 拒收，省计算也防大包耗资源。fail-closed 语义不变。
const WEBHOOK_MAX_BODY_BYTES = 64 * 1024;

function verifyEnergyWebhook(req: any): void {
  const raw = req.rawBody as Buffer | undefined;
  const size = raw ? raw.length : 0;
  if (size > WEBHOOK_MAX_BODY_BYTES) {
    throw new AppError('PAYLOAD_TOO_LARGE', `webhook body exceeds ${WEBHOOK_MAX_BODY_BYTES} bytes`, 413);
  }
  verifyEnergySignature(req);
}

// 派单任务壳白名单（strict：未知字段=结构化采集字段 → 422，红线硬保证）
const DispatchBody = z
  .object({
    task_ref: z.string().min(8).max(64),
    site: z.string().min(1).max(120),
    title: z.string().min(1).max(120),
    deadline: z.string().max(40).nullable().optional(),
    form_url: z.string().max(300).nullable().optional(),
    // T303c-fix：模板号随派单壳透传（能源侧 youfu_dispatch_log 已有此数据），
    // 落 data JSONB 供 /energy/tasks 返回 → mp 端 form-session 前分流高频/长尾。
    // optional+nullable：旧版能源 payload 无此字段照收（strict 白名单内追加，不破坏兼容）。
    template_code: z.string().max(20).nullable().optional(),
    // P2-7（B 方案）：重派关联原单随任务壳透传（能源侧 youfu_dispatch_log.redispatch_of），
    // 落 data JSONB 票据链两端可查。optional+nullable：普通派单无此字段照收。
    redispatch_of: z.string().max(64).nullable().optional(),
    created_at: z.string().max(40).optional(),
  })
  .strict();

// POST /api/v1/energy/webhook/dispatch —— 能源平台收单（公开路径，自带验签）
// 幂等：data->>'task_ref' 命中即 200 回放，不重复建单。
router.post('/energy/webhook/dispatch', async (req: any, res: any, next: any) => {
  try {
    verifyEnergyWebhook(req);
    const b = DispatchBody.parse(req.body);
    const tenantId = process.env.ENERGY_DISPATCH_TENANT ?? DEFAULT_TENANT_ID;

    const result = await withTenantClient(tenantId, async (client: any) => {
      // 幂等检查（先于建单）：同 task_ref 直接回放
      const dup = await client.query(
        `SELECT * FROM business_flow_tasks
         WHERE tenant_id = $1 AND entity_type = $2 AND data->>'task_ref' = $3 LIMIT 1`,
        [tenantId, ENTITY, b.task_ref],
      );
      if (dup.rows[0]) {
        const def = await getWorkflowDefOrDefault(client, tenantId, ENTITY, ENERGY_COLLECTION_DEF);
        return { replay: true as const, item: { ...dup.rows[0], available: availableTransitions(def, dup.rows[0].status) } };
      }

      // 配置驱动：租户 workflow_def 优先（seed-energy-collection-def 落库），
      // 无配置回退 ENERGY_COLLECTION_DEF 内置镜像态（零配置即可收单）。
      const def = await getWorkflowDefOrDefault(client, tenantId, ENTITY, ENERGY_COLLECTION_DEF);
      const r = await client.query(
        `INSERT INTO business_flow_tasks (tenant_id, entity_type, title, status, data, location, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          tenantId,
          ENTITY,
          b.title,
          def.initial,
          JSON.stringify({ task_ref: b.task_ref, site: b.site, deadline: b.deadline ?? null, form_url: b.form_url ?? null, template_code: b.template_code ?? null, redispatch_of: b.redispatch_of ?? null, source: 'energy-platform', worker_ref: null }),
          b.site,
          'energy-webhook',
        ],
      );
      let row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: ENTITY, entityId: row.id, type: 'create', actor: 'energy-webhook' });
      // 镜像态推进：created --dispatch--> dispatched（收单即确认派达，走同一 workflow_def 引擎）
      row = await transitionEntity(client, tenantId, {
        table: 'business_flow_tasks',
        id: row.id,
        event: 'dispatch',
        entityType: ENTITY,
        fallbackDef: ENERGY_COLLECTION_DEF,
        actor: 'energy-webhook',
      });
      return { replay: false as const, item: row };
    });

    if (result.replay) {
      return res.status(200).json({ ok: true, code: 0, idempotent_replay: true, item: result.item });
    }
    return res.status(201).json({ ok: true, code: 0, item: result.item });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// service_key 换 worker token（签发链）。密钥 ENERGY_SERVICE_KEY（env，fail-closed，
// 与能源平台 svc_accounts.secret_hash 同值注入）。token: HS256，worker_ref=youfu:{worker_id}，
// tid 注入，exp=15min；worker 只读接口按 verifyJwt（prod 语义）校验。
// ---------------------------------------------------------------------------
const ExchangeBody = z.object({
  service_key: z.string().min(8).max(128),
  worker_id: z.string().min(1).max(64),
});

router.post('/energy/token-exchange', async (req: any, res: any, next: any) => {
  try {
    const serviceKey = process.env.ENERGY_SERVICE_KEY;
    if (!serviceKey) {
      throw new AppError('AUTH_CFG', 'ENERGY_SERVICE_KEY not configured on server (fail-closed)', 500);
    }
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new AppError('AUTH_CFG', 'JWT_SECRET not configured on server (fail-closed)', 500);
    }
    const b = ExchangeBody.parse(req.body);
    const a = Buffer.from(b.service_key, 'utf8');
    const c = Buffer.from(serviceKey, 'utf8');
    if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) {
      return res.status(401).json({ ok: false, code: 'AUTH_001', message: 'service_key 无效' });
    }
    const tenantId = process.env.ENERGY_DISPATCH_TENANT ?? DEFAULT_TENANT_ID;
    const nowSec = Math.floor(Date.now() / 1000);
    const token = signJwt(
      {
        sub: b.worker_id,
        worker_ref: `youfu:${b.worker_id}`,
        scope: ENTITY,
        tid: tenantId,
        iat: nowSec,
        exp: nowSec + TOKEN_TTL_SECONDS,
      },
      jwtSecret,
    );
    return res.json({
      ok: true,
      code: 0,
      token,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_SECONDS,
      worker_ref: `youfu:${b.worker_id}`,
    });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// worker 身份归一化（双链）。链 A：能源 worker token（scope=energy_collection，
// token-exchange 签发，机器/表单链）——语义不变；链 B（T-bridge 2026-09-11）：
// 优服家账号 JWT（登录链，role∈worker/operator）按 worker.account_id 反查业务
// worker.id 构造 workerRef。修复 mp 第四源 401→api.js 全局登出循环：
// 无工人档案回 403（mp 仅告警不登出），admin 等其他角色维持 401 不放行。
// 租户只取 token 内 tid（不信任客户端头）。
// ---------------------------------------------------------------------------
async function resolveWorkerIdentity(req: any): Promise<{ workerId: string; workerRef: string; tid: string }> {
  const m = /^Bearer\s+(.+)$/i.exec((req.header('Authorization') || '').trim());
  const bearer = m ? m[1] : null;
  if (!bearer) {
    throw new AppError('AUTH_001', 'missing worker token', 401);
  }
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new AppError('AUTH_CFG', 'JWT_SECRET not configured on server (fail-closed)', 500);
  }
  const payload = verifyJwt(bearer, jwtSecret);
  if (!payload) {
    throw new AppError('AUTH_002', 'invalid or expired worker token', 401);
  }
  // 链 A：能源 worker token（原语义原样保留）
  if (payload.scope === ENTITY) {
    const workerId = String(payload.sub ?? '');
    const tid = String(payload.tid ?? '');
    if (!tid) {
      throw new AppError('TENANT_001', 'worker token has no tid', 401);
    }
    return { workerId, workerRef: String(payload.worker_ref ?? `youfu:${workerId}`), tid };
  }
  // 链 B：账号 JWT 桥接（worker/operator；sub=account_user.id → worker.account_id 反查）
  const role = String(payload.role ?? '');
  if (role === 'worker' || role === 'operator') {
    const tid = String(payload.tid ?? '');
    const accountId = String(payload.sub ?? '');
    if (!tid || !accountId) {
      throw new AppError('AUTH_002', 'invalid or expired worker token', 401);
    }
    const w: any = await withTenantClient(tid, async (client: any) =>
      client.query(
        `SELECT id FROM worker WHERE tenant_id = $1 AND account_id = $2 AND active = true LIMIT 1`,
        [tid, accountId],
      ),
    );
    const workerId = w.rows[0]?.id ? String(w.rows[0].id) : '';
    if (!workerId) {
      throw new AppError('ENERGY_FORBIDDEN', '账号未绑定工人档案，暂无能耗采集任务', 403);
    }
    return { workerId, workerRef: `youfu:${workerId}`, tid };
  }
  throw new AppError('AUTH_002', 'invalid or expired worker token', 401);
}

// GET /api/v1/energy/tasks?assignee= —— worker 只读列表（第四源数据源）。
// 越权链：query.assignee 与 token worker 身份不一致 → 403；
// 可见范围 = data->>'worker_ref' = token.worker_ref ∪ assignee = token.sub（授权交集第二半）。
router.get('/energy/tasks', async (req: any, res: any, next: any) => {
  try {
    const { workerId, workerRef, tid: tenantId } = await resolveWorkerIdentity(req);
    if (!tenantId) {
      throw new AppError('TENANT_001', 'worker token has no tid', 401);
    }
    const assignee = typeof req.query.assignee === 'string' ? req.query.assignee : '';
    if (assignee && assignee !== workerId) {
      return res.status(403).json({
        ok: false,
        code: 'ENERGY_FORBIDDEN',
        message: `worker ${workerId} 无权查看 assignee=${assignee} 的能耗采集任务`,
      });
    }

    const items = await withTenantClient(tenantId, async (client: any) => {
      const def = await getWorkflowDefOrDefault(client, tenantId, ENTITY, ENERGY_COLLECTION_DEF);
      const clauses = ['tenant_id = $1', "entity_type = 'energy_collection'", "(data->>'worker_ref' = $2 OR assignee = $3)"];
      const params: unknown[] = [tenantId, workerRef, workerId];
      if (assignee) {
        params.push(assignee);
        clauses.push(`assignee = $${params.length}`);
      }
      const r = await client.query(
        `SELECT * FROM business_flow_tasks WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`,
        params,
      );
      return r.rows.map((row: any) => ({ ...row, available: availableTransitions(def, row.status) }));
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/energy/tasks/:id —— worker 只读详情（越权链点对点：非本人任务 → 403）
router.get('/energy/tasks/:id', async (req: any, res: any, next: any) => {
  try {
    const { workerId, workerRef, tid: tenantId } = await resolveWorkerIdentity(req);
    const item = await withTenantClient(tenantId, async (client: any) => {
      const def = await getWorkflowDefOrDefault(client, tenantId, ENTITY, ENERGY_COLLECTION_DEF);
      const r = await client.query(
        `SELECT * FROM business_flow_tasks WHERE id = $1 AND tenant_id = $2 AND entity_type = $3`,
        [req.params.id, tenantId, ENTITY],
      );
      if (!r.rows[0]) return null;
      const row = r.rows[0];
      if (row.data?.worker_ref !== workerRef && row.assignee !== workerId) {
        throw new AppError('ENERGY_FORBIDDEN', '非本人名下的能耗采集任务', 403);
      }
      return { ...row, available: availableTransitions(def, row.status) };
    });
    if (!item) throw new AppError('NOT_FOUND', 'energy collection task not found', 404);
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// workflow_def 配置验证端点（配置驱动实证）：GET /energy/def → 当前生效状态图
router.get('/energy/def', async (_req: any, res: any, next: any) => {
  try {
    const tenantId = process.env.ENERGY_DISPATCH_TENANT ?? DEFAULT_TENANT_ID;
    const def = await withTenantClient(tenantId, (client: any) =>
      getWorkflowDefOrDefault(client, tenantId, ENTITY, ENERGY_COLLECTION_DEF),
    );
    return res.json({ ok: true, code: 0, entity_type: ENTITY, source_note: 'workflow_def DB 行优先；无配置回退 ENERGY_COLLECTION_DEF 内置镜像态', def });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// T303b G4 状态回流：能源平台 form-submit 成功 → POST /energy/webhook/status-update
// 与 dispatch 同信任域（同密钥同签名域，复用 verifyEnergySignature）。
// 语义：验签 → task_ref 定位唯一任务 → 恰处于目标态（submitted）时重复回调
// 幂等回放 200（不 422；后续态/回退态不回放，由 workflow_def 引擎 422 裁决）→
// transitionEntity 按 workflow_def 引擎推进（非法跳转 BAD_STATE 422）。
// 目标态由 workflow_def 决定（能源侧只发事件 'submit'，映射见能源侧
// constants/youfuStatusMap.ts），本端不硬编码状态跳转表。
// ---------------------------------------------------------------------------
const StatusUpdateBody = z
  .object({
    task_ref: z.string().min(8).max(64),
    status: z.literal('submitted'), // 能源侧当前唯一可回流事件（form 回填完成）
    submitted_at: z.string().max(40).optional(),
    record_ref: z.string().max(64).nullable().optional(), // 能源库 youfu_form_submission.id 溯源
  })
  .strict();

router.post('/energy/webhook/status-update', async (req: any, res: any, next: any) => {
  try {
    verifyEnergyWebhook(req);
    const b = StatusUpdateBody.parse(req.body);
    const tenantId = process.env.ENERGY_DISPATCH_TENANT ?? DEFAULT_TENANT_ID;

    const result = await withTenantClient(tenantId, async (client: any) => {
      const found = await client.query(
        `SELECT * FROM business_flow_tasks
         WHERE tenant_id = $1 AND entity_type = $2 AND data->>'task_ref' = $3 LIMIT 1`,
        [tenantId, ENTITY, b.task_ref],
      );
      if (!found.rows[0]) {
        throw new AppError('NOT_FOUND', `energy collection task not found: ${b.task_ref}`, 404);
      }
      const row = found.rows[0];
      // 幂等回放边界（T303b-fix 修3 如实描述）：仅当任务当前 status 恰为
      // 'submitted'（即本次回调的目标态）时 200 回放——webhook 至少一次投递
      // 的必然伴生重复。若任务已被人工推进到 reviewed/archived 等后续态，
      // 重复回调不再回放，落入 transitionEntity 判非法跳转（422，S04 实证）；
      // 反向（回退态）同样 422，由 workflow_def 引擎统一裁决。
      if (row.status === b.status) {
        const def = await getWorkflowDefOrDefault(client, tenantId, ENTITY, ENERGY_COLLECTION_DEF);
        return { replay: true as const, item: { ...row, available: availableTransitions(def, row.status) } };
      }

      const extra: Record<string, unknown> = { submitted_by: 'energy-platform' };
      if (b.submitted_at !== undefined) extra.submitted_at = b.submitted_at;
      if (b.record_ref !== undefined) extra.record_ref = b.record_ref;
      const updated = await transitionEntity(client, tenantId, {
        table: 'business_flow_tasks',
        id: row.id,
        event: 'submit',
        entityType: ENTITY,
        fallbackDef: ENERGY_COLLECTION_DEF,
        actor: 'energy-webhook',
        extra,
      });
      return { replay: false as const, item: updated };
    });

    if (result.replay) {
      return res.status(200).json({ ok: true, code: 0, idempotent_replay: true, item: result.item });
    }
    return res.status(200).json({ ok: true, code: 0, item: result.item });
  } catch (e) {
    next(e);
  }
});

export default router;