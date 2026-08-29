import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// 动态导入以控制 AUTH_MODE / JWT_SECRET 模块级常量
async function loadAuth() {
  vi.resetModules();
  return import('../middleware/auth.js');
}

function makeReq(headers: Record<string, string>): Request {
  return {
    header: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? undefined,
  } as unknown as Request;
}

function makeRes(): any {
  const res: any = { statusCode: 0, body: undefined, sent: false, locals: {} };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj: unknown) => {
    res.body = obj;
    res.sent = true;
    return res;
  };
  return res;
}

function makeNext() {
  let called = false;
  const next: NextFunction = () => {
    called = true;
  };
  return { next, wasCalled: () => called };
}

const SECRET = 'test-secret-123';

describe('authMiddleware · dev mode（默认，维持 M1 行为）', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('AUTH_MODE', 'dev');
  });

  it('放行：有 Authorization + X-Tenant-Id', async () => {
    const { authMiddleware } = await loadAuth();
    const req = makeReq({ Authorization: 'Bearer dev', 'X-Tenant-Id': 'T1' });
    const res = makeRes();
    const { next, wasCalled } = makeNext();
    authMiddleware(req, res, next);
    expect(wasCalled()).toBe(true);
    expect(res.sent).toBe(false);
  });

  it('401 AUTH_001：缺 Authorization', async () => {
    const { authMiddleware } = await loadAuth();
    const req = makeReq({ 'X-Tenant-Id': 'T1' });
    const res = makeRes();
    const { next } = makeNext();
    authMiddleware(req, res, next);
    expect(res.statusCode).toBe(401);
    expect((res.body as any).code).toBe('AUTH_001');
  });

  it('放行：缺 X-Tenant-Id 时落到默认租户 t-verification', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('AUTH_MODE', 'dev'); // 不设置 DEV_DEFAULT_TENANT → 走硬编码缺省
    const { authMiddleware } = await loadAuth();
    const req = makeReq({ Authorization: 'Bearer dev' });
    const res = makeRes();
    const { next, wasCalled } = makeNext();
    authMiddleware(req, res, next);
    expect(wasCalled()).toBe(true);
    expect((res as any).locals?.auth ?? (req as any).locals?.auth).toBeDefined();
    const auth = (res as any).locals?.auth ?? (req as any).locals?.auth;
    expect(auth.tenantId).toBe('t-verification');
  });

  it('放行：DEV_DEFAULT_TENANT 环境变量覆盖默认租户', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('AUTH_MODE', 'dev');
    vi.stubEnv('DEV_DEFAULT_TENANT', 'tenant-from-env');
    const { authMiddleware } = await loadAuth();
    const req = makeReq({ Authorization: 'Bearer dev' });
    const res = makeRes();
    const { next, wasCalled } = makeNext();
    authMiddleware(req, res, next);
    expect(wasCalled()).toBe(true);
    const auth = (res as any).locals?.auth ?? (req as any).locals?.auth;
    expect(auth.tenantId).toBe('tenant-from-env');
  });
});

describe('authMiddleware · prod mode（强制真实 JWT）', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('AUTH_MODE', 'prod');
    vi.stubEnv('JWT_SECRET', SECRET);
  });

  it('401 AUTH_001：无 bearer', async () => {
    const { authMiddleware } = await loadAuth();
    const req = makeReq({ 'X-Tenant-Id': 'T1' });
    const res = makeRes();
    const { next } = makeNext();
    authMiddleware(req, res, next);
    expect(res.statusCode).toBe(401);
    expect((res.body as any).code).toBe('AUTH_001');
  });

  it('401 AUTH_002：无效 token 结构', async () => {
    const { authMiddleware } = await loadAuth();
    const req = makeReq({ Authorization: 'Bearer not-a-jwt' });
    const res = makeRes();
    const { next } = makeNext();
    authMiddleware(req, res, next);
    expect(res.statusCode).toBe(401);
    expect((res.body as any).code).toBe('AUTH_002');
  });

  it('401 AUTH_002：错误密钥签名', async () => {
    const { signJwt, authMiddleware } = await loadAuth();
    const bad = signJwt({ sub: 'u1', tid: 'T1', exp: Math.floor(Date.now() / 1000) + 3600 }, 'wrong-secret');
    const req = makeReq({ Authorization: `Bearer ${bad}` });
    const res = makeRes();
    const { next } = makeNext();
    authMiddleware(req, res, next);
    expect(res.statusCode).toBe(401);
    expect((res.body as any).code).toBe('AUTH_002');
  });

  it('401 AUTH_002：已过期 token', async () => {
    const { signJwt, authMiddleware } = await loadAuth();
    const expired = signJwt({ sub: 'u1', tid: 'T1', exp: Math.floor(Date.now() / 1000) - 10 }, SECRET);
    const req = makeReq({ Authorization: `Bearer ${expired}` });
    const res = makeRes();
    const { next } = makeNext();
    authMiddleware(req, res, next);
    expect(res.statusCode).toBe(401);
    expect((res.body as any).code).toBe('AUTH_002');
  });

  it('放行：合法 token 且租户取自 payload.tid', async () => {
    const { signJwt, authMiddleware } = await loadAuth();
    const good = signJwt({ sub: 'u1', tid: 'T1', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
    const req = makeReq({ Authorization: `Bearer ${good}` });
    const res = makeRes();
    const { next, wasCalled } = makeNext();
    authMiddleware(req, res, next);
    expect(wasCalled()).toBe(true);
    expect((res as any).locals?.auth ?? (req as any).locals?.auth).toBeDefined();
  });

  it('500 AUTH_CFG：JWT_SECRET 缺失（fail-closed）', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('AUTH_MODE', 'prod'); // 不设置 JWT_SECRET
    const { authMiddleware } = await loadAuth();
    const req = makeReq({ Authorization: 'Bearer x' });
    const res = makeRes();
    const { next } = makeNext();
    authMiddleware(req, res, next);
    expect(res.statusCode).toBe(500);
    expect((res.body as any).code).toBe('AUTH_CFG');
  });
});

describe('verifyJwt / signJwt（纯函数）', () => {
  it('合法 token 返回 payload', async () => {
    const { signJwt, verifyJwt } = await loadAuth();
    const t = signJwt({ a: 1, sub: 'u' }, SECRET);
    expect(verifyJwt(t, SECRET)).toEqual({ a: 1, sub: 'u' });
  });
  it('篡改 token 返回 null', async () => {
    const { signJwt, verifyJwt } = await loadAuth();
    const t = signJwt({ a: 1 }, SECRET);
    expect(verifyJwt(t + 'x', SECRET)).toBeNull();
  });
  it('错误密钥返回 null', async () => {
    const { signJwt, verifyJwt } = await loadAuth();
    const t = signJwt({ a: 1 }, SECRET);
    expect(verifyJwt(t, 'other')).toBeNull();
  });
  it('已过期返回 null', async () => {
    const { signJwt, verifyJwt } = await loadAuth();
    const t = signJwt({ exp: 1 }, SECRET);
    expect(verifyJwt(t, SECRET)).toBeNull();
  });
});
