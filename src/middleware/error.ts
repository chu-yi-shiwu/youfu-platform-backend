// 统一错误处理中间件：把已知错误映射为 {ok:false, code, message}。
import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

// ---- PG 错误码映射（注册制批次一 P0-1）----
// pg 驱动抛出的 DatabaseError 带 5 位 SQLSTATE code 字符串；此前统一落 500 排障困难。
// 鸭子类型判定：err 是 Error 且 code 匹配 5 位 SQLSTATE 形态（排除 ERR_XXX 等系统错误码）。
interface PgLikeError {
  code?: string;
  detail?: string;
  table?: string;
  column?: string;
  constraint?: string;
}

const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

export function asPgError(err: unknown): PgLikeError | null {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && SQLSTATE_RE.test(code)) return err as PgLikeError;
  }
  return null;
}

/**
 * 把已知 PG 错误翻译为带语义的 AppError；非 PG/未识别错误码返回 null（走原路径）。
 * 覆盖：23505 唯一冲突 → 409；23514 check 约束 → 400；22P02 非法字面量 → 400；
 *       42501 RLS 违规 → 403；23503 外键 → 409；23502 非空 → 400（审查修复 QA💭）。
 */
export function pgErrorToAppError(err: unknown): AppError | null {
  const pg = asPgError(err);
  if (!pg) return null;
  switch (pg.code) {
    case '23505': {
      // unique_violation：文案带上表/列信息（pg 的 detail 形如 Key (tenant_id, code)=(...) already exists.）
      const col = pg.detail?.match(/Key \(([^)]+)\)/)?.[1] ?? pg.column;
      const where = pg.table ? `（${pg.table}${col ? `.${col}` : ''}）` : '';
      return new AppError('CONFLICT', `该记录已存在${where}，请检查编号/编码是否重复`, 409);
    }
    case '23514': {
      const c = pg.constraint ? `（约束 ${pg.constraint}）` : '';
      return new AppError('BAD_PARAM', `数据不满足业务约束${c}，请检查字段取值`, 400);
    }
    case '22P02':
      // invalid_text_representation：常见于 uuid/text 列收到非法字面量
      return new AppError('BAD_PARAM', '参数格式不正确（非法 ID 或枚举值）', 400);
    // 审查修复（QA💭）：补三类高频 PG 错误——此前一并按 500 冒泡，排障靠猜。
    case '42501':
      // insufficient_privilege：RLS 策略拒绝（典型 = 写入时 tenant_id 与会话上下文不符，
      // 或应用身份缺表权限）。属权限问题不是服务故障，映射 403。
      return new AppError('FORBIDDEN', '无权执行该操作（RLS 租户隔离拒绝），请确认数据归属与账号权限', 403);
    case '23503':
      // foreign_key_violation：引用了不存在/正被引用的主外键行
      return new AppError('CONFLICT', '关联数据校验失败（外键约束），请检查引用对象是否存在或仍被占用', 409);
    case '23502':
      // not_null_violation：必填列缺失。pg 的 column 字段带列名，文案带上便于定位。
      return new AppError('BAD_PARAM', `缺少必填字段${pg.column ? `（${pg.column}）` : ''}`, 400);
    default:
      return null;
  }
}

export function errorMiddleware(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(422).json({
      ok: false,
      code: 'VALIDATION_001',
      message: 'invalid request body',
      details: err.issues.map((i) => ({ path: i.path.join('.'), msg: i.message })),
    });
  }
  if (err instanceof AppError) {
    return res.status(err.status).json({ ok: false, code: err.code, message: err.message });
  }
  // PG 已知错误码 → 语义化 4xx（23505 唯一冲突 / 23514 check / 22P02 非法字面量）
  const pgMapped = pgErrorToAppError(err);
  if (pgMapped) {
    return res.status(pgMapped.status).json({ ok: false, code: pgMapped.code, message: pgMapped.message });
  }
  console.error('[unhandled]', err);
  return res.status(500).json({ ok: false, code: 'INTERNAL', message: 'internal error' });
}
