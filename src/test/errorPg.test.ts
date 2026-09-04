// errorPg.test.ts —— 注册制批次一 P0-1：errorMiddleware PG 错误码映射回归。
// 23505 unique_violation → 409 CONFLICT（文案含表/列信息）；23514 → 400；22P02 → 400；
// 非 PG 错误/未识别码 → 维持原 500 路径；既有 AppError/ZodError 路径不受影响。
import { describe, it, expect } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { AppError, errorMiddleware, pgErrorToAppError, asPgError } from '../middleware/error.js';

function makeRes() {
  const out = { status: 0, body: null as any };
  const res = {
    status(code: number) { out.status = code; return res; },
    json(body: unknown) { out.body = body; return res; },
  } as unknown as Response;
  return { res, out };
}

function run(err: unknown) {
  const { res, out } = makeRes();
  errorMiddleware(err, {} as Request, res, (() => undefined) as NextFunction);
  return out;
}

// 模拟 pg DatabaseError（鸭子类型：Error + 5 位 SQLSTATE code）
function pgErr(code: string, extra: Partial<{ detail: string; table: string; column: string; constraint: string }> = {}) {
  const e = new Error(`pg error ${code}`);
  Object.assign(e, { code, ...extra });
  return e;
}

describe('pgErrorToAppError（SQLSTATE 映射）', () => {
  it('23505 → 409 CONFLICT，文案含表与列信息', () => {
    const a = pgErrorToAppError(pgErr('23505', { table: 'location_dict', detail: 'Key (tenant_id, code)=(t1, 3F-A01) already exists.' }));
    expect(a).not.toBeNull();
    expect(a!.status).toBe(409);
    expect(a!.code).toBe('CONFLICT');
    expect(a!.message).toContain('location_dict');
    expect(a!.message).toContain('tenant_id, code');
  });

  it('23514 → 400 BAD_PARAM（含约束名）', () => {
    const a = pgErrorToAppError(pgErr('23514', { constraint: 'sla_hours_check' }));
    expect(a!.status).toBe(400);
    expect(a!.code).toBe('BAD_PARAM');
    expect(a!.message).toContain('sla_hours_check');
  });

  it('22P02 → 400 BAD_PARAM', () => {
    const a = pgErrorToAppError(pgErr('22P02'));
    expect(a!.status).toBe(400);
    expect(a!.code).toBe('BAD_PARAM');
  });

  it('未识别 SQLSTATE（如 40001）→ null（维持原路径）', () => {
    expect(pgErrorToAppError(pgErr('40001'))).toBeNull();
  });

  it('非 PG 错误 → null', () => {
    expect(pgErrorToAppError(new Error('plain'))).toBeNull();
    expect(pgErrorToAppError(null)).toBeNull();
    expect(pgErrorToAppError({ code: 42 })).toBeNull();
  });
});

describe('asPgError（鸭子类型判定）', () => {
  it('5 位 SQLSTATE 命中；ERR_xxx 系统码/数字 code 不命中', () => {
    expect(asPgError(pgErr('23505'))).not.toBeNull();
    expect(asPgError(pgErr('ERR_SOCKET'))).toBeNull();
    expect(asPgError(Object.assign(new Error('x'), { code: 42 }))).toBeNull();
  });
});

describe('errorMiddleware 全路径回归', () => {
  it('PG 23505 → 409 JSON', () => {
    const out = run(pgErr('23505', { table: 'reporter_dict', detail: 'Key (tenant_id, code)=(t1, zhangsan) already exists.' }));
    expect(out.status).toBe(409);
    expect(out.body.code).toBe('CONFLICT');
    expect(out.body.ok).toBe(false);
  });

  it('AppError 路径不受影响', () => {
    const out = run(new AppError('CONFLICT', '该编号已存在', 409));
    expect(out.status).toBe(409);
    expect(out.body.message).toBe('该编号已存在');
  });

  it('普通 Error 仍 500 INTERNAL', () => {
    const out = run(new Error('boom'));
    expect(out.status).toBe(500);
    expect(out.body.code).toBe('INTERNAL');
  });
});
