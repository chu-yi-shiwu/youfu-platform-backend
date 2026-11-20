// SQLSTATE class 22（data exception）统一映射 400（2026-11-14 深度探针负控制）
//
// 修复前实测（真实 PG）：
//   POST /transport/orders {plan_depart_at:"not-a-date"}   → 500
//   POST /inspection/tasks {scheduled_at:"2026-13-45"}     → 500
//   POST /volunteer/activities {start_at:"garbage"}        → 500
// 根因：pgErrorToAppError 只映射 22P02，其余 class 22 落到 500。
// 这里直接打共享映射 + 中间件出口，断言 4xx 且不泄露内部细节。
import { describe, it, expect } from 'vitest';
import { pgErrorToAppError, errorMiddleware } from '../middleware/error.js';

function pgErr(code: string): Error {
  const e = new Error('pg failure');
  (e as unknown as { code: string }).code = code;
  return e;
}

describe('class 22 → 400', () => {
  it.each(['22007', '22008', '22021', '22001', '22003', '22P02'])('%s 映射为 400', (code) => {
    const mapped = pgErrorToAppError(pgErr(code));
    expect(mapped).not.toBeNull();
    expect(mapped!.status).toBe(400);
    expect(mapped!.code).toBe('BAD_PARAM');
  });

  it('非数据类错误不吞（40P01 死锁仍走 500）', () => {
    expect(pgErrorToAppError(pgErr('40P01'))).toBeNull();
  });

  it('errorMiddleware 输出 400 且不含内部细节', () => {
    const captured: { code?: number; body?: unknown } = {};
    const res = {
      status(c: number) { captured.code = c; return this; },
      json(b: unknown) { captured.body = b; return this; },
    } as unknown as import('express').Response;
    errorMiddleware(pgErr('22007'), {} as import('express').Request, res, () => {});
    expect(captured.code).toBe(400);
    const body = captured.body as { code: string; message: string };
    expect(body.code).toBe('BAD_PARAM');
    expect(body.message).not.toMatch(/pg failure/);
  });
});
