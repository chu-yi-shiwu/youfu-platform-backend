// 城市级平台层路由（E_min：租户注册表 + 跨租户聚合 + 审计）。
// 挂载于 /api/v1/platform；除 /auth/login 外均需 platformAdminAuth（G1）。
// 平台表（tenant_registry/platform_admin/platform_audit）无 RLS，pool 直连；
// 聚合走 SECURITY DEFINER 函数（绕过 RLS，只出聚合指标，R2 不下钻）。
import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import pool, { withTenantClient, assertSafeTenantId } from '../db/pool.js';
import { signJwt, AUTH_MODE, loginRateLimit } from '../middleware/auth.js';
import { platformAdminAuth } from '../middleware/platformAuth.js';
import { verifyPassword, hashPassword } from '../account.js';
import { llmConfigured } from '../services/llm.js';

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
router.post('/auth/login', loginRateLimit(), async (req, res, next) => {
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
      `SELECT tr.tenant_id, tr.name, tr.category, tr.status, tr.parent_id, tr.quota, tr.created_at, tr.updated_at,
              COALESCE(ts.settings->>'llm_enabled', 'false') AS llm_enabled
       FROM tenant_registry tr
       LEFT JOIN tenant_settings ts ON ts.tenant_id = tr.tenant_id
       ORDER BY tr.tenant_id`,
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

// ---- POST /platform/tenants —— 登记新机构（P1 续：机构入驻向导后端）+ 行业模板初始化 ----
// 行业模板：新机构按 category 从「模板源租户」复制 fault_category（hospital→t-verification 91 分类等），
// 机构入驻即自动拥有该行业分类体系（DMR：数据资产按行业复用）。
const INDUSTRY_TEMPLATE_SOURCE: Record<string, string> = {
  hospital: 't-verification', // 医院行业模板源（UOne 迁移分类）
  property: 'demo_tenant',    // 物业行业模板源
  school: 't-verification',   // 学校暂用医院模板（可后续单独建）
  municipal: 't-verification',
};
router.post('/tenants', async (req, res, next) => {
  try {
    const admin = res.locals.platformAdmin!;
    const b = z.object({
      tenant_id: z.string().regex(/^[a-z][a-z0-9_-]{2,62}$/i, 'tenant_id 须 3-63 位字母数字下划线'),
      name: z.string().min(2).max(64),
      category: z.enum(['hospital', 'property', 'school', 'municipal', 'other']),
      parent_id: z.string().optional(),
    }).parse(req.body);
    // 防重复
    const dup = await pool.query(`SELECT 1 FROM tenant_registry WHERE tenant_id = $1`, [b.tenant_id]);
    if ((dup.rowCount ?? 0) > 0) return res.status(409).json({ ok: false, code: 'TENANT_DUP', message: '该机构已存在' });
    // 登记租户 + 行业模板初始化（复制模板源 fault_category）
    // R19-001 🔴 修复：原实现用 pool.query('BEGIN') 起事务却混用 withTenantClient（各自独立连接），
    //   pg.Pool.query 不保证跨调用同一连接 → 事务根本不原子，模板复制中途失败会留下「已建租户但无分类」孤儿租户。
    //   现改为单一 client 真事务：在同连接内切换租户上下文分别读(src)/写(new)，要么全成要么全回滚。
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO tenant_registry (tenant_id, name, category, parent_id, quota) VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [b.tenant_id, b.name, b.category, b.parent_id ?? null, JSON.stringify({ repair_daily: 500 })],
      );
      const src = INDUSTRY_TEMPLATE_SOURCE[b.category] ?? 't-verification';
      let copiedCount = 0;
      if (src !== b.tenant_id) {
        // 读源租户分类（SET LOCAL app.tenant_id=src + SET ROLE youfu_app 使 RLS 生效）
        await client.query(`SET LOCAL app.tenant_id = '${assertSafeTenantId(src).replace(/'/g, "''")}'`);
        await client.query('SET ROLE youfu_app');
        const copied = await client.query(
          `SELECT code, name, sort, enabled FROM fault_category WHERE tenant_id = $1 AND enabled = true`,
          [src],
        );
        if (copied.rows.length > 0) {
          // 切到新租户上下文后写入（RLS WITH CHECK 保证 tenant_id=new）
          await client.query(`SET LOCAL app.tenant_id = '${assertSafeTenantId(b.tenant_id).replace(/'/g, "''")}'`);
          for (const row of copied.rows) {
            const ins = await client.query(
              `INSERT INTO fault_category (id, tenant_id, code, name, sort, enabled)
               VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
               ON CONFLICT (tenant_id, code) DO NOTHING`,
              [b.tenant_id, row.code, row.name, row.sort, row.enabled],
            );
            copiedCount += ins.rowCount ?? 0;
          }
        }
      }
      await client.query('COMMIT');
      await audit(admin.username, 'tenant.create', b.tenant_id, b.tenant_id, { category: b.category, categories_copied: copiedCount });
      return res.status(201).json({
        ok: true, code: 0, item: { tenant_id: b.tenant_id, name: b.name, category: b.category, status: 'active' },
        note: `机构已登记，按${b.category}行业模板初始化分类 ${copiedCount} 条`,
      });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
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

// ---- 管理侧：租户 LLM 授权/撤销（初一定调：AI 推断启用权在平台，授权后才走 LLM） ----
const llmAuthSchema = z.object({ enabled: z.boolean() });
router.put('/tenants/:id/llm', async (req, res, next) => {
  try {
    const tenantId = (req.params.id || '').trim();
    const b = llmAuthSchema.parse(req.body);
    if (!tenantId) return res.status(422).json({ ok: false, code: 'VALIDATION_001', message: '缺少租户标识' });
    // 服务端未配置 DEEPSEEK_API_KEY → 拒绝授权（诚实：功能不可用时不假装已开）
    if (b.enabled && !llmConfigured()) {
      return res.status(409).json({ ok: false, code: 'LLM_NOT_CONFIGURED', message: '服务端未配置 DEEPSEEK_API_KEY，暂无法授权' });
    }
    await pool.query(`SELECT llm_authorize($1, $2)`, [tenantId, b.enabled]);
    // 审计（append-only：actor/action/resource/target_tenant/payload）
    await audit(
      res.locals.platformAdmin?.username ?? 'platform-admin',
      'tenant.llm_authorize',
      tenantId,
      tenantId,
      { llm_enabled: b.enabled },
    );
    return res.json({ ok: true, code: 0, tenant_id: tenantId, llm_enabled: b.enabled });
  } catch (e) {
    next(e);
  }
});

// ---- 位置字典 CRUD（v0.4.0：报修位置预录入，扫码自动带出） ----
router.get('/tenants/:id/locations', async (req, res, next) => {
  try {
    const tenantId = (req.params.id || '').trim();
    const r = await withTenantClient(tenantId, (client) =>
      client.query(
        `SELECT id, code, name, category, default_reporter_id, enabled
         FROM location_dict WHERE tenant_id = $1 ORDER BY code LIMIT 500`,
        [tenantId],
      ),
    );
    return res.json({ ok: true, code: 0, items: r.rows });
  } catch (e) { next(e); }
});
router.post('/tenants/:id/locations', async (req, res, next) => {
  try {
    const tenantId = (req.params.id || '').trim();
    const b = z.object({
      code: z.string().min(1).max(40),
      name: z.string().min(1).max(80),
      category: z.string().max(40).optional(),
      default_reporter_id: z.string().uuid().optional(),
    }).parse(req.body);
    const r = await withTenantClient(tenantId, (client) =>
      client.query(
        `INSERT INTO location_dict (tenant_id, code, name, category, default_reporter_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, code, name, category, default_reporter_id`,
        [tenantId, b.code, b.name, b.category ?? null, b.default_reporter_id ?? null],
      ),
    );
    await audit(res.locals.platformAdmin?.username ?? 'platform-admin', 'location.create', tenantId, tenantId, r.rows[0]);
    return res.status(201).json({ ok: true, code: 0, item: r.rows[0] });
  } catch (e) { next(e); }
});

// ---- 报修人角色字典 CRUD（v0.4.0：姓名+手机号预录入，扫码自动带出） ----
router.get('/tenants/:id/reporters', async (req, res, next) => {
  try {
    const tenantId = (req.params.id || '').trim();
    const r = await withTenantClient(tenantId, (client) =>
      client.query(
        `SELECT id, code, name, phone, role, enabled
         FROM reporter_dict WHERE tenant_id = $1 ORDER BY name LIMIT 500`,
        [tenantId],
      ),
    );
    return res.json({ ok: true, code: 0, items: r.rows });
  } catch (e) { next(e); }
});
router.post('/tenants/:id/reporters', async (req, res, next) => {
  try {
    const tenantId = (req.params.id || '').trim();
    const b = z.object({
      code: z.string().min(1).max(40),
      name: z.string().min(1).max(40),
      phone: z.string().regex(/^1\d{10}$/, '手机号需 11 位'),
      role: z.string().max(40).optional(),
    }).parse(req.body);
    const r = await withTenantClient(tenantId, (client) =>
      client.query(
        `INSERT INTO reporter_dict (tenant_id, code, name, phone, role)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, code, name, phone, role`,
        [tenantId, b.code, b.name, b.phone, b.role ?? null],
      ),
    );
    await audit(res.locals.platformAdmin?.username ?? 'platform-admin', 'reporter.create', tenantId, tenantId, { code: b.code, name: b.name });
    return res.status(201).json({ ok: true, code: 0, item: r.rows[0] });
  } catch (e) { next(e); }
});

export default router;
