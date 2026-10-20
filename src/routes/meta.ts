// #938 展示层映射配置化：/api/v1/meta/labels —— 展示标签字典（平台级，公开端点）。
// 各端（FE/mp）状态/来源/业务类型/优先级中文名从 label_dict 拉取，
// 改标签零代码（UPDATE label_dict 即生效）；端点免鉴权——展示标签非敏感。
import { Router } from 'express';
import pool, { withTenantClient } from '../db/pool.js';

const router = Router();

type LabelMap = Record<string, Record<string, string>>;

// 内存缓存 60s：字典极低频变化，挡住全端启动风暴；改字典后至多 60s 全量生效。
let cache: { at: number; data: LabelMap } | null = null;
const CACHE_MS = 60_000;

// 租户覆盖层缓存：**必须按 tenantId 分槽**——单槽缓存会让 A 租户拿到 B 租户的译名。
const tenantCache = new Map<string, { at: number; data: LabelMap }>();

/** 平台字典（073 label_dict，无租户维度）。/meta/labels 与 /meta/labels/me 共用，行为不变。 */
async function loadPlatformLabels(): Promise<LabelMap> {
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

// #938-B 租户覆盖字典：平台字典 ∪ 本租户覆盖（覆盖优先）。
// 为什么另开端点而不是给 /meta/labels 加租户维度：/meta/labels 是**免鉴权**端点
// （FE/mp 启动即拉、未登录页也要渲染），给它加鉴权会让前端启动即崩。
// 覆盖表 label_dict_tenant（098）带 tenant_id + RLS，与 080 同款策略。
router.get('/meta/labels/me', async (_req, res, next) => {
  try {
    const auth = res.locals.auth as { tenantId?: string } | undefined;
    const tenantId = auth?.tenantId;
    if (!tenantId) {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      return;
    }
    const now = Date.now();
    const hit = tenantCache.get(tenantId);
    if (hit && now - hit.at <= CACHE_MS) {
      res.set('Cache-Control', 'private, max-age=60');
      res.json({ ok: true, labels: hit.data });
      return;
    }
    const platform = await loadPlatformLabels();
    const merged: LabelMap = {};
    for (const [scope, m] of Object.entries(platform)) merged[scope] = { ...m };
    const overrides = await withTenantClient(tenantId, async (client) => {
      const { rows } = await client.query<{ scope: string; key: string; label: string }>(
        'SELECT scope, key, label FROM label_dict_tenant WHERE tenant_id = $1 ORDER BY scope, sort, key',
        [tenantId],
      );
      return rows;
    });
    for (const r of overrides) {
      (merged[r.scope] ??= {})[r.key] = r.label;
    }
    tenantCache.set(tenantId, { at: now, data: merged });
    // private：租户私有译名，绝不能进公共缓存（CDN/代理会串号）
    res.set('Cache-Control', 'private, max-age=60');
    res.json({ ok: true, labels: merged });
  } catch (err) {
    next(err);
  }
});

export default router;
