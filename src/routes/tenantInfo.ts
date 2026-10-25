// P1 全局顶部配置：当前租户信息（名称、服务热线）
// 来源：system_config 表的 brand_name / hotline；RLS 按 app.tenant_id 隔离。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { requirePermission } from '../middleware/role.js';

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
    const auth = res.locals.auth;
    const tenantId = auth?.tenantId;
    if (!tenantId) {
      return res.status(401).json({ ok: false, code: 'AUTH_001', message: 'missing tenant' });
    }
    // T8 第十四批：原 requireConfigRole（同步角色白名单、**不查权限表**）⇒ 可配置的权限点。
    //   **复用 basicdata.edit、不新增点**：本端点写的就是 `system_config`（brand_name / hotline），
    //   与 config.ts 的 system_config 段（PUT /config/system）**同一张表**；T8 第二批已确立该系统段
    //   归 `basicdata.edit`（defaults 含 operator ⇒ 等价保住）。另开一个点会让「同一张表两个入口
    //   两个答案」—— 正是 T8 要消灭的病。
    //   🔴 守卫单独一个事务、不放进下面的写入事务：保持**403 优先于 body 校验的 400**
    //   （原 requireConfigRole 在 zod parse 之前）。若合并进写入事务，下面的 zod 校验就得跟着
    //   挪进事务里才能保序，控制流无谓地被改写。
    //   ⚠️ 已知边缘差异（登记）：`tenantId` 缺失时，改前由 requireConfigRole 先返回 403，
    //   改后先返回 401 —— 守卫必须拿 client、client 必须要有 tenantId ⇒ 这个顺序**无法保持**。
    //   401 优先于 403 更符合 HTTP 语义，且生产由鉴权中间件保证 tenantId 恒存在。
    await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'basicdata.edit');
    });
    const b = updateSchema.parse(req.body);
    const name = b.name;
    const hotline = b.hotline ?? '';
    const actor = res.locals.auth?.username ?? null; // T0：留变更人（取不到写 NULL，不编造）
    await withTenantClient(tenantId, async (client) => {
      for (const [key, value] of [['brand_name', name], ['hotline', hotline]] as const) {
        await client.query(
          `INSERT INTO system_config (tenant_id, key, value, updated_by) VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, key)
           DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
          [tenantId, key, value, actor],
        );
      }
    });
    return res.json({ ok: true, code: 0, data: { tenant_id: tenantId, name, hotline } });
  } catch (e) {
    next(e);
  }
});

export default router;
