// E0_open 开放 API 路由：第三方/上级平台/ISV 凭 app_key 调聚合数据（被接入）。
// 只出聚合（SECURITY DEFINER platform_tenant_summary），不下钻明细（G7/R2 红线）；
// 聚合优先，明细需租户同意+全审计（E3 落地时执行该边界）。
import { Router } from 'express';
import pool from '../db/pool.js';
import { openApiAuth, requireScope } from '../middleware/openApiAuth.js';

const router = Router();

// 开放 API 全部走 app 认证
router.use(openApiAuth);

// GET /open-api/tenants/summary —— 跨租户聚合（与平台看板同源函数；只出聚合）
// 收尾#1：支持 ?tenant_id= 过滤（app 只拉指定租户，防全量可见；缺省=全部租户聚合）
router.get('/tenants/summary', requireScope('summary:read'), async (req, res, next) => {
  try {
    const tid = typeof req.query.tenant_id === 'string' && req.query.tenant_id ? req.query.tenant_id : undefined;
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

// GET /open-api/health —— 开放 API 连通性探针（无需聚合权限，scope=* 或任意）
router.get('/health', async (_req, res) => {
  return res.json({ ok: true, code: 0, service: 'youfu-open-api', time: new Date().toISOString() });
});

export default router;
