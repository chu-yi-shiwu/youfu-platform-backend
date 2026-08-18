// P1 全局顶部配置：当前租户信息（名称、服务热线）
// 来源：system_config 表的 brand_name / hotline；RLS 按 app.tenant_id 隔离。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { requireConfigRole } from '../middleware/role.js';

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

// PUT /api/v1/tenant-info —— 编辑品牌名/服务热线（写入 system_config，按租户隔离，幂等 upsert）
const updateSchema = z.object({
  name: z.string().min(1).max(120),
  hotline: z.string().max(40).optional().default(''),
});

router.put('/tenant-info', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth?.tenantId;
    if (!tenantId) {
      return res.status(401).json({ ok: false, code: 'AUTH_001', message: 'missing tenant' });
    }
    const b = updateSchema.parse(req.body);
    const name = b.name;
    const hotline = b.hotline ?? '';
    await withTenantClient(tenantId, async (client) => {
      for (const [key, value] of [['brand_name', name], ['hotline', hotline]] as const) {
        await client.query(
          `INSERT INTO system_config (tenant_id, key, value) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [tenantId, key, value],
        );
      }
    });
    return res.json({ ok: true, code: 0, data: { tenant_id: tenantId, name, hotline } });
  } catch (e) {
    next(e);
  }
});

export default router;
