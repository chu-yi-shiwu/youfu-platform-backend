// P1 全局顶部配置：当前租户信息（名称、服务热线）
// 来源：system_config 表的 brand_name / hotline；RLS 按 app.tenant_id 隔离。
import { Router } from 'express';
import { withTenantClient } from '../db/pool.js';

const router = Router();

export interface TenantInfo {
  tenant_id: string;
  name: string;
  hotline: string;
}

async function getConfigValue(client: any, tenantId: string, key: string): Promise<string | null> {
  const { rows } = await client.query(
    'SELECT value FROM system_config WHERE tenant_id = $1 AND key = $2 LIMIT 1',
    [tenantId, key]
  );
  return rows[0]?.value ?? null;
}

// GET /api/v1/tenant-info
router.get('/tenant-info', async (_req, res, next) => {
  try {
    const tenantId = res.locals.auth?.tenantId;
    if (!tenantId) {
      return res.status(401).json({ ok: false, code: 'AUTH_001', message: 'missing tenant' });
    }
    const info = await withTenantClient(tenantId, async (client) => {
      const name = (await getConfigValue(client, tenantId, 'brand_name')) ?? tenantId;
      const hotline = (await getConfigValue(client, tenantId, 'hotline')) ?? '';
      return { tenant_id: tenantId, name, hotline };
    });
    return res.json({ ok: true, code: 0, data: info });
  } catch (e) {
    next(e);
  }
});

export default router;
