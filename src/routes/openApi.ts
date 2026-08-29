// E0_open 开放 API 路由：第三方/上级平台/ISV 凭 app_key 调聚合数据（被接入）。
// 只出聚合（SECURITY DEFINER platform_tenant_summary），不下钻明细（G7/R2 红线）；
// 聚合优先，明细需租户同意+全审计（E3 落地时执行该边界）。
import { Router } from 'express';
import pool from '../db/pool.js';
import { openApiAuth, requireScope } from '../middleware/openApiAuth.js';

const router = Router();

// GET /open-api/health —— 开放 API 连通性探针（无需聚合权限，挂在 openApiAuth 之前，免 app 凭据）
router.get('/health', async (_req, res) => {
  return res.json({ ok: true, code: 0, service: 'youfu-open-api', time: new Date().toISOString() });
});

// 开放 API 其余路由全部走 app 认证
router.use(openApiAuth);

// GET /open-api/tenants/summary —— 跨租户聚合（与平台看板同源函数；只出聚合）
// 收尾#1：支持 ?tenant_id= 过滤（app 只拉指定租户，防全量可见；缺省=全部租户聚合）
//
// 安全闸门（三轮 QA 第一轮 F-A1 修复）：open_api_app 表无 allowed_tenants 绑定列，
// 故默认 scope=summary:read 只允许「全量聚合」；仅持 summary:read:* 或 * 的平台运营 app
// 才允许带 ?tenant_id= 下钻单租户聚合，否则 403。
// 这样在不引入迁移的前提下，封死「任意持有 summary:read 的 app 越权读取其他租户聚合数据」
// 的横向越权通道（最小权限原则）。
// 后续强化（建议迁移 059）：open_api_app 增加 allowed_tenants text[]，路由按
//   app.allowed_tenants 校验 tid 归属，替代 scope 粗粒度授权。
/** 纯函数（F-A1 安全闸门）：判断给定 app scopes 是否允许按 tenant_id 下钻单租户聚合。
 *  - 无 tenant_id（全量聚合）→ 默认允许；
 *  - 有 tenant_id → 仅 summary:read:* 或 * 作用域允许，否则禁止（最小权限）。 */
export function isPerTenantSummaryAllowed(scopes: string[], tid?: string): boolean {
  if (!tid) return true;
  return scopes.includes('summary:read:*') || scopes.includes('*');
}

router.get('/tenants/summary', requireScope('summary:read'), async (req, res, next) => {
  try {
    const tid = typeof req.query.tenant_id === 'string' && req.query.tenant_id ? req.query.tenant_id : undefined;
    const scopes = res.locals.openApp?.scopes ?? [];
    if (!isPerTenantSummaryAllowed(scopes, tid)) {
      return res.status(403).json({
        ok: false,
        code: 'FORBIDDEN',
        message: 'scope summary:read permits platform-wide aggregate only; per-tenant requires summary:read:*',
      });
    }
    if (tid) {
      const r = await pool.query(`SELECT * FROM platform_tenant_summary() WHERE tenant_id = $1`, [tid]);
      return res.json({ ok: true, code: 0, items: r.rows });
    }
    const r = await pool.query(`SELECT * FROM platform_tenant_summary()`);
    return res.json({ ok: true, code: 0, items: r.rows });
  } catch (e) {
    next(e);
  }
});

export default router;
