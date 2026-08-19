// 应急模块（P2 第二刀）：应急预案库（知识库/目录）+ 预警中心（告警）。
// 风格对齐 inspection.ts：withTenantClient 注入租户/RLS；写操作 requireConfigRole；占位符防注入。
// 预警深化：巡检异常（inspection.ts 调用 createAlert）等业务异常统一落入 alert，前端预警中心统一处理。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requireConfigRole } from '../middleware/role.js';
import { emitDomainEvent } from '../db/eventBus.js';

const router = Router();

// ============ 应急预案库 ============
const planSchema = z.object({
  code: z.string().optional(),
  title: z.string().min(1),
  category: z.string().min(1).default('general'),
  level: z.string().min(1).default('L3'),
  content: z.string().optional(),
  steps: z
    .array(z.object({ title: z.string(), detail: z.string().optional() }))
    .optional(),
  owner: z.string().optional(),
  contact_phone: z.string().optional(),
  enabled: z.boolean().optional(),
  applicable_scene: z.string().optional(),
  trigger_condition: z.string().optional(),
  response_org: z.string().optional(),
  materials: z.string().optional(),
  related_asset_area: z.string().optional(),
  drill_record: z.string().optional(),
});

router.get('/plans', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { category, level, keyword, enabled } = req.query as Record<string, string>;
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    if (category) {
      params.push(category);
      clauses.push(`category = $${params.length}`);
    }
    if (level) {
      params.push(level);
      clauses.push(`level = $${params.length}`);
    }
    if (enabled !== undefined) {
      params.push(enabled === 'true');
      clauses.push(`enabled = $${params.length}`);
    }
    if (keyword) {
      params.push(`%${keyword}%`, `%${keyword}%`);
      clauses.push(
        `(title ILIKE $${params.length - 1} OR content ILIKE $${params.length})`,
      );
    }
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT * FROM emergency_plan WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, created_at DESC`,
          params,
        )
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.get('/plans/:id', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT * FROM emergency_plan WHERE id = $1 AND tenant_id = $2`, [
          req.params.id,
          tenantId,
        ])
        .then((r) => r.rows[0] ?? null),
    );
    if (!item) throw new AppError('NOT_FOUND', 'plan not found', 404);
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.post('/plans', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = planSchema.parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const r = await client.query(
        `INSERT INTO emergency_plan (tenant_id, code, title, category, level, content, steps, owner, contact_phone, enabled, applicable_scene, trigger_condition, response_org, materials, related_asset_area, drill_record)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [
          tenantId,
          b.code ?? null,
          b.title,
          b.category,
          b.level,
          b.content ?? null,
          b.steps ? JSON.stringify(b.steps) : '[]',
          b.owner ?? null,
          b.contact_phone ?? null,
          b.enabled ?? true,
          b.applicable_scene ?? null,
          b.trigger_condition ?? null,
          b.response_org ?? null,
          b.materials ?? null,
          b.related_asset_area ?? null,
          b.drill_record ?? null,
        ],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'emergency_plan', entityId: row.id, type: 'create', actor: 'config_role' });
      return row;
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.put('/plans/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = planSchema.partial().parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM emergency_plan WHERE id = $1 AND tenant_id = $2`, [
        req.params.id,
        tenantId,
      ]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'plan not found', 404);
      const c = cur.rows[0];
      const r = await client.query(
        `UPDATE emergency_plan
         SET code=COALESCE($3,code), title=COALESCE($4,title), category=COALESCE($5,category),
             level=COALESCE($6,level), content=COALESCE($7,content),
             steps=COALESCE($8,steps), owner=COALESCE($9,owner),
             contact_phone=COALESCE($10,contact_phone), enabled=COALESCE($11,enabled),
             applicable_scene=COALESCE($12,applicable_scene),
             trigger_condition=COALESCE($13,trigger_condition),
             response_org=COALESCE($14,response_org),
             materials=COALESCE($15,materials),
             related_asset_area=COALESCE($16,related_asset_area),
             drill_record=COALESCE($17,drill_record),
             updated_at=now()
         WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        [
          req.params.id,
          tenantId,
          b.code ?? c.code,
          b.title ?? c.title,
          b.category ?? c.category,
          b.level ?? c.level,
          b.content ?? c.content,
          b.steps ? JSON.stringify(b.steps) : JSON.stringify(c.steps),
          b.owner ?? c.owner,
          b.contact_phone ?? c.contact_phone,
          b.enabled ?? c.enabled,
          b.applicable_scene ?? c.applicable_scene,
          b.trigger_condition ?? c.trigger_condition,
          b.response_org ?? c.response_org,
          b.materials ?? c.materials,
          b.related_asset_area ?? c.related_asset_area,
          b.drill_record ?? c.drill_record,
        ],
      );
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.delete('/plans/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const n = await withTenantClient(tenantId, (client) =>
      client
        .query(`DELETE FROM emergency_plan WHERE id = $1 AND tenant_id = $2`, [
          req.params.id,
          tenantId,
        ])
        .then((r) => r.rowCount ?? 0),
    );
    if (n === 0) throw new AppError('NOT_FOUND', 'plan not found', 404);
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

// ============ 预警中心 ============
const alertSchema = z.object({
  source_type: z.string().min(1),
  source_id: z.string().optional(),
  level: z.string().min(1).default('L2'),
  title: z.string().min(1),
  message: z.string().optional(),
  related_plan_id: z.string().uuid().optional(),
});

// 内部复用：业务异常统一落 alert（inspection.ts 巡检异常调用）。
export async function createAlert(
  client: any,
  tenantId: string,
  input: { source_type: string; source_id?: string; level: string; title: string; message?: string; related_plan_id?: string },
): Promise<any> {
  const r = await client.query(
    `INSERT INTO alert (tenant_id, source_type, source_id, level, title, message, related_plan_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING *`,
    [
      tenantId,
      input.source_type,
      input.source_id ?? null,
      input.level,
      input.title,
      input.message ?? null,
      input.related_plan_id ?? null,
    ],
  );
  const row = r.rows[0];
  await emitDomainEvent(client, { tenantId, entityType: 'alert', entityId: row.id, type: 'create', actor: 'system', payload: { source_type: input.source_type } });
  return row;
}

router.get('/alerts', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { status, level, source_type } = req.query as Record<string, string>;
    const clauses = ['a.tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      clauses.push(sql.replace('?', `$${params.length}`));
    };
    if (status) add('status = ?', status);
    if (level) add('level = ?', level);
    if (source_type) add('source_type = ?', source_type);
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT a.*, p.title AS plan_title
           FROM alert a LEFT JOIN emergency_plan p ON p.id = a.related_plan_id
           WHERE ${clauses.join(' AND ')} ORDER BY a.created_at DESC`,
          params,
        )
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.post('/alerts', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = alertSchema.parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const row = await createAlert(client, tenantId, {
        source_type: b.source_type,
        source_id: b.source_id,
        level: b.level,
        title: b.title,
        message: b.message,
        related_plan_id: b.related_plan_id,
      });
      return row;
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 处理 / 忽略预警（状态机：pending → handling → handled / ignored）
router.post('/alerts/:id/handle', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ status: z.enum(['handling', 'handled', 'ignored']), handler: z.string().optional() }).parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM alert WHERE id = $1 AND tenant_id = $2`, [
        req.params.id,
        tenantId,
      ]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'alert not found', 404);
      const r = await client.query(
        `UPDATE alert SET status=$3, handler=COALESCE($4,handler), handled_at=CASE WHEN $3 IN ('handled','ignored') THEN now() ELSE handled_at END, updated_at=now()
         WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        [req.params.id, tenantId, b.status, b.handler ?? null],
      );
      await emitDomainEvent(client, { tenantId, entityType: 'alert', entityId: req.params.id, type: b.status, actor: 'config_role' });
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 预警关联应急预案（预警深化：异常 → 人工/自动匹配预案）
router.post('/alerts/:id/link-plan', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ plan_id: z.string().uuid() }).parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM alert WHERE id = $1 AND tenant_id = $2`, [
        req.params.id,
        tenantId,
      ]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'alert not found', 404);
      const plan = await client.query(`SELECT id FROM emergency_plan WHERE id=$1 AND tenant_id=$2`, [
        b.plan_id,
        tenantId,
      ]);
      if (plan.rowCount === 0) throw new AppError('NOT_FOUND', 'plan not found', 404);
      const r = await client.query(
        `UPDATE alert SET related_plan_id=$3, updated_at=now() WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        [req.params.id, tenantId, b.plan_id],
      );
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 预警统计（预警中心头卡）：待处理总数 + 按等级分布
router.get('/alerts/stats', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const stats = await withTenantClient(tenantId, async (client) => {
      const byStatus = await client
        .query(`SELECT status, COUNT(*)::int AS c FROM alert WHERE tenant_id=$1 GROUP BY status`, [tenantId])
        .then((r: any) => r.rows);
      const byLevel = await client
        .query(`SELECT level, COUNT(*)::int AS c FROM alert WHERE tenant_id=$1 AND status IN ('pending','handling') GROUP BY level`, [tenantId])
        .then((r: any) => r.rows);
      const pending = byStatus.filter((x: any) => x.status === 'pending').reduce((s: number, x: any) => s + Number(x.c), 0);
      const handling = byStatus.filter((x: any) => x.status === 'handling').reduce((s: number, x: any) => s + Number(x.c), 0);
      const levelMap: Record<string, number> = {};
      for (const x of byLevel) levelMap[x.level] = Number(x.c);
      return { pending, handling, open: pending + handling, by_level: levelMap };
    });
    return res.json({ ok: true, code: 0, stats });
  } catch (e) {
    next(e);
  }
});

export default router;
