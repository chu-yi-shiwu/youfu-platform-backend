// 城市级平台层路由（E_min：租户注册表 + 跨租户聚合 + 审计）。
// 挂载于 /api/v1/platform；除 /auth/login 外均需 platformAdminAuth（G1）。
// 平台表（tenant_registry/platform_admin/platform_audit）无 RLS，pool 直连；
// 聚合走 SECURITY DEFINER 函数（绕过 RLS，只出聚合指标，R2 不下钻）。
import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import pool from '../db/pool.js';
import { signJwt, AUTH_MODE } from '../middleware/auth.js';
import { platformAdminAuth } from '../middleware/platformAuth.js';
import { verifyPassword, hashPassword } from '../account.js';

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

// ============ E0_open · 开放应用管理（平台侧 CRUD） ============

const appCreateSchema = z.object({
  name: z.string().min(2).max(64),
  owner: z.string().max(64).optional(),
  scopes: z.array(z.string()).default(['summary:read']),
  quotas: z.record(z.string(), z.any()).optional(),
});

// 生成 app_key（公钥标识）与 app_secret（密钥，仅创建时明文返回一次）
function genCreds(): { key: string; secret: string } {
  return {
    key: `ak_${crypto.randomBytes(12).toString('hex')}`,
    secret: `sk_${crypto.randomBytes(24).toString('hex')}`,
  };
}
// #5 修复：salt 环境化（与 openApiAuth 一致）
const SECRET_SALT = process.env.APP_SECRET_SALT ?? 'youfu-app-secret-salt';
function sha256Secret(s: string): string {
  return crypto.createHmac('sha256', SECRET_SALT).update(s).digest('hex');
}

// GET /platform/apps —— 应用列表（secret 不返回，仅展示 key/scopes/状态）
router.get('/apps', async (_req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT id, app_name, app_key, owner, scopes, quotas, status, created_at
       FROM open_api_app ORDER BY created_at DESC`,
    );
    return res.json({ ok: true, code: 0, items: r.rows });
  } catch (e) {
    next(e);
  }
});

// POST /platform/apps —— 创建应用（返回 app_key + app_secret，secret 仅此一次）
router.post('/apps', async (req, res, next) => {
  try {
    const b = appCreateSchema.parse(req.body);
    const creds = genCreds();
    // #4 修复：不再存明文 app_secret（只存 secret_hash；053b 已 DROP 明文列）
    const r = await pool.query(
      `INSERT INTO open_api_app (app_name, app_key, secret_hash, owner, scopes, quotas)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, app_name, app_key, status`,
      [b.name, creds.key, sha256Secret(creds.secret), b.owner ?? null, JSON.stringify(b.scopes), JSON.stringify(b.quotas ?? {})],
    );
    await audit(res.locals.platformAdmin!.username, 'app.create', r.rows[0].id, null, { name: b.name });
    // 明文 secret 仅本次返回
    return res.status(201).json({ ok: true, code: 0, item: { ...r.rows[0], app_secret: creds.secret } });
  } catch (e) {
    next(e);
  }
});

// PUT /platform/apps/:id/revoke —— 吊销应用（立即失效，不可逆）
router.put('/apps/:id/revoke', async (req, res, next) => {
  try {
    const r = await pool.query(
      `UPDATE open_api_app SET status='revoked', updated_at=now() WHERE id=$1 AND status='active' RETURNING id, app_name, status`,
      [req.params.id],
    );
    if (r.rowCount === 0) {
      // 不存在或已吊销
      const ex = await pool.query(`SELECT id FROM open_api_app WHERE id=$1`, [req.params.id]);
      if (ex.rowCount === 0) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'app not found' });
      return res.json({ ok: true, code: 0, item: { id: req.params.id, status: 'revoked' } });
    }
    await audit(res.locals.platformAdmin!.username, 'app.revoke', r.rows[0].id, null, { name: r.rows[0].app_name });
    return res.json({ ok: true, code: 0, item: r.rows[0] });
  } catch (e) {
    next(e);
  }
});

// ---- PUT /platform/auth/password —— 平台管理员修改自己的密码（登录态 + 旧密码校验） ----
router.put('/auth/password', async (req, res, next) => {
  try {
    const admin = res.locals.platformAdmin as { id: string; username: string } | undefined;
    if (!admin) return res.status(401).json({ ok: false, code: 'AUTH_001', message: 'missing platform auth' });
    const { old_password, new_password } = z.object({
      old_password: z.string().min(1).max(200),
      new_password: z.string().min(6).max(200),
    }).parse(req.body);
    const r = await pool.query(`SELECT id, password_hash FROM platform_admin WHERE id = $1`, [admin.id]);
    if (r.rowCount === 0) return res.status(404).json({ ok: false, code: 'USER_404', message: 'platform admin not found' });
    if (!verifyPassword(old_password, r.rows[0].password_hash)) {
      return res.status(401).json({ ok: false, code: 'AUTH_003', message: 'invalid old password' });
    }
    await pool.query(`UPDATE platform_admin SET password_hash = $1 WHERE id = $2`, [hashPassword(new_password), admin.id]);
    await audit(admin.username, 'platform.password.change', admin.id, null, null);
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

// ---- 审计日志查询（平台操作 audit + 开放 API 调用 log；append-only 只读） ----
router.get('/audit-logs', async (req, res, next) => {
  try {
    const actor = (req.query.actor as string) || '';
    const action = (req.query.action as string) || '';
    const tenant = (req.query.tenant as string) || '';
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const conds: string[] = [];
    const params: unknown[] = [];
    if (actor) { params.push(actor); conds.push(`actor ILIKE '%' || $${params.length} || '%'`); }
    if (action) { params.push(action); conds.push(`action ILIKE '%' || $${params.length} || '%'`); }
    if (tenant) { params.push(tenant); conds.push(`target_tenant = $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    params.push(limit, offset);
    const r = await pool.query(
      `SELECT id, actor, action, resource, target_tenant, payload, at FROM platform_audit
       ${where} ORDER BY at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const cnt = await pool.query(`SELECT count(*)::int AS c FROM platform_audit ${where}`, params.slice(0, params.length - 2));
    return res.json({ ok: true, code: 0, items: r.rows, total: cnt.rows[0]?.c ?? 0 });
  } catch (e) {
    next(e);
  }
});

router.get('/open-api-logs', async (req, res, next) => {
  try {
    const appId = (req.query.appId as string) || '';
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const conds: string[] = [];
    const params: unknown[] = [];
    if (appId) { params.push(appId); conds.push(`l.app_id = $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    params.push(limit, offset);
    const r = await pool.query(
      `SELECT l.id, a.app_name, l.app_id, l.endpoint, l.method, l.status_code, l.at
       FROM open_api_call_log l LEFT JOIN open_api_app a ON a.id = l.app_id
       ${where} ORDER BY l.at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const cnt = await pool.query(`SELECT count(*)::int AS c FROM open_api_call_log l ${where}`, params.slice(0, params.length - 2));
    return res.json({ ok: true, code: 0, items: r.rows, total: cnt.rows[0]?.c ?? 0 });
  } catch (e) {
    next(e);
  }
});

export default router;
