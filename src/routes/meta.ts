// #938 展示层映射配置化：/api/v1/meta/labels —— 展示标签字典（平台级，公开端点）。
// 各端（FE/mp）状态/来源/业务类型/优先级中文名从 label_dict 拉取，
// 改标签零代码（UPDATE label_dict 即生效）；端点免鉴权——展示标签非敏感。
import { Router } from 'express';
import pool from '../db/pool.js';

const router = Router();

type LabelMap = Record<string, Record<string, string>>;

// 内存缓存 60s：字典极低频变化，挡住全端启动风暴；改字典后至多 60s 全量生效。
let cache: { at: number; data: LabelMap } | null = null;
const CACHE_MS = 60_000;

/**
 * 平台字典（073 label_dict，无租户维度）。/meta/labels 与 /meta/labels/me 共用，行为不变。
 * 导出给 metaTenantLabel.ts：**租户覆盖字典必须挂在 auth 之后**（要 res.locals.auth.tenantId），
 * 而本文件整体挂在 auth 之前（/meta/labels 免鉴权），两处只能共用这个函数，不能共用挂载点。
 */
export async function loadPlatformLabels(): Promise<LabelMap> {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    const { rows } = await pool.query<{ scope: string; key: string; label: string }>(
      'SELECT scope, key, label FROM label_dict ORDER BY scope, sort, key',
    );
    const labels: LabelMap = {};
    for (const r of rows) {
      (labels[r.scope] ??= {})[r.key] = r.label;
    }
    cache = { at: Date.now(), data: labels };
  }
  return cache.data;
}

router.get('/meta/labels', async (_req, res, next) => {
  try {
    const labels = await loadPlatformLabels();
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ ok: true, labels });
  } catch (err) {
    next(err);
  }
});

// #938-B 租户覆盖字典的**读**端点 GET /meta/labels/me 已迁到 routes/metaTenantLabel.ts。
// 迁移原因（不是重构偏好，是生产缺陷）：本文件挂在 authMiddleware **之前**（/meta/labels 免鉴权，
// FE/mp 启动即拉），而 /me 要读 res.locals.auth.tenantId ⇒ 生产恒 401 ⇒ 租户覆盖层从来没生效过。
// 覆盖表 label_dict_tenant（098）带 tenant_id + RLS，与 080 同款策略；读侧见 metaTenantLabel.ts。

export default router;
