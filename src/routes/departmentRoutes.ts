// 部门路由规则管理（2026-11-08）：部门自动识别的配置面。
//
// 规则语义见 repo/departmentResolver.ts：priority 降序，第一条命中的规则生效；
// 全部不命中 → dept.is_default 默认部门。本路由只做 CRUD，不在请求期执行业务判断。
//
// 权限：basicdata.edit（与部门主数据同权），读取也走同一权限，避免把内部路由条件暴露给一线。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { requirePermission } from '../middleware/role.js';
import { AppError } from '../middleware/error.js';

import { requireModuleWrites } from '../middleware/moduleGuard.js';

const router = Router();
router.use(requireModuleWrites('configuration', { only: [/^\/department-route-rules/] }));
router.use(requireModuleWrites('foundation', { only: [/^\/departments\/[^/]+\/default$/] }));


// 与 departmentResolver 的 MatchContext 对齐；strict 拒绝未知键，避免"配了但永不命中"。
const matchSchema = z.object({
  business_type: z.string().min(1).max(50).optional(),
  catalog_id: z.string().uuid().optional(),
  catalog_code: z.string().min(1).max(100).optional(),
  catalog_name_contains: z.string().min(1).max(100).optional(),
  location_id: z.string().uuid().optional(),
  location_name_contains: z.string().min(1).max(100).optional(),
  asset_id: z.string().uuid().optional(),
  asset_code: z.string().min(1).max(100).optional(),
  reporter_id: z.string().uuid().optional(),
  source: z.string().min(1).max(50).optional(),
  description_contains: z.string().min(1).max(200).optional(),
}).strict();

const bodySchema = z.object({
  name: z.string().min(1).max(100),
  priority: z.number().int().min(0).max(1000).optional(),
  enabled: z.boolean().optional(),
  department_id: z.string().uuid(),
  match: matchSchema,
});

const updateSchema = bodySchema.partial();

interface RuleRow {
  id: string;
  tenant_id: string;
  name: string;
  priority: number;
  enabled: boolean;
  match_json: unknown;
  department_id: string;
  department_name?: string | null;
  created_at: string;
  updated_at: string;
}

function publicRule(r: RuleRow) {
  return {
    id: r.id,
    name: r.name,
    priority: r.priority,
    enabled: r.enabled,
    match: r.match_json ?? {},
    department_id: r.department_id,
    department_name: r.department_name ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

async function assertDept(client: any, tenantId: string, departmentId: string): Promise<void> {
  const r = await client.query('SELECT 1 FROM dept WHERE tenant_id=$1 AND id=$2 LIMIT 1', [tenantId, departmentId]);
  if (r.rowCount === 0) throw new AppError('BAD_PARAM', 'department_id 不存在或不属于当前租户', 422);
}

// GET /department-route-rules
router.get('/department-route-rules', async (_req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const items = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'basicdata.edit');
      const r = await client.query<RuleRow>(
        `SELECT r.*, d.name AS department_name
           FROM department_route_rule r
           LEFT JOIN dept d ON d.id = r.department_id AND d.tenant_id = r.tenant_id
          WHERE r.tenant_id = $1
          ORDER BY r.priority DESC, r.created_at ASC`,
        [tenantId],
      );
      return r.rows.map(publicRule);
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// POST /department-route-rules
router.post('/department-route-rules', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const body = bodySchema.parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'basicdata.edit');
      await assertDept(client, tenantId, body.department_id);
      const r = await client.query<RuleRow>(
        `INSERT INTO department_route_rule (tenant_id, name, priority, enabled, match_json, department_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          tenantId,
          body.name,
          body.priority ?? 100,
          body.enabled ?? true,
          JSON.stringify(body.match),
          body.department_id,
        ],
      );
      return publicRule(r.rows[0]);
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// PUT /department-route-rules/:id
router.put('/department-route-rules/:id', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const body = updateSchema.parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'basicdata.edit');
      if (body.department_id) await assertDept(client, tenantId, body.department_id);
      const sets: string[] = [];
      const params: unknown[] = [tenantId, req.params.id];
      const add = (col: string, v: unknown) => {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      };
      if (body.name !== undefined) add('name', body.name);
      if (body.priority !== undefined) add('priority', body.priority);
      if (body.enabled !== undefined) add('enabled', body.enabled);
      if (body.department_id !== undefined) add('department_id', body.department_id);
      if (body.match !== undefined) add('match_json', JSON.stringify(body.match));
      if (sets.length === 0) throw new AppError('BAD_PARAM', '没有可更新的字段', 422);
      const r = await client.query<RuleRow>(
        `UPDATE department_route_rule SET ${sets.join(', ')}, updated_at = now()
          WHERE tenant_id=$1 AND id=$2 RETURNING *`,
        params,
      );
      if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'department route rule not found', 404);
      return publicRule(r.rows[0]);
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// DELETE /department-route-rules/:id
router.delete('/department-route-rules/:id', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'basicdata.edit');
      const r = await client.query('DELETE FROM department_route_rule WHERE tenant_id=$1 AND id=$2', [
        tenantId,
        req.params.id,
      ]);
      if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'department route rule not found', 404);
    });
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

// PUT /departments/:id/default —— 设租户默认部门（识别不到时兜底）。
// 唯一默认由 dept_one_default_per_tenant 部分索引保证：同一事务内先清旧、再设新。
router.put('/departments/:id/default', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'basicdata.edit');
      await client.query('UPDATE dept SET is_default=false WHERE tenant_id=$1 AND is_default=true AND id<>$2', [
        tenantId,
        req.params.id,
      ]);
      const r = await client.query(
        'UPDATE dept SET is_default=true WHERE tenant_id=$1 AND id=$2 RETURNING id,tenant_id,name,code,is_default',
        [tenantId, req.params.id],
      );
      if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'department not found', 404);
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

export default router;
