// 配置路由（批次 A）：派单规则 / 术语(各院叫法) / 系统(品牌) 三类自助配置 CRUD。
// 全部按租户隔离（withTenantClient 注入 tenant_id + RLS）。
// 权限：仅 admin/operator 可写（dev 模式默认 role=admin，prod 由 JWT role 控制）。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
// 审查修复（架构🟡12）：requireConfigRole 曾在 role.ts 与 config.ts 各实现一份（双份角色白名单，
// 改一处漏一处）。统一 re-export role.ts 的唯一实现，调用点零改动。
import { requireConfigRole, assertAdmin } from '../middleware/role.js';

const router = Router();

export { requireConfigRole };

// ============ dispatch_rule ============
const ruleSchema = z.object({
  name: z.string().min(1),
  priority: z.number().int().optional(),
  match_json: z
    .object({
      business_type: z.string().optional(),
      skill_tags: z.array(z.string()).optional(),
      priority: z.enum(['normal', 'urgent']).optional(),
    })
    .optional(),
  strategy_json: z
    .object({
      type: z.enum(['skill_match', 'load_balance']),
      skill_tags: z.array(z.string()).optional(),
    })
    .optional(),
  enabled: z.boolean().optional(),
});

router.get('/config/dispatch-rules', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT id, name, priority, match_json, strategy_json, enabled, created_at, updated_at
           FROM dispatch_rule WHERE tenant_id = $1 ORDER BY priority DESC, created_at ASC`,
          [tenantId],
        )
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.post('/config/dispatch-rules', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const body = ruleSchema.parse(req.body);
    const item = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `INSERT INTO dispatch_rule (tenant_id, name, priority, match_json, strategy_json, enabled)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [
            tenantId,
            body.name,
            body.priority ?? 100,
            JSON.stringify(body.match_json ?? {}),
            JSON.stringify(body.strategy_json ?? {}),
            body.enabled ?? true,
          ],
        )
        .then((r) => r.rows[0]),
    );
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.put('/config/dispatch-rules/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const body = ruleSchema.partial().parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(
        `SELECT * FROM dispatch_rule WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, tenantId],
      );
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'dispatch rule not found', 404);
      const c = cur.rows[0];
      const r = await client.query(
        `UPDATE dispatch_rule SET
           name = $3, priority = $4, match_json = $5, strategy_json = $6, enabled = $7, updated_at = now()
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [
          req.params.id,
          tenantId,
          body.name ?? c.name,
          body.priority ?? c.priority,
          body.match_json !== undefined ? JSON.stringify(body.match_json) : c.match_json,
          body.strategy_json !== undefined ? JSON.stringify(body.strategy_json) : c.strategy_json,
          body.enabled ?? c.enabled,
        ],
      );
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.delete('/config/dispatch-rules/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const n = await withTenantClient(tenantId, (client) =>
      client
        .query(`DELETE FROM dispatch_rule WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenantId])
        .then((r) => r.rowCount ?? 0),
    );
    if (n === 0) throw new AppError('NOT_FOUND', 'dispatch rule not found', 404);
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

// ============ term（各院叫法） ============
const termSchema = z.object({
  module: z.string().optional(),
  code: z.string().min(1),
  default_label: z.string().min(1),
  custom_label: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

function toTermRow(client: any, tenantId: string, body: z.infer<typeof termSchema>) {
  return client
    .query(
      `INSERT INTO term (tenant_id, module, code, default_label, custom_label, enabled)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, module, code)
       DO UPDATE SET custom_label = EXCLUDED.custom_label, enabled = EXCLUDED.enabled, updated_at = now()
       RETURNING *`,
      [
        tenantId,
        body.module ?? 'global',
        body.code,
        body.default_label,
        body.custom_label ?? null,
        body.enabled ?? true,
      ],
    )
    .then((r: any) => r.rows[0]);
}

router.get('/config/terms', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT id, module, code, default_label, custom_label, enabled, created_at, updated_at
           FROM term WHERE tenant_id = $1 ORDER BY module, code`,
          [tenantId],
        )
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.post('/config/terms', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const body = termSchema.parse(req.body);
    const item = await withTenantClient(tenantId, (client) => toTermRow(client, tenantId, body));
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.put('/config/terms/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const body = termSchema.partial().parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM term WHERE id = $1 AND tenant_id = $2`, [
        req.params.id,
        tenantId,
      ]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'term not found', 404);
      const c = cur.rows[0];
      const r = await client.query(
        `UPDATE term SET
           module = $3, code = $4, default_label = $5, custom_label = $6, enabled = $7, updated_at = now()
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [
          req.params.id,
          tenantId,
          body.module ?? c.module,
          body.code ?? c.code,
          body.default_label ?? c.default_label,
          body.custom_label === undefined ? c.custom_label : body.custom_label,
          body.enabled ?? c.enabled,
        ],
      );
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.delete('/config/terms/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const n = await withTenantClient(tenantId, (client) =>
      client
        .query(`DELETE FROM term WHERE id = $1 AND tenant_id = $2`, [req.params.id, tenantId])
        .then((r) => r.rowCount ?? 0),
    );
    if (n === 0) throw new AppError('NOT_FOUND', 'term not found', 404);
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

// ============ system_config（品牌等） ============
const systemItemSchema = z.object({
  key: z.string().min(1),
  value: z.string().nullable().optional(),
});

router.get('/config/system', async (req, res, next) => {
  try {
    // R38-R3-F1 修复：系统配置（key/value）此前 GET 无守卫，operator/reporter 均可读。
    // 前端零调用此端点，收紧为 admin-only；写入侧本就有 requireConfigRole。
    // 审查修复（架构🟡12）：admin 判定改引 role.ts 的 assertAdmin（ROLE_RANK 单一事实源）。
    assertAdmin(res.locals.auth, 'admin only');
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT id, key, value, updated_at FROM system_config WHERE tenant_id = $1`,
          [tenantId],
        )
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// 批量 upsert 系统配置，body: { items: [{key, value}] }
router.put('/config/system', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const body = z.object({ items: z.array(systemItemSchema) }).parse(req.body);
    const items = await withTenantClient(tenantId, async (client) => {
      const out: any[] = [];
      for (const it of body.items) {
        const r = await client.query(
          `INSERT INTO system_config (tenant_id, key, value, updated_at)
           VALUES ($1,$2,$3,now())
           ON CONFLICT (tenant_id, key)
           DO UPDATE SET value = EXCLUDED.value, updated_at = now()
           RETURNING *`,
          [tenantId, it.key, it.value ?? null],
        );
        out.push(r.rows[0]);
      }
      return out;
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

export default router;
