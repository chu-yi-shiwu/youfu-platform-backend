// 模块授权（租户级 / 部门级）+ 部门成员角色分配。
//
// 边界（必须与移动端约定一致）：
// - 模块只控 PC 管理面；个人任务执行、志愿参与、扫码查询一律不受模块开关影响。
// - 租户管理员是角色与权限的唯一配置源；部门管理员只能从租户已有角色中分配，
//   不能新建角色、不能改角色权限、不能分配 admin。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { emitDomainEvent } from '../db/eventBus.js';
import { AppError } from '../middleware/error.js';
import type { AuthLocals } from '../middleware/auth.js';
import { canOperateAccount, ROLE_CODE_RE } from '../middleware/role.js';
import {
  assertDepartmentManager,
  assertModuleKeys,
  assertTenantAdmin,
  assignableRoles,
  departmentModules,
  tenantModules,
} from '../modules/service.js';

const router = Router();

const modulePatchSchema = z.object({
  modules: z
    .array(z.object({ key: z.string().min(1).max(64), enabled: z.boolean() }))
    .min(1)
    .max(64),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function assertDepartmentExists(client: import('pg').PoolClient, tenantId: string, departmentId: string): Promise<void> {
  if (!UUID_RE.test(departmentId)) throw new AppError('BAD_PARAM', 'invalid department id', 400);
  const r = await client.query(`SELECT 1 FROM dept WHERE tenant_id=$1 AND id=$2 LIMIT 1`, [tenantId, departmentId]);
  if ((r.rowCount ?? 0) === 0) throw new AppError('NOT_FOUND', 'department not found', 404);
}

// GET /tenant/modules —— 租户模块目录与开关（仅租户管理员）。
router.get('/tenant/modules', async (req, res, next) => {
  try {
    const auth = res.locals.auth as AuthLocals;
    assertTenantAdmin(auth);
    const items = await withTenantClient(auth.tenantId, (client) => tenantModules(client, auth.tenantId));
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// PUT /tenant/modules —— 只有租户管理员能改租户级开关。
router.put('/tenant/modules', async (req, res, next) => {
  try {
    const auth = res.locals.auth as AuthLocals;
    assertTenantAdmin(auth);
    const body = modulePatchSchema.parse(req.body);
    assertModuleKeys(body.modules);

    const items = await withTenantClient(auth.tenantId, async (client) => {
      for (const m of body.modules) {
        await client.query(
          `INSERT INTO tenant_module (tenant_id, module_key, enabled, updated_at, updated_by)
           VALUES ($1,$2,$3,now(),$4)
           ON CONFLICT (tenant_id, module_key)
           DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=now(), updated_by=EXCLUDED.updated_by`,
          [auth.tenantId, m.key, m.enabled, auth.username ?? auth.role ?? 'system'],
        );
      }
      await emitDomainEvent(client, {
        tenantId: auth.tenantId,
        entityType: 'tenant_module',
        entityId: auth.tenantId,
        type: 'tenant_modules_updated',
        actor: auth.username ?? auth.role ?? 'system',
        payload: { modules: body.modules },
      });
      return tenantModules(client, auth.tenantId);
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// GET /departments/:id/modules —— 租户管理员或本部门管理员。
router.get('/departments/:id/modules', async (req, res, next) => {
  try {
    const auth = res.locals.auth as AuthLocals;
    const departmentId = req.params.id;
    const items = await withTenantClient(auth.tenantId, async (client) => {
      await assertDepartmentExists(client, auth.tenantId, departmentId);
      await assertDepartmentManager(auth, client, departmentId);
      return departmentModules(client, auth.tenantId, departmentId);
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// PUT /departments/:id/modules —— 部门只能在租户已启用范围内收紧，不能越权扩展。
router.put('/departments/:id/modules', async (req, res, next) => {
  try {
    const auth = res.locals.auth as AuthLocals;
    const departmentId = req.params.id;
    const body = modulePatchSchema.parse(req.body);
    assertModuleKeys(body.modules);

    const items = await withTenantClient(auth.tenantId, async (client) => {
      await assertDepartmentExists(client, auth.tenantId, departmentId);
      await assertDepartmentManager(auth, client, departmentId);
      const tenant = await tenantModules(client, auth.tenantId);
      const tenantMap = new Map(tenant.map((m) => [m.key, m.enabled]));
      const illegal = body.modules.filter((m) => m.enabled && !tenantMap.get(m.key));
      if (illegal.length > 0) {
        throw new AppError(
          'MODULE_TENANT_DISABLED',
          `租户未启用，部门不能启用：${illegal.map((m) => m.key).join('、')}`,
          422,
        );
      }
      for (const m of body.modules) {
        await client.query(
          `INSERT INTO department_module (tenant_id, department_id, module_key, enabled, updated_at, updated_by)
           VALUES ($1,$2,$3,$4,now(),$5)
           ON CONFLICT (tenant_id, department_id, module_key)
           DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=now(), updated_by=EXCLUDED.updated_by`,
          [auth.tenantId, departmentId, m.key, m.enabled, auth.username ?? auth.role ?? 'system'],
        );
      }
      await emitDomainEvent(client, {
        tenantId: auth.tenantId,
        entityType: 'department',
        entityId: departmentId,
        type: 'department_modules_updated',
        actor: auth.username ?? auth.role ?? 'system',
        payload: { department_id: departmentId, modules: body.modules },
      });
      return departmentModules(client, auth.tenantId, departmentId);
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// GET /departments/:id/members —— 部门成员（账号 + 岗位角色）+ 当前操作人可分配的角色。
router.get('/departments/:id/members', async (req, res, next) => {
  try {
    const auth = res.locals.auth as AuthLocals;
    const departmentId = req.params.id;
    const data = await withTenantClient(auth.tenantId, async (client) => {
      await assertDepartmentExists(client, auth.tenantId, departmentId);
      await assertDepartmentManager(auth, client, departmentId);
      const rows = await client.query(
        `SELECT a.id AS account_id, a.username, a.display_name, a.role, a.active,
                w.id AS worker_id, w.name AS worker_name
           FROM worker w
           JOIN account_user a ON a.id::text = w.account_id AND a.tenant_id = w.tenant_id
          WHERE w.tenant_id=$1 AND w.department_id=$2
          ORDER BY w.name, a.username`,
        [auth.tenantId, departmentId],
      );
      const roles = await assignableRoles(client, auth.tenantId, auth);
      return { items: rows.rows, roles };
    });
    return res.json({ ok: true, code: 0, ...data });
  } catch (e) {
    next(e);
  }
});

// PUT /departments/:id/members/:accountId/role —— 分配租户已有角色（不能提权、不能改 admin）。
router.put('/departments/:id/members/:accountId/role', async (req, res, next) => {
  try {
    const auth = res.locals.auth as AuthLocals;
    const { id: departmentId, accountId } = req.params;
    const body = z.object({ role: z.string().regex(ROLE_CODE_RE, 'invalid role code') }).parse(req.body);
    if (!UUID_RE.test(accountId)) throw new AppError('BAD_PARAM', 'invalid account id', 400);

    const item = await withTenantClient(auth.tenantId, async (client) => {
      await assertDepartmentExists(client, auth.tenantId, departmentId);
      await assertDepartmentManager(auth, client, departmentId);
      const target = await client.query<{ account_id: string; role: string }>(
        `SELECT a.id AS account_id, a.role
           FROM worker w
           JOIN account_user a ON a.id::text = w.account_id AND a.tenant_id = w.tenant_id
          WHERE w.tenant_id=$1 AND w.department_id=$2 AND a.id=$3
          LIMIT 1`,
        [auth.tenantId, departmentId, accountId],
      );
      if ((target.rowCount ?? 0) === 0) throw new AppError('NOT_FOUND', 'department member not found', 404);
      const row = target.rows[0];
      if (row.account_id === auth.userId) throw new AppError('FORBIDDEN', '不能修改自己的角色', 403);
      if (!canOperateAccount(auth.role, row.role)) throw new AppError('FORBIDDEN', '不能修改层级高于自己的账号', 403);
      if (row.role === 'admin') throw new AppError('FORBIDDEN', '不能修改租户管理员角色', 403);

      const roles = await assignableRoles(client, auth.tenantId, auth);
      if (!roles.includes(body.role)) {
        throw new AppError('ROLE_NOT_ASSIGNABLE', `该角色不可由当前操作人分配：${body.role}`, 403);
      }

      await client.query(
        `UPDATE account_user
            SET role=$1, token_version=token_version+1, updated_at=now()
          WHERE id=$2 AND tenant_id=$3`,
        [body.role, accountId, auth.tenantId],
      );
      await emitDomainEvent(client, {
        tenantId: auth.tenantId,
        entityType: 'department_member',
        entityId: accountId,
        type: 'department_member_role_updated',
        actor: auth.username ?? auth.role ?? 'system',
        payload: { department_id: departmentId, account_id: accountId, from: row.role, to: body.role },
      });
      return { account_id: accountId, role: body.role };
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

export default router;
