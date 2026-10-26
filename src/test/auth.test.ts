import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, NextFunction } from 'express';

// mock 池：prod 放行路径的租户状态守卫会查 tenant_registry（P3 修复后新增依赖）。
// 缺省返回空（registry 无记录 → 放行口径），不触真实 PG。
vi.mock('../db/pool.js', () => ({
  default: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) },
  assertSafeTenantId: (t: string) => t,
  withTenantClient: async (_tid: string, fn: (c: any) => Promise<any>) => fn({ query: async () => ({ rows: [], rowCount: 0 }) }),
}));

// 【本次新增】拦截 `../account.js`，目的有二：
//   ① 让 auth.ts 的 withTenantClient 变成探针，**记录登录时实际落到哪个租户**（这是
//      DEFAULT_LOGIN_TENANT 唯一的作用点，必须可观测量化，不能靠读代码推断）；
//   ② registry 查询返回 rowCount=0 ⇒ login 在 TENANT_NOT_REGISTERED 处提前 403 返回，
//      **根本走不到密码校验**，所以 probe 不需要真实账号/密码，也不连任何库。
const loginProbe = vi.hoisted(() => ({ tenants: [] as string[] }));
vi.mock('../account.js', () => ({
  createUser: vi.fn(),
  findUserByUsername: vi.fn(async () => null),
  findUserById: vi.fn(async () => null),
  listUsers: vi.fn(async () => []),
  signLoginToken: vi.fn(() => 'fake-token'),
  toPublic: (u: unknown) => u,
  verifyPassword: vi.fn(() => false),
  updateUserPassword: vi.fn(),
  // ★ 探针本体：把每次登录尝试的 tenantId 记下来
  withTenantClient: async (tenantId: string, fn: (c: any) => Promise<any>) => {
    loginProbe.tenants.push(tenantId);
    return fn({ query: async () => ({ rows: [], rowCount: 0 }) });
  },
}));

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
    // P3 修复后 prod 放行走异步租户状态守卫（then(next)），等微任务队列排空再断言
    await new Promise<void>((r) => setImmediate(r));
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

describe('AUTH_MODE 解析 · 白名单 dev（F7 同源：缺省必须是最安全的那一侧）', () => {
  // 逐个值重装模块 + 刷新，避免模块级常量互相污染。
  async function modeWith(raw: string | undefined): Promise<string> {
    vi.unstubAllEnvs();
    if (raw === undefined) delete process.env.AUTH_MODE;
    else vi.stubEnv('AUTH_MODE', raw);
    const m = await loadAuth();
    m.refreshAuthMode();
    return m.AUTH_MODE;
  }

  it('显式 dev → dev（本地联调唯一合法开法）', async () => {
    expect(await modeWith('dev')).toBe('dev');
  });

  it('未设置 → prod（fail-closed，F7 2026-10-19）', async () => {
    expect(await modeWith(undefined)).toBe('prod');
  });

  it('prod → prod', async () => {
    expect(await modeWith('prod')).toBe('prod');
  });

  it('PROD / Prod 大小写不敏感 → prod', async () => {
    expect(await modeWith('PROD')).toBe('prod');
    expect(await modeWith('Prod')).toBe('prod');
  });

  it('🔴 production 拼写 → prod（改前落 dev = 全门禁放行）', async () => {
    expect(await modeWith('production')).toBe('prod');
  });

  it('🔴 prd 拼写 → prod（改前落 dev = 全门禁放行）', async () => {
    expect(await modeWith('prd')).toBe('prod');
  });

  it('🔴 prod 带首尾空格 → prod（.env 手写常见，改前落 dev）', async () => {
    expect(await modeWith('prod ')).toBe('prod');
    expect(await modeWith(' prod')).toBe('prod');
  });

  it('🔴 空串 → prod（改前落 dev）', async () => {
    expect(await modeWith('')).toBe('prod');
  });

  it('development / local → dev（白名单内，容错保留）', async () => {
    expect(await modeWith('development')).toBe('dev');
    expect(await modeWith('local')).toBe('dev');
  });

  it('🔴 platformAuth 与 authMiddleware 同源：非白名单值不得落到 dev', async () => {
    // auth.ts:52 是唯一解析点，platformAuth.ts:23 直接引 AUTH_MODE ⇒ 此处守住即守住两边。
    vi.unstubAllEnvs();
    vi.stubEnv('AUTH_MODE', 'production');
    const m = await loadAuth();
    m.refreshAuthMode();
    expect(m.AUTH_MODE).not.toBe('dev');
  });
});

