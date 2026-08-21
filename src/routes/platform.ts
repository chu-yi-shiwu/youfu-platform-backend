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
// E1：附带达标基线（R10 红绿灯阈值，后端常量可配）+ 效能指数（V5，来自聚合函数 eff_index）。
export const BASELINE = {
  close_rate_min: 0.8,       // 闭环率 ≥ 80%
  overdue_rate_max: 0.1,     // 超时率 ≤ 10%
  satisfaction_min: 4.0,     // 满意度 ≥ 4.0
  eff_index_min: 0.7,        // 效能指数 ≥ 0.7
};
router.get('/summary', async (req, res, next) => {
  try {
    const r = await pool.query(`SELECT * FROM platform_tenant_summary()`);
    await audit(res.locals.platformAdmin!.username, 'tenant.summary', null, null, null);
    // E1：每租户达标判定（红绿灯：green 全达标 / yellow 部分 / red 关键项不达标）
    const items = r.rows.map((row: any) => {
      const cr = row.close_rate === null ? null : Number(row.close_rate);
      const or = row.overdue_rate === null ? null : Number(row.overdue_rate);
      const sa = row.satisfaction_avg === null ? null : Number(row.satisfaction_avg);
      const ei = row.eff_index === null ? null : Number(row.eff_index);
      const checks = [
        cr !== null && cr >= BASELINE.close_rate_min,
        or !== null && or <= BASELINE.overdue_rate_max,
        sa !== null && sa >= BASELINE.satisfaction_min,
      ];
      const known = checks.filter((c) => c !== null);
      const pass = known.filter(Boolean).length;
      let light: 'red' | 'yellow' | 'green' = 'red';
      if (known.length === 0) light = 'yellow';
      else if (pass === known.length) light = 'green';
      else if (pass >= 1 && (cr === null || cr >= BASELINE.close_rate_min)) light = 'yellow';
      return {
        ...row,
        close_rate: cr,
        overdue_rate: or,
        satisfaction_avg: sa,
        eff_index: ei,
        baseline: BASELINE,
        light,
        checked: known.length,
        passed: pass,
      };
    });
    return res.json({ ok: true, code: 0, items, baseline: BASELINE });
  } catch (e) {
    next(e);
  }
});

export default router;
