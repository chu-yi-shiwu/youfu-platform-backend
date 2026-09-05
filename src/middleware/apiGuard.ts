// RV-001 修复（2026-09-04）：API 已知路径守卫——未知 /api 路径先 404 再鉴权。
//
// 背景：authMiddleware 挂在 /api 全局（server.ts），先于一切业务路由与 404 兜底，
// 导致请求不存在的 API 路径时返回 401（鉴权拒绝）而非 404（路径不存在）——
// 语义误导调用方（以为是权限问题），fail-closed 无安全影响但违背 HTTP 语义。
//
// 方案：在 authMiddleware 之前挂本守卫，按「已知挂载前缀 + /v1 下已知首段」白名单放行；
// 不在白名单的路径直接 JSON 404。白名单与 server.ts 挂载列表/各 router 真实路由同源
// （2026-09-04 由 scripts 提取器对 src/routes + src/webhook 全量 router 路径去重生成）。
// ⚠️ 维护纪律：新增 router 挂载前缀或 router 内新增首段路径时，必须同步更新下面两个清单，
//    否则合法路径会被误 404（live 探针「未知路径 JSON404」+ E2E 全量回归可兜底发现）。
import type { Request, Response, NextFunction } from 'express';

// server.ts 中显式挂载在 /api/v1/<prefix> 的 router 前缀（挂载后相对 /api 的路径）
export const KNOWN_API_PREFIXES: readonly string[] = [
  '/v1/platform',       // platformRouter + templateMarketRouter
  '/v1/open-api',       // openApiRouter（app_key 认证）
  '/v1/wechat',         // wechatRouter（JSSDK 签名，public）
  '/v1/inspection',     // inspectionRouter
  '/v1/patrol',         // patrolRouter
  '/v1/emergency',      // emergencyRouter
  '/v1/transport',      // transportRouter
  '/v1/volunteer',      // volunteerRouter
  '/v1/feedback',       // feedbackRouter
  '/v1/monitor',        // monitorRouter
  '/v1/workflow-defs',  // workflowDefRouter（内部首段为 :entityType 参数）
  '/v1/flow',           // businessFlowRouter（内部首段为 :entityType 参数）
  '/v1/ai',             // aiPreviewRouter
  '/v1/llm',            // llmUsageRouter
];

// 其余 router 全部挂在 /api/v1 下：此处为各 router 内部路由的首段去重清单
// （含 businessFlow/workflowDef 等挂在前缀下的段名冗余项——白名单宁多勿误杀）。
export const KNOWN_V1_SEGMENTS: ReadonlySet<string> = new Set([
  'accounts', 'activities', 'admin', 'agent-stats', 'alerts', 'applies', 'apps', 'assets',
  'audit-logs', 'auth', 'auto-tune', 'basic-data', 'config', 'devices', 'entities',
  'equipment', 'export', 'fault-categories', 'features', 'feedback', 'gen-config',
  'generate', 'generate-from-theme', 'health', 'inventory', 'items', 'jssdk-config',
  'materials', 'meta', 'open', 'open-api-logs', 'optimize', 'orders', 'plans', 'points',
  'preview', 'process-mining', 'product-catalog', 'public', 'records', 'scan',
  'service-desks', 'settlements', 'similar', 'sla', 'stats', 'summary', 'tasks',
  'template-contributions', 'templates', 'tenant-info', 'tenants', 'themes',
  'tickets', 'upload', 'usage', 'webhooks', 'workers', 'workflow',
]);

// 纯函数：路径（挂载后相对 /api，如 /v1/stats/x）是否落在已知 API 区域内。
// 命中 → 放行进入后续鉴权与路由匹配；不命中 → 调用方应直接 404。
export function isKnownApiPath(p: string): boolean {
  if (KNOWN_API_PREFIXES.some((pre) => p === pre || p.startsWith(`${pre}/`))) return true;
  const m = /^\/v1\/([^/]+)(?:\/.*)?$/.exec(p);
  if (m) return KNOWN_V1_SEGMENTS.has(m[1]);
  return false; // 裸 /v1、/v2/*、任意其它顶层段 → 未知
}

// express 中间件：未知路径 JSON 404（先于鉴权，杜绝「不存在的路径报 401」）
export function apiGuardMiddleware(req: Request, res: Response, next: NextFunction) {
  if (isKnownApiPath(req.path)) return next();
  return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'unknown api path' });
}