// ==========================================================================================
// DEFAULT_LOGIN_TENANT 生产残留核查（2026-10-26）
//
// 背景：生产 .env 同时存在 AUTH_MODE=prod 与 DEFAULT_LOGIN_TENANT=t-verification，
//       而 PILOT_RUNBOOK.md:109 要求「去掉 dev 兜底（DEFAULT_LOGIN_TENANT 仅 dev 用）」。
//       本组用例回答两个问题：
//         Q1 无有效 JWT 的请求会不会因为该变量的存在而被放行？（= 是不是鉴权绕过）
//         Q2 该变量在生产到底还起不起作用？（= 删掉是不是行为等价）
//
// 纪律：Q1 的每条"必须 401"断言都配一条 dev 模式的**必红对照**（同一段请求在
//       AUTH_MODE=dev 下确实被放行）——否则"测试通过了"证明不了任何事。
// ==========================================================================================

/** 生产现场的确切组合：AUTH_MODE=prod + DEFAULT_LOGIN_TENANT=t-verification + 强随机 JWT_SECRET。 */
const PROD_LOGIN_TENANT = 't-verification';

/** 在给定环境变量组合下重装模块（DEFAULT_LOGIN_TENANT 是 module-load 期读取的常量，必须重装才生效）。 */
async function loadAuthWith(env: Record<string, string | undefined>) {
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else vi.stubEnv(k, v);
  }
  vi.resetModules();
  const m = await import('../middleware/auth.js');
  m.refreshAuthMode();
  return m;
}

/**
 * 用一个可控强度的请求打一次 authMiddleware，回收「是否放行 / 落到哪个租户 / 什么错码」。
 * 非公开路径（GET /v1/work_orders），不走 PUBLIC_POST_PATHS 豁免。
 */
async function probeIdentity(opts: {
  mode: 'dev' | 'prod';
  authHeader?: string;   // 不传 = 完全不带 Authorization；传 'Bearer xxx' = 带一个未签名/任意强度的头
  tenantHeader?: string; // X-Tenant-Id
}) {
  const { authMiddleware } = await loadAuthWith({
    AUTH_MODE: opts.mode,
    JWT_SECRET: SECRET,
    // ★ 关键：即使 prod，也要把这条 dev 兜底打开——生产 .env 里它就是开着的
    DEFAULT_LOGIN_TENANT: PROD_LOGIN_TENANT,
  });
  const req = {
    method: 'GET',
    url: '/v1/work_orders',
    path: '/v1/work_orders',
    originalUrl: '/api/v1/work_orders',
    header: (n: string) => {
      if (n === 'Authorization') return opts.authHeader;
      if (n === 'X-Tenant-Id') return opts.tenantHeader;
      return undefined;
    },
  } as unknown as Request;
  const res = makeRes();
  const { next, wasCalled } = makeNext();
  authMiddleware(req, res, next);
  await new Promise<void>((r) => setImmediate(r));
  const auth = (res as any).locals?.auth ?? (req as any).locals?.auth;
  return {
    statusCode: res.statusCode,
    body: res.body as any,
    sent: res.sent,
    passed: wasCalled(),
    auth,
  };
}

/** 完全无凭据请求（连 Authorization 都没有）。 */
const probeNoToken = (mode: 'dev' | 'prod') => probeIdentity({ mode });

/** 携带一个"形似但未经签名"的 bearer —— dev 模式会放行它，prod 必须拦。用来做变异对照。 */
const probeWeakToken = (mode: 'dev' | 'prod') =>
  probeIdentity({ mode, authHeader: 'Bearer dev-mode-unsigned-token' });

