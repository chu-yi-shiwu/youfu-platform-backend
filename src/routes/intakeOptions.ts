// FE Intake 申报页配置聚合端点（075 迁移配套）：GET /api/v1/meta/intake-options。
// 后端成为业务类型/目录事实源：租户可自配业务类型（business_type_dict）与目录
//（fault_category.business_type/skill_tags）；FE 优先吃后端，空配置/失败回落内置兜底。
// 挂载于 server.ts 鉴权区（authMiddleware 之后）——租户级数据，读 res.locals.auth.tenantId；
// 与 /meta/labels（平台级公开端点）不同源，不缓存（租户改配置需即时生效）。
import { Router } from 'express';
import { withTenantClient } from '../db/pool.js';

const router = Router();

/** skill_tags jsonb 防御性解析：NULL/非法（非数组或含非字符串元素）一律 []，不让坏数据炸端点。 */
function parseSkillTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

router.get('/meta/intake-options', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, async (client) => {
      // ① 租户已启用业务类型（空配置 → []，FE 回落内置兜底，属预期行为）
      const bt = await client.query(
        `SELECT code, name, sort FROM business_type_dict
         WHERE tenant_id=$1 AND enabled=true
         ORDER BY sort ASC, created_at ASC`,
        [tenantId],
      );
      // ② 该租户已启用目录（按 business_type 归组；含 NULL business_type 的历史目录不参与聚合——
      //    未挂类型的目录对申报页无业务类型上下文，保持行为保守）
      const fc = await client.query(
        `SELECT business_type, code, name, skill_tags FROM fault_category
         WHERE tenant_id=$1 AND enabled=true AND business_type IS NOT NULL
         ORDER BY sort ASC, created_at ASC`,
        [tenantId],
      );
      const catalogsByType = new Map<string, Array<{ code: string; name: string; skill_tags: string[] }>>();
      for (const r of fc.rows as Array<{ business_type: string; code: string; name: string; skill_tags: unknown }>) {
        let arr = catalogsByType.get(r.business_type);
        if (!arr) {
          arr = [];
          catalogsByType.set(r.business_type, arr);
        }
        arr.push({
          code: r.code,
          name: r.name,
          skill_tags: parseSkillTags(r.skill_tags),
        });
      }
      return (bt.rows as Array<{ code: string; name: string; sort: number }>).map((r) => ({
        code: r.code,
        name: r.name,
        sort: r.sort,
        enabled: true,
        catalogs: catalogsByType.get(r.code) ?? [],
      }));
    });
    return res.json({ ok: true, code: 0, business_types: items });
  } catch (e) {
    next(e);
  }
});

export default router;
