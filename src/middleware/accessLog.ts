// P0-12 最小可观测性（2026-11-07）：结构化访问日志。
//
// 目标：试点期能用**一条 JSON**回答「谁、哪个租户、哪个接口、耗时多久、结果如何」，
// 并与 errorMiddleware 的 500 日志通过 request_id 关联。
//
// 约束（务必保持）：
//   - 不记录 query string / body / Authorization：报修、账号等接口带手机号与令牌，
//     日志一旦落盘即扩散 PII；需要排障时由 request_id 反查业务表。
//   - /health 与 /health/ready 不记：探针每几秒一次，记了只会淹没真实请求。
//   - 请求头 X-Request-Id 由客户端给定时原样沿用；未给定则服务端生成 UUID，
//     并通过响应头回传，便于前端/小程序报障时直接提供。
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const SKIP_PATHS = new Set(['/health', '/health/ready']);

export interface AccessLogInput {
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  tenantId?: string;
  userId?: string;
  role?: string;
  at?: Date;
}

/** 纯函数：把一次请求压成稳定字段的日志对象（便于单测与后续接采集器）。 */
export function buildAccessLogEntry(input: AccessLogInput): Record<string, unknown> {
  return {
    ts: (input.at ?? new Date()).toISOString(),
    level: 'info',
    type: 'access',
    request_id: input.requestId,
    method: input.method,
    path: input.path,
    status: input.status,
    duration_ms: Math.round(input.durationMs * 1000) / 1000,
    tenant_id: input.tenantId ?? null,
    user_id: input.userId ?? null,
    role: input.role ?? null,
  };
}

export function accessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.header('X-Request-Id')?.trim() || crypto.randomUUID();
  // 与 authMiddleware 共享同一个 requestId：登录请求、公开端点也要能串起来。
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  if (SKIP_PATHS.has(req.path)) return next();

  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const auth = res.locals.auth as
      | { tenantId?: string; userId?: string; role?: string }
      | undefined;
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const entry = buildAccessLogEntry({
      requestId,
      method: req.method,
      // 只记 pathname，不记 query（query 可能含手机号、token、搜索词等）。
      // 必须用 originalUrl：Express 在挂载路由内会把 req.path 截成相对路径
      // （/api/v1/nope 会变成 /v1/nope），排障时无法直接定位真实端点。
      path: req.originalUrl.split('?')[0] || req.path,
      status: res.statusCode,
      durationMs,
      tenantId: auth?.tenantId,
      userId: auth?.userId,
      role: auth?.role,
    });
    // 单行 JSON：兼容 journald / 云日志按行采集，无需额外解析器。
    console.log(JSON.stringify(entry));
  });
  next();
}
