// metaLabelMountOrder.test.ts —— 展示标签路由在 server.ts 里的**挂载顺序**防回归（纯静态扫描）。
//
// 【为什么要有这个文件：一个真实发生过一次的 bug】
//   读端点 GET /meta/labels/me 曾挂在 authMiddleware **之前**，导致 res.locals.auth 恒为
//   undefined、端点里 tenantId 取不到、生产上恒 401——租户覆盖字典等于从没上线过。
//   当时只验了「未登录访问返回 401」这个**负例**就当成通过，没验「登录后能不能读到」；
//   负例绿了不等于功能活着：未登录 401 是正确行为，挂了错的位照样 401，负例全绿。
//   所以这里直接锁行号：写侧/读租户侧必须在 auth 之后，免鉴权的平台字典必须在 auth 之前。
//
// 顺序约束（server.ts 源码行号）：
//   app.use('/api/v1', metaRouter)            < app.use('/api', authMiddleware)
//   app.use('/api/v1', metaTenantLabelRouter) > app.use('/api', authMiddleware)
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const LINES = readFileSync(join(ROOT, 'src', 'server.ts'), 'utf8').split('\n');

/** app.use('/api', authMiddleware) —— 注意别蹭到 apiGuardMiddleware（同在 /api 前缀）。 */
const AUTH_RE = /app\.use\('\/api',\s*authMiddleware\)/;
/** 免鉴权平台字典 GET /meta/labels（FE/mp 启动即拉，必须留在 auth 之前）。 */
const META_RE = /app\.use\('\/api\/v1',\s*metaRouter\)/;
/** 租户覆盖字典读+写（GET/PUT /meta/labels/me，都要 res.locals.auth.tenantId）。 */
const META_TENANT_LABEL_RE = /app\.use\('\/api\/v1',\s*metaTenantLabelRouter\)/;

/**
 * 取某条挂载语句的 1-based 行号。**找不到或命中多次都直接抛**——
 * 宁可测试红，不许静默跳过（行号取不到时 expect(undefined > x) 会假红/假绿，比没有测试更糟）。
 */
function mountLine(pattern: RegExp): number {
  const hits = LINES.map((text, i) => ({ text, line: i + 1 })).filter(({ text }) => pattern.test(text));
  if (hits.length !== 1) {
    throw new Error(
      `server.ts 中挂载语句 ${pattern} 命中 ${hits.length} 次（期望恰好 1 次）：行 ${hits.map((h) => h.line).join(', ')}`,
    );
  }
  return hits[0].line;
}

describe('展示标签路由挂载顺序：authMiddleware 前后不许错', () => {
  it('metaTenantLabelRouter（GET/PUT /meta/labels/me）必须挂在 authMiddleware 之后', () => {
    const auth = mountLine(AUTH_RE);
    const tenantLabel = mountLine(META_TENANT_LABEL_RE);
    expect(
      tenantLabel,
      `metaTenantLabelRouter 挂在第 ${tenantLabel} 行，早于 authMiddleware（第 ${auth} 行）：` +
        'res.locals.auth 恒 undefined，/meta/labels/me 会生产恒 401（真实发生过一次）',
    ).toBeGreaterThan(auth);
  });

  it('metaRouter（免鉴权 GET /meta/labels）必须挂在 authMiddleware 之前', () => {
    const auth = mountLine(AUTH_RE);
    const meta = mountLine(META_RE);
    expect(
      meta,
      `metaRouter 挂在第 ${meta} 行，晚于 authMiddleware（第 ${auth} 行）：` +
        'FE/mp 启动即拉的平台字典会被 401 挡死，前端启动即崩',
    ).toBeLessThan(auth);
  });
});
