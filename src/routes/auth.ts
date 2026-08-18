// 生产化④「自建账号」认证路由：登录（公开）/ 当前用户 / 账户管理（admin）。
// 登录端点必须豁免 authMiddleware（否则拿不到令牌），详见 middleware/auth.ts 的 PUBLIC 豁免。
import { Router } from 'express';
import z from 'zod';
import { AUTH_MODE, type AuthLocals } from '../middleware/auth.js';
import {
  createUser,
  findUserByUsername,
  findUserById,
  listUsers,
  signLoginToken,
  toPublic,
  verifyPassword,
  updateUserPassword,
  withTenantClient,
  type AccountRole,
} from '../account.js';

const router = Router();

const DEFAULT_LOGIN_TENANT = process.env.DEFAULT_LOGIN_TENANT ?? 't-verification';

// 解析 JWT 签名密钥：prod 缺失 → 返回 null（fail-closed）；dev 缺失 → 不安全默认（仅本地调试）
function resolveSecret(): string | null {
  const s = process.env.JWT_SECRET;
  if (s) return s;
  if (AUTH_MODE === 'dev') {
    console.warn('[auth] JWT_SECRET 未配置，dev 模式使用不安全默认密钥（仅本地调试，生产请设置）');
    return 'dev-only-insecure-secret';
  }
  return null;
}

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(200),
  tenant: z.string().max(64).optional(),
});

// POST /api/v1/auth/login —— 公开（豁免鉴权）：校验账密并签发 JWT
router.post('/auth/login', async (req, res, next) => {
  try {
    const { username, password, tenant } = loginSchema.parse(req.body);
    const tenantId = tenant ?? req.header('X-Tenant-Id') ?? DEFAULT_LOGIN_TENANT;

    const user = await withTenantClient(tenantId, (client) => findUserByUsername(client, tenantId, username));
    // 统一返回 401，避免暴露"用户是否存在"（防枚举）
    if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ ok: false, code: 'AUTH_003', message: 'invalid credentials' });
    }

    const secret = resolveSecret();
    if (!secret) {
      return res.status(500).json({ ok: false, code: 'AUTH_CFG', message: 'JWT_SECRET not configured on server' });
    }
    const token = signLoginToken(
      { sub: user.id, tid: tenantId, role: user.role as AccountRole, username: user.username },
      secret,
    );
    return res.json({ ok: true, code: 0, token, user: toPublic(user) });
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/auth/me —— 受保护：返回当前令牌对应账户
router.get('/auth/me', async (req, res, next) => {
  try {
    const auth = res.locals.auth as AuthLocals;
    if (!auth) return res.status(401).json({ ok: false, code: 'AUTH_001', message: 'missing auth' });
    // dev 模式无真实令牌，返回合成 dev 账户便于联调
    if (auth.authMode === 'dev' || !auth.userId) {
      return res.json({
        ok: true,
        code: 0,
        user: { id: 'dev', username: 'dev', display_name: '开发模式', role: 'admin', tenant_id: auth.tenantId, active: true },
      });
    }
    const user = await withTenantClient(auth.tenantId, (client) => findUserById(client, auth.tenantId, auth.userId!));
    if (!user) return res.status(404).json({ ok: false, code: 'USER_404', message: 'user not found' });
    return res.json({ ok: true, code: 0, user: toPublic(user) });
  } catch (e) {
    next(e);
  }
});

// admin 守卫：prod 需 role=admin；dev 模式放行（本地调试）
function requireAdmin(auth: AuthLocals): boolean {
  if (auth.authMode === 'dev') return true;
  return auth.role === 'admin';
}

const changePwSchema = z.object({
  old_password: z.string().min(1).max(200),
  new_password: z.string().min(6).max(200),
});

// PATCH /api/v1/auth/change-password —— 受保护：登录用户修改自己的密码（需旧密码校验）
router.patch('/auth/change-password', async (req, res, next) => {
  try {
    const auth = res.locals.auth as AuthLocals;
    if (!auth) return res.status(401).json({ ok: false, code: 'AUTH_001', message: 'missing auth' });
    // dev 模式无真实密码体系，直接放行（本地调试）
    if (auth.authMode === 'dev' || !auth.userId) {
      return res.json({ ok: true, code: 0 });
    }
    const { old_password, new_password } = changePwSchema.parse(req.body);
    const user = await withTenantClient(auth.tenantId, (client) => findUserById(client, auth.tenantId, auth.userId!));
    if (!user) return res.status(404).json({ ok: false, code: 'USER_404', message: 'user not found' });
    if (!verifyPassword(old_password, user.password_hash)) {
      return res.status(401).json({ ok: false, code: 'AUTH_003', message: 'invalid old password' });
    }
    await withTenantClient(auth.tenantId, (client) =>
      updateUserPassword(client, auth.tenantId, auth.userId!, new_password),
    );
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

const createUserSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(6).max(200),
  display_name: z.string().max(64).optional(),
  role: z.enum(['admin', 'operator']).optional(),
});

// POST /api/v1/auth/users —— admin：创建账户（同租户）
router.post('/auth/users', async (req, res, next) => {
  try {
    const auth = res.locals.auth as AuthLocals;
    if (!auth) return res.status(401).json({ ok: false, code: 'AUTH_001', message: 'missing auth' });
    if (!requireAdmin(auth)) return res.status(403).json({ ok: false, code: 'FORBID_001', message: 'admin only' });
    const input = createUserSchema.parse(req.body);
    const created = await withTenantClient(auth.tenantId, (client) => createUser(client, auth.tenantId, input));
    return res.status(201).json({ ok: true, code: 0, user: toPublic(created) });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === '23505') {
      return res.status(409).json({ ok: false, code: 'USER_EXISTS', message: 'username already exists in tenant' });
    }
    next(e);
  }
});

// GET /api/v1/auth/users —— admin：列出租户内账户
router.get('/auth/users', async (req, res, next) => {
  try {
    const auth = res.locals.auth as AuthLocals;
    if (!auth) return res.status(401).json({ ok: false, code: 'AUTH_001', message: 'missing auth' });
    if (!requireAdmin(auth)) return res.status(403).json({ ok: false, code: 'FORBID_001', message: 'admin only' });
    const users = await withTenantClient(auth.tenantId, (client) => listUsers(client, auth.tenantId));
    return res.json({ ok: true, code: 0, users: users.map(toPublic) });
  } catch (e) {
    next(e);
  }
});

export default router;
