// 统一错误处理中间件：把已知错误映射为 {ok:false, code, message}。
import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
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
  console.error('[unhandled]', err);
  return res.status(500).json({ ok: false, code: 'INTERNAL', message: 'internal error' });
}
