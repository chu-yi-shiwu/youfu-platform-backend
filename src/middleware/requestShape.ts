// 请求形状守卫（共享层）：在进入任何路由前，把两类「用户输入制造 500」的根因挡在边界外。
//
// 背景（2026-11-14 深度探针实测）：
//   1) `?status=done&status=pending`（重复参数 → string[]）被直接塞进 SQL，PG 抛错 → 500；
//      同类还有 `?q=a&q=b`（对数组调 .trim() → TypeError → 500）。
//   2) JSON 字符串里的 `\u0000`（NUL）Postgres 无法存储（22021），落到未映射错误 → 500。
//
// 契约（fail-closed）：
//   · 查询参数一律为**单值字符串**；重复或嵌套（a[b]=c）→ 400 BAD_QUERY，不静默取第一个。
//   · 请求路径/查询/body 中不得出现 NUL 字节 → 400 BAD_PARAM。
//
// 为什么在边界统一处理而不是逐端点补：全站 336 个端点、几十处 `req.query.x as string`
// 都是同一形状假设；逐点修 = 下一处新增接口继续复现。这里是唯一入口。
import type { NextFunction, Request, Response } from 'express';

const NUL = '\u0000';

/** 递归检查 NUL（含 Buffer 原始字节）；深度上限防止恶意深嵌套拖垮遍历。 */
export function containsNulByte(value: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (typeof value === 'string') return value.includes(NUL);
  if (Buffer.isBuffer(value)) return value.includes(0);
  if (Array.isArray(value)) return value.some((v) => containsNulByte(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) => containsNulByte(v, depth + 1));
  }
  return false;
}

/** 返回第一个非单值字符串的查询参数名；全部合法返回 null。 */
export function findNonScalarQueryParam(query: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(query)) {
    if (typeof value !== 'string') return key;
  }
  return null;
}

export function requestShapeMiddleware(req: Request, res: Response, next: NextFunction): void {
  const badQuery = findNonScalarQueryParam(req.query as Record<string, unknown>);
  if (badQuery) {
    res.status(400).json({
      ok: false,
      code: 'BAD_QUERY',
      message: `查询参数 ${badQuery} 只能出现一次且为单值`,
    });
    return;
  }
  if (req.originalUrl.includes('%00') || containsNulByte(req.query) || containsNulByte(req.body)) {
    res.status(400).json({
      ok: false,
      code: 'BAD_PARAM',
      message: '请求包含非法空字符（NUL）',
    });
    return;
  }
  next();
}
