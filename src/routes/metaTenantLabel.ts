// R1-B 补全：展示标签「租户覆盖」**写**端点 PUT /api/v1/meta/labels/me/:scope/:key。
//
// 【为什么单独开一个路由文件，不写进 meta.ts】
//   meta.ts 在 server.ts 里挂在 authMiddleware **之前**（GET /meta/labels 是免鉴权端点，
//   FE/mp 启动即拉）。写端点必须拿到 res.locals.auth，挂在那里永远只有 undefined。
//   所以本文件单独挂载在 authMiddleware 之后（见 server.ts）；读侧仍在 meta.ts。
//
// 【三条红线】
//   ① tenantId 只从 res.locals.auth.tenantId 取——请求参数/body 里的 tenant_id 一律无视，
//      否则 A 租户管理员能改 B 租户的字典（RLS 的 WITH CHECK 只挡得住注入后的 tenant_id，
//      挡不住"服务端老实按请求里的 tenant_id 去写"这种越权）。
//   ② 只写 label_dict_tenant，**绝不写平台字典 label_dict**（无租户维度，写穿 = 全平台事故）。
//      metaTenantLabelWrite.http.test.ts 里有静态护栏 + PGlite 真库双重卡这条。
//   ③ scope 白名单（与 073 label_dict 的四个域一致），非法一律 400。
//
// 【为什么用 basicdata.edit 权限点】
//   展示标签字典归属「基础数据」（accounts.ts:92 的权限展示名即「基础数据」）。basicdata.edit
//   在 role.ts:60 的 PERMS 有定义，且 role.ts:112 的 operator 默认矩阵含它——operator 本就
//   维护这类主数据，拿它当闸不会把租户日常改译名变成 403。不复用 workflow.edit：它不在
//   operator 默认矩阵（role.ts:103），拿它当闸等于把改译名收口到 admin；语义上也贴不上
//   ——workflow.edit 是「流程配置编辑」，而这里改的是展示译名，不动流程定义任何一行。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { requirePermission } from '../middleware/role.js';
import { AppError } from '../middleware/error.js';
import { loadPlatformLabels } from './meta.js';

const router = Router();

type LabelMap = Record<string, Record<string, string>>;
const CACHE_MS = 60_000;

// 租户覆盖层读缓存：**必须按 tenantId 分槽**——单槽缓存会让 A 租户拿到 B 租户的译名。
const tenantCache = new Map<string, { at: number; data: LabelMap }>();

/**
 * 失效某租户的覆盖字典读缓存（写端点改完译名后调用）。
 * 不失效的话管理员改完要等 60s 才看到新译名，观感就是"改了没生效"。
 */
export function invalidateTenantLabelCache(tenantId?: string): void {
  if (tenantId) tenantCache.delete(tenantId);
  else tenantCache.clear();
}

// #938-B 租户覆盖字典**读**端点：平台字典 ∪ 本租户覆盖（覆盖优先）。
// 【为什么它必须住在这个文件】meta.ts 整体挂在 authMiddleware **之前**（GET /meta/labels 是
// 免鉴权端点，FE/mp 启动即拉、未登录页也要渲染），那里 res.locals.auth 恒为 undefined，
// 端点会永远 401 —— 租户覆盖层等于从没上线过。本文件挂在 auth 之后（server.ts）。
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

/** 与 073 label_dict 的四个域严格一致；多一个域就是在给字典表开垃圾入口。 */
const SCOPES = ['wo_status', 'source', 'business_type', 'priority'] as const;
const KEY_MAX = 64;
const LABEL_MAX = 64;

/** body 校验：label 去空白后 1~64 字符。非法一律 400（zod 失败不外抛成 422，语义统一）。 */
const bodySchema = z.object({
  label: z
    .string({ required_error: 'label 必填', invalid_type_error: 'label 必须是字符串' })
    .trim()
    .min(1, 'label 去空白后不能为空')
    .max(LABEL_MAX, `label 去空白后长度上限 ${LABEL_MAX} 字符`),
});

router.put('/meta/labels/me/:scope/:key', async (req, res, next) => {
  try {
    const auth = res.locals.auth;
    const tenantId = auth?.tenantId;
    if (!auth || !tenantId) {
      res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
      return;
    }
    const scope = String(req.params.scope ?? '');
    if (!(SCOPES as readonly string[]).includes(scope)) {
      throw new AppError('BAD_SCOPE', `unsupported label scope: ${scope}`, 400);
    }
    // key 不做 charset 限制（租户自定义状态名可能是中文），但必须非空且不超长。
    const key = String(req.params.key ?? '').trim();
    if (key === '' || key.length > KEY_MAX) {
      throw new AppError('BAD_KEY', `label key must be 1~${KEY_MAX} chars`, 400);
    }
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError('BAD_LABEL', parsed.error.issues[0]?.message ?? 'label 非法', 400);
    }
    const label = parsed.data.label;

    const row = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'basicdata.edit');
      // UPSERT：没有就插（tenant_id 取 auth），有就改 label。
      // 单条语句完成——「先 SELECT 再 INSERT/UPDATE」在并发下会撞唯一索引 23505。
      const { rows } = await client.query<{ scope: string; key: string; label: string }>(
        `INSERT INTO label_dict_tenant (tenant_id, scope, key, label, sort)
         VALUES ($1, $2, $3, $4, 0)
         ON CONFLICT (tenant_id, scope, key) DO UPDATE SET label = EXCLUDED.label, updated_at = now()
         RETURNING scope, key, label`,
        [tenantId, scope, key, label],
      );
      return rows[0];
    });

    // 写侧必须失效读侧缓存：否则管理员改完 60s 内读到的还是旧裸 key = "改了没生效"。
    invalidateTenantLabelCache(tenantId);
    res.json({ ok: true, scope: row.scope, key: row.key, label: row.label });
  } catch (err) {
    next(err);
  }
});

export default router;