describe('DEFAULT_LOGIN_TENANT 生产残留 · 是否构成鉴权绕过', () => {
  it('🔴 prod + DEFAULT_LOGIN_TENANT 已设：无 JWT 请求必须 401 AUTH_001，不得放行', async () => {
    const r = await probeNoToken('prod');
    expect(r.passed).toBe(false);
    expect(r.statusCode).toBe(401);
    expect(r.body.code).toBe('AUTH_001');
  });

  it('🔴 prod + DEFAULT_LOGIN_TENANT 已设 + X-Tenant-Id: t-victim：仍然 401（不因该变量落到别的租户）', async () => {
    // 重申经典面：prod 分支里租户只取自签名 JWT 的 tid/tenantId（middleware/auth.ts:197），
    // 客户端可伪造的 X-Tenant-Id 不参与兜底（审查修复 #735-MEDIUM）。本例把该性质钉死。
    const r = await probeIdentity({ mode: 'prod', tenantHeader: 't-victim' });
    expect(r.passed).toBe(false);
    expect(r.statusCode).toBe(401);
    expect(r.auth).toBeUndefined();
  });

  it('🔴 变异对照①（证明断言有鉴别力）：携带未签名 bearer —— dev 放行并落到默认租户，prod 一律 401', async () => {
    const dev = await probeWeakToken('dev');
    const prod = await probeWeakToken('prod');
    // dev 侧必须放行并落到默认租户兜底；若这条也失败 ⇒ 这组探针根本测不到"放行"，后面全部无意义
    expect(dev.passed, 'dev 模式应放行未签名 bearer：若这条失败，说明探针没在测真正的分支').toBe(true);
    expect(dev.statusCode).toBe(0);
    expect(dev.auth?.tenantId).toBe(PROD_LOGIN_TENANT);
    // prod 侧必须拦住 ⇒ 两模式结果相反，断言具备鉴别力
    expect(prod.passed).toBe(false);
    expect(prod.statusCode).toBe(401);
    expect(prod.body.code).toBe('AUTH_002');
  });

  it('🔴 变异对照②（风险真正挂在哪）：同一条 prod 环境配置，只把 AUTH_MODE 翻成 dev ⇒ 立刻放行', async () => {
    // 这条回答"删不删变量"：风险不在这个变量本身，而在 AUTH_MODE 是否为 prod。
    // 用测试专用钩子翻转运行时模式（middleware/auth.ts:262 __setAuthModeForTest），
    // 环境变量一字不改（DEFAULT_LOGIN_TENANT 仍在），结果必须反转 ⇒ 说明 prod 分支确实不读它。
    const before = await probeWeakToken('prod');
    expect(before.passed).toBe(false);

    const m = await loadAuthWith({
      AUTH_MODE: 'prod',
      JWT_SECRET: SECRET,
      DEFAULT_LOGIN_TENANT: PROD_LOGIN_TENANT,
    });
    m.__setAuthModeForTest('dev'); // ← 唯一被改动的东西
    expect(m.AUTH_MODE).toBe('dev');
    const { authMiddleware } = m;
    const req = {
      method: 'GET',
      url: '/v1/work_orders',
      path: '/v1/work_orders',
      originalUrl: '/api/v1/work_orders',
      header: (n: string) => (n === 'Authorization' ? 'Bearer dev-mode-unsigned-token' : undefined),
    } as unknown as Request;
    const res = makeRes();
    const { next, wasCalled } = makeNext();
    authMiddleware(req, res, next);
    await new Promise<void>((r) => setImmediate(r));
    expect(wasCalled(), '翻转到 dev 后应放行：若不放行，说明上面的 401 是别的原因造成的恒绿').toBe(true);
    expect((res as any).locals.auth.tenantId).toBe(PROD_LOGIN_TENANT);
  });

  it('🔴 prod：伪造/过期 JWT 一律 401，DEFAULT_LOGIN_TENANT 不参与任何兜底', async () => {
    const { signJwt, authMiddleware } = await loadAuthWith({
      AUTH_MODE: 'prod',
      JWT_SECRET: SECRET,
      DEFAULT_LOGIN_TENANT: PROD_LOGIN_TENANT,
    });
    for (const tok of [
      'Bearer total-garbage',
      `Bearer ${signJwt({ sub: 'u1', tid: 't-victim', exp: Math.floor(Date.now() / 1000) + 3600 }, 'attacker-secret')}`,
      `Bearer ${signJwt({ sub: 'u1', tid: 't-victim', exp: Math.floor(Date.now() / 1000) - 10 }, SECRET)}`,
    ]) {
      const req = makeReq({ Authorization: tok });
      const res = makeRes();
      const { next, wasCalled } = makeNext();
      authMiddleware(req, res, next);
      await new Promise<void>((r) => setImmediate(r));
      expect(wasCalled(), `不得放行：${tok.slice(0, 40)}`).toBe(false);
      expect(res.statusCode).toBe(401);
      expect((res.body as any).code).toBe('AUTH_002');
    }
  });

  it('🔴 prod：合法签名但 payload 无 tid ⇒ 401 TENANT_001，DEFAULT_LOGIN_TENANT **不是**它的兜底', async () => {
    // 这是"最容易被填上兜底"的那个位置（middleware/auth.ts:197-200）：
    // 令牌已验签通过、只是没带租户，写一行 `?? process.env.DEFAULT_LOGIN_TENANT`
    // 就能让任意有效令牌落到 t-verification。本用例把"没这行"钉死。
    const { signJwt, authMiddleware } = await loadAuthWith({
      AUTH_MODE: 'prod',
      JWT_SECRET: SECRET,
      DEFAULT_LOGIN_TENANT: PROD_LOGIN_TENANT,
    });
    const noTid = signJwt({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
    const req = makeReq({ Authorization: `Bearer ${noTid}` });
    const res = makeRes();
    const { next, wasCalled } = makeNext();
    authMiddleware(req, res, next);
    await new Promise<void>((r) => setImmediate(r));
    expect(wasCalled()).toBe(false);
    expect(res.statusCode).toBe(401);
    expect((res.body as any).code).toBe('TENANT_001');
    expect((res as any).locals?.auth).toBeUndefined();
  });
});

describe('DEFAULT_LOGIN_TENANT 在生产到底起不起作用（决定"删不删"）', () => {
  /** 打一次真实的 POST /auth/login（不传 tenant），返回登录尝试落到的租户。 */
  async function tenantForLogin(defaultLoginTenant: string | undefined): Promise<{ tenantId: string; statusCode: number; body: any }> {
    loginProbe.tenants.length = 0;
    await loadAuthWith({
      AUTH_MODE: 'prod',
      JWT_SECRET: SECRET,
      ...(defaultLoginTenant === undefined ? {} : { DEFAULT_LOGIN_TENANT: defaultLoginTenant }),
    });
    const mod = await import('../routes/auth.js');
    const router = mod.default as any;
    const req = {
      method: 'POST',
      // Express Router 用 req.url 做路由匹配，**没有 url 字段它匹配不上任何路由**，
      // 会直接落到 next() ⇒ 处理器根本不执行（这就是探针收不到租户的原因）。
      url: '/auth/login',
      path: '/v1/auth/login',
      originalUrl: '/api/v1/auth/login',
      body: { username: 'probe', password: 'probe-pwd' }, // 故意不传 tenant
      header: () => undefined,
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Request;
    const res = makeRes();
    router(req, res, () => undefined);
    // 路由处理器是 async，等微任务队列排空再回收 res
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    return { tenantId: loginProbe.tenants[0], statusCode: res.statusCode, body: res.body };
  }

  it('该变量的唯一作用：决定"登录请求未指定租户时落到哪个租户"，且**不绕过口令校验**', async () => {
    const r = await tenantForLogin('tenant-A');
    // ① 租户确实被它改写了 ⇒ 变量在生产**是生效的**
    expect(r.tenantId).toBe('tenant-A');
    // ② 但因为没有有效账密，停在 registry 闸门，拿不到 token ⇒ 不是免密入口
    expect(r.body?.ok).toBe(false);
    expect(r.body?.token).toBeUndefined();
  });

  it('🟢 生产值恰好等于硬编码兜底 ⇒ 删掉它是行为等价的（no-op）', async () => {
    const { DEFAULT_TENANT_ID } = await loadAuthWith({ AUTH_MODE: 'prod' });
    // src/routes/auth.ts:23 = `process.env.DEFAULT_LOGIN_TENANT ?? DEFAULT_TENANT_ID`
    // middleware/auth.ts:36 = DEFAULT_TENANT_ID = 't-verification'
    expect(DEFAULT_TENANT_ID).toBe(PROD_LOGIN_TENANT);
    // ⇒ 设了 't-verification' 与不设，落到同一个租户
    const withVar = await tenantForLogin(PROD_LOGIN_TENANT);
    const withoutVar = await tenantForLogin(undefined);
    expect(withVar.tenantId).toBe(withoutVar.tenantId);
    expect(withVar.tenantId).toBe('t-verification');
    expect(withVar.statusCode).toBe(withoutVar.statusCode);
  });
});

// ==========================================================================================
// isPublicPath 查询串绕过 · P1 修复回归（2026-10-26）
//
// 缺陷：`middleware/auth.ts` 的 isPublicPath 用 `(req.originalUrl ?? '').endsWith('/auth/login')`
//       判定公开路径，而 Express 的 originalUrl **包含查询串** ⇒
//       `POST /api/v1/<任意受保护路径>?x=/auth/login` 命中该分支 ⇒ authMiddleware 直接 next()，
//       整段鉴权被跳过（端到端实测：HTTP 200 直达业务路由，res.locals.auth 为 undefined）。
// 修法：**甲** —— 判定前先按 RFC 去掉 ?query 与 #fragment，只拿 pathname 参与 endsWith。
//       （为何不取乙「删掉两个 endsWith 分支」见报告：甲是单变量最小改动，乙还会改变
//        `/v1/platform/auth/login` 这条不在 PUBLIC_POST_PATHS 里的路径的谓词结果。）
//
// 纪律：两条断言都配了定向变异验证（详见报告 §变异），不是恒绿。
// ==========================================================================================

/** 打一次 authMiddleware（**不带任何凭据**），回收"是否因公开路径豁免而放行"。 */
async function probePublicPath(opts: { method: 'GET' | 'POST'; originalUrl: string; path: string }) {
  const { authMiddleware } = await loadAuthWith({
    AUTH_MODE: 'prod',
    JWT_SECRET: SECRET,
    DEFAULT_LOGIN_TENANT: PROD_LOGIN_TENANT,
  });
  const req = {
    method: opts.method,
    url: opts.originalUrl.replace(/^\/api/, ''),
    path: opts.path,
    originalUrl: opts.originalUrl,
    header: () => undefined, // 故意不带 Authorization / X-Tenant-Id
  } as unknown as Request;
  const res = makeRes();
  const { next, wasCalled } = makeNext();
  authMiddleware(req, res, next);
  await new Promise<void>((r) => setImmediate(r));
  return { passed: wasCalled(), statusCode: res.statusCode, body: res.body as any, auth: (res as any).locals?.auth };
}

describe('isPublicPath · 查询串不得绕过鉴权（P1 修复 2026-10-26）', () => {
  it('🔴 业务路由 + ?x=/auth/login 等查询串 ⇒ 仍须 401 AUTH_001，不得 200 直达', async () => {
    // 基线对照：同名路由不带查询串本就 401 ⇒ 下面测得的是"查询串"这个变量，不是别的
    const base = await probePublicPath({ method: 'POST', originalUrl: '/api/v1/accounts', path: '/v1/accounts' });
    expect(base.passed, '基线：无凭据 POST 业务路由应被拦').toBe(false);
    expect(base.statusCode).toBe(401);

    for (const q of ['?x=/auth/login', '?x=/auth/wx-login', '?redirect=/auth/login&a=1', '?tenant=/auth/login']) {
      const r = await probePublicPath({ method: 'POST', originalUrl: `/api/v1/accounts${q}`, path: '/v1/accounts' });
      expect(r.passed, `不得因查询串豁免鉴权：${q}`).toBe(false);
      expect(r.statusCode, `不得因查询串豁免鉴权：${q}`).toBe(401);
      expect(r.body.code).toBe('AUTH_001');
      expect(r.auth, `不得放行：res.locals.auth 必须仍是 undefined（否则业务路由拿到空身份）`).toBeUndefined();
    }
  });

  it('🟢 合法登录端点（含查询串）仍必须豁免 ⇒ 防修过头把真登录挡掉', async () => {
    // ① PUBLIC_POST_PATHS 主口径：租户登录 / 微信登录，带查询串也必须放行
    for (const [originalUrl, path] of [
      ['/api/v1/auth/login', '/v1/auth/login'],
      ['/api/v1/auth/login?tenant=t1&remember=1', '/v1/auth/login'],
      ['/api/v1/auth/wx-login?from=mp', '/v1/auth/wx-login'],
      ['/api/v1/auth/login?next=%2Fhome#frag', '/v1/auth/login'],
    ] as const) {
      const r = await probePublicPath({ method: 'POST', originalUrl, path });
      expect(r.passed, `合法登录必须豁免：${originalUrl}`).toBe(true);
      expect(r.statusCode, `合法登录不得被拦：${originalUrl}`).toBe(0);
    }
    // ② endsWith 分支唯一仍在承担作用的形态：/v1/platform/auth/login **不在** PUBLIC_POST_PATHS 里
    //    （它今天挂在 authMiddleware 之前所以不过来，但谓词语义必须保持，否则一旦调整挂载顺序就炸登录）
    const plat = await probePublicPath({ method: 'POST', originalUrl: '/api/v1/platform/auth/login?tenant=t1', path: '/v1/platform/auth/login' });
    expect(plat.passed, '平台管理员登录路径必须仍被豁免（endsWith 分支不可删）').toBe(true);
    // ③ 方法维不变：GET 同一路径不得豁免（isPublicPath 只对 POST 生效）
    const get = await probePublicPath({ method: 'GET', originalUrl: '/api/v1/auth/login', path: '/v1/auth/login' });
    expect(get.passed, 'GET 不受公开路径豁免').toBe(false);
    expect(get.statusCode).toBe(401);
  });
});
