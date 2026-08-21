// 城市级平台层路由（E_min：租户注册表 + 跨租户聚合 + 审计）。
// 挂载于 /api/v1/platform；除 /auth/login 外均需 platformAdminAuth（G1）。
// 平台表（tenant_registry/platform_admin/platform_audit）无 RLS，pool 直连；
// 聚合走 SECURITY DEFINER 函数（绕过 RLS，只出聚合指标，R2 不下钻）。
import { Router } from 'express';
import { z } from 'zod';
import pool from '../db/pool.js';
import { signJwt, AUTH_MODE } from '../middleware/auth.js';
import { platformAdminAuth } from '../middleware/platformAuth.js';
import { verifyPassword } from '../account.js';

const router = Router();

// ---- 审计（append-only：表只 GRANT SELECT/INSERT；失败不阻断主流程） ----
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
  } catch {
    /* ignore */
  }
}

// ---- POST /platform/auth/login —— 平台管理员登录（公开） ----
router.post('/auth/login', async (req, res, next) => {
  try {
    const { username, password } = z.object({ username: z.string().min(1), password: z.string().min(1) }).parse(req.body);
    const r = await pool.query(
      `SELECT id, username, password_hash, display_name, active FROM platform_admin WHERE username = $1`,
      [username],
    );
    if (r.rowCount === 0 || !r.rows[0].active || !verifyPassword(password, r.rows[0].password_hash)) {
      return res.status(401).json({ ok: false, code: 'PLATFORM_AUTH_003', message: 'invalid platform credentials' });
    }
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ ok: false, code: 'AUTH_CFG', message: 'JWT_SECRET not configured' });
    }
    const admin = r.rows[0];
    const token = signJwt(
      { sub: admin.id, platform: true, role: 'platform_admin', username: admin.username },
      secret,
    );
    await audit(admin.username, 'platform.login', null, null, { ip: req.ip ?? null });
    return res.json({
      ok: true,
      code: 0,
      token,
      admin: { id: admin.id, username: admin.username, display_name: admin.display_name },
    });
  } catch (e) {
    next(e);
  }
});

// ---- 以下全部需要平台管理员认证 ----
router.use(platformAdminAuth);

// ---- GET /platform/tenants —— 租户注册表列表 ----
router.get('/tenants', async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT tenant_id, name, category, status, parent_id, quota, created_at, updated_at
       FROM tenant_registry ORDER BY tenant_id`,
    );
    await audit(res.locals.platformAdmin!.username, 'tenant.list', null, null, null);
    return res.json({ ok: true, code: 0, items: r.rows });
  } catch (e) {
    next(e);
  }
});

// ---- PUT /platform/tenants/:id/status —— 开通/停用租户 ----
router.put('/tenants/:id/status', async (req, res, next) => {
  try {
    const admin = res.locals.platformAdmin!;
    const tenantId = req.params.id;
    const body = z.object({ status: z.enum(['active', 'suspended']) }).parse(req.body);
    const r = await pool.query(
      `UPDATE tenant_registry SET status = $1, updated_at = now() WHERE tenant_id = $2 RETURNING tenant_id, name, status`,
      [body.status, tenantId],
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ ok: false, code: 'TENANT_404', message: 'tenant not registered' });
    }
    await audit(admin.username, `tenant.${body.status}`, tenantId, tenantId, null);
    return res.json({ ok: true, code: 0, item: r.rows[0] });
  } catch (e) {
    next(e);
  }
});

// ---- GET /platform/summary —— 跨租户聚合指标（SECURITY DEFINER，只出聚合） ----
router.get('/summary', async (req, res, next) => {
  try {
    const r = await pool.query(`SELECT * FROM platform_tenant_summary()`);
    await audit(res.locals.platformAdmin!.username, 'tenant.summary', null, null, null);
    return res.json({ ok: true, code: 0, items: r.rows });
  } catch (e) {
    next(e);
  }
});

export default router;
