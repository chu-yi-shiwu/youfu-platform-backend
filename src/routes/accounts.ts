// ② 主数据补全：账号(account_user) 管理 CRUD。
// account_user 表由 007_account.sql 建好（登录账户体系，含密码哈希）；此前仅 auth.ts 内部登录/读取，
// 缺「管理员维护账户」的路由。本文件补齐 list/get/create/update/delete，
// 复用 src/account.ts 的 hashPassword（scrypt，零依赖）与 toPublic（不外泄 password_hash）。
// 写操作 requireConfigRole（仅 admin/operator 可管理账户）。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requireConfigRole } from '../middleware/role.js';
import { hashPassword, toPublic } from '../account.js';

const router = Router();

const COLS = 'id, tenant_id, username, display_name, role, active';

const accountCreateSchema = z.object({
  username: z.string().min(2),
  password: z.string().min(6),
  display_name: z.string().optional(),
  role: z.enum(['admin', 'operator']).optional(),
});

const accountUpdateSchema = z.object({
  display_name: z.string().optional(),
  role: z.enum(['admin', 'operator']).optional(),
  active: z.boolean().optional(),
  password: z.string().min(6).optional(), // 可选：重置密码
});

// ============ 账户列表（不外泄密码哈希） ============
router.get('/accounts', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT ${COLS} FROM account_user WHERE tenant_id=$1 ORDER BY username`, [tenantId])
        .then((r) => r.rows.map(toPublic)),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// ============ 账户详情 ============
router.get('/accounts/:id', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT ${COLS} FROM account_user WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId])
        .then((r) => (r.rowCount ? toPublic(r.rows[0]) : null)),
    );
    if (!item) throw new AppError('NOT_FOUND', 'account not found', 404);
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// ============ 新建账户 ============
router.post('/accounts', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = accountCreateSchema.parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const dup = await client.query(
        `SELECT 1 FROM account_user WHERE tenant_id=$1 AND username=$2 LIMIT 1`,
        [tenantId, b.username],
      );
      if (dup.rowCount && dup.rowCount > 0) {
        throw new AppError('CONFLICT', '该租户下用户名已存在', 409);
      }
      const r = await client.query(
        `INSERT INTO account_user (tenant_id, username, password_hash, display_name, role, active)
         VALUES ($1,$2,$3,$4,$5,true) RETURNING ${COLS}`,
        [tenantId, b.username, hashPassword(b.password), b.display_name ?? null, b.role ?? 'operator'],
      );
      return toPublic(r.rows[0]);
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// ============ 更新账户（显示名/角色/启用/可选重置密码） ============
router.put('/accounts/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = accountUpdateSchema.parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT ${COLS} FROM account_user WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'account not found', 404);
      const sets: string[] = [];
      const params: unknown[] = [req.params.id, tenantId];
      const set = (col: string, v: unknown) => {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      };
      if (b.display_name !== undefined) set('display_name', b.display_name);
      if (b.role !== undefined) set('role', b.role);
      if (b.active !== undefined) set('active', b.active);
      if (b.password !== undefined) set('password_hash', hashPassword(b.password));
      if (sets.length === 0) return toPublic(cur.rows[0]);
      sets.push('updated_at = now()');
      const r = await client.query(
        `UPDATE account_user SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING ${COLS}`,
        params,
      );
      return toPublic(r.rows[0]);
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// ============ 删除账户（保护：至少保留一个活跃管理员，避免锁死登录） ============
router.delete('/accounts/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const n = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT role, active FROM account_user WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'account not found', 404);
      const target = cur.rows[0];
      if (target.role === 'admin' && target.active) {
        const admins = await client.query(
          `SELECT 1 FROM account_user WHERE tenant_id=$1 AND role='admin' AND active=true`,
          [tenantId],
        );
        if (admins.rowCount && admins.rowCount <= 1) {
          throw new AppError('CONFLICT', '至少需保留一个活跃管理员，无法删除', 409);
        }
      }
      const r = await client.query(`DELETE FROM account_user WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      return r.rowCount ?? 0;
    });
    if (n === 0) throw new AppError('NOT_FOUND', 'account not found', 404);
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

export default router;
