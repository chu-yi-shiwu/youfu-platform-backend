// 邀请码域路由（八件增量 BE-1）：admin 生成/列出/作废邀请码 + 公开激活（redeem）建号。
// 挂载于 /api/v1（server.ts，authMiddleware 之后，同 authRouter）：
//   - POST/GET/DELETE /invites（admin requireRole）：码明文仅在生成响应返回一次；
//   - POST /invites/redeem（公开，PUBLIC_POST_PATHS 豁免 + loginRateLimit）：凭码建号并签发 JWT。
// 安全口径（架构 §七）：
//   - 码只存 HMAC-SHA256(code, INVITE_SALT)（复用 platform.ts sha256Secret 先例，盐环境化兜底）；
//   - redeem 防枚举：不存在/过期/已用/已作废一律 400 INVITE_INVALID，文案统一
//     「邀请码已失效，请联系管理员重新生成」；
//   - 生成/作废/激活全部写 platform_audit（失败不阻断主流程，与 platform.ts audit 同口径）。
import { Router } from 'express';
import z from 'zod';
import crypto from 'node:crypto';
import pool, { withTenantClient } from '../db/pool.js';
import { AUTH_MODE, loginRateLimit, requireRole, type AuthLocals } from '../middleware/auth.js';
import { listPerms, ROLES } from '../middleware/role.js';
import {
  createUser,
  findUserByUsername,
  signLoginToken,
  toPublic,
  type AccountRole,
} from '../account.js';
import { AppError } from '../middleware/error.js';

const router = Router();

// ---- 邀请码哈希（HMAC-SHA256，盐环境化：INVITE_SALT → APP_SECRET_SALT → 既定兜底常量） ----
const INVITE_SALT =
  process.env.INVITE_SALT ?? process.env.APP_SECRET_SALT ?? 'youfu-app-secret-salt';

/** 规范化邀请码（trim + 大写）后做 HMAC-SHA256；生成与 redeem 两侧共用，保证等值可查。 */
export function hmacInviteCode(code: string): string {
  return crypto.createHmac('sha256', INVITE_SALT).update(code.trim().toUpperCase()).digest('hex');
}

// base32（RFC 4648）字母表：256 % 32 === 0，逐字节取模无偏
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 生成明文邀请码：12 字节随机 → base32 12 字符（60 bit 熵）→ YF-xxxx-xxxx-xxxx 分组。 */
function randomInviteCode(): string {
  const bytes = crypto.randomBytes(12);
  const chars = Array.from(bytes, (b) => BASE32_ALPHABET[b % 32]).join('');
  return `YF-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

const INVITE_TTL_HOURS = 72;
const INVITE_INVALID_MESSAGE = '邀请码已失效，请联系管理员重新生成';

// ---- 审计（append-only platform_audit；失败不阻断主流程，与 platform.ts 同口径） ----
async function audit(
  actor: string,
  action: string,
  resource?: string | null,
  targetTenant?: string | null,
  payload?: unknown,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO platform_audit (actor, action, resource, target_tenant, payload) VALUES ($1,$2,$3,$4,$5)`,
      [actor, action, resource ?? null, targetTenant ?? null, payload ? JSON.stringify(payload) : null],
    );
  } catch (e) {
    console.warn('[invite] platform_audit 写入失败（不阻断主流程）', {
      actor, action, resource, targetTenant, err: e instanceof Error ? e.message : String(e),
    });
  }
}

// 与 routes/auth.ts resolveSecret 同口径：prod 缺 JWT_SECRET → fail-closed null；dev 用不安全默认
function resolveJwtSecret(): string | null {
  const s = process.env.JWT_SECRET;
  if (s) return s;
  if (AUTH_MODE === 'dev') return 'dev-only-insecure-secret';
  return null;
}

function requireAdminAuth(res: { locals: { auth?: AuthLocals } }): AuthLocals {
  const auth = res.locals.auth as AuthLocals | undefined;
  if (!auth) throw new AppError('AUTH_001', 'missing auth', 401);
  if (!requireRole(auth, 'admin')) throw new AppError('FORBID_001', 'admin only', 403);
  return auth;
}

const inviteCreateSchema = z.object({
  username: z.string().regex(/^[a-z0-9_-]{2,64}$/i, '用户名 2-64 位字母数字下划线'),
  display_name: z.string().max(64).optional(),
  role: z.enum(ROLES).optional(),
});

// ---- POST /api/v1/invites —— admin：生成邀请码（明文仅本次响应返回一次；重发先作废旧码） ----
router.post('/invites', async (req, res, next) => {
  try {
    const auth = requireAdminAuth(res);
    const b = inviteCreateSchema.parse(req.body);
    const tenantId = auth.tenantId;
    const code = randomInviteCode();
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3600 * 1000);
    const row = await withTenantClient(tenantId, async (client) => {
      // 预定账号名不得与既有账号重名（激活时建号会撞 UNIQUE(tenant_id, username)）
      const existing = await findUserByUsername(client, tenantId, b.username);
      if (existing) throw new AppError('USER_EXISTS', '该用户名在本机构已存在', 409);
      // 重发语义：作废同账号全部在途有效码（部分唯一索引兜底并发）
      await client.query(
        `UPDATE invite_codes SET revoked_at = now()
         WHERE tenant_id = $1 AND username = $2 AND used_at IS NULL AND revoked_at IS NULL`,
        [tenantId, b.username],
      );
      const ins = await client.query(
        `INSERT INTO invite_codes (tenant_id, code_hash, username, display_name, role, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, username, display_name, role, expires_at, created_at`,
        [tenantId, hmacInviteCode(code), b.username, b.display_name ?? null, b.role ?? 'operator', auth.username ?? null, expiresAt.toISOString()],
      );
      return ins.rows[0];
    });
    await audit(auth.username ?? 'admin', 'invite.create', String(row.id), tenantId, {
      username: b.username,
      role: row.role,
    });
    // 明文 code 仅此一次返回；后续任何接口只回状态。
    // 契约偏差说明：响应包裹固定 code:0 与码明文字段名 code 撞名，故码信息嵌套 invite 对象，
    // 字段名保持 code 语义（FE/mp 读取 j.invite.code）。
    return res.status(201).json({
      ok: true,
      code: 0,
      invite: {
        id: row.id, // P3 契约补全（R4 深测）：作废需 id，创建响应直接带回免二次查询
        code,
        username: row.username,
        display_name: row.display_name,
        role: row.role,
        expires_at: row.expires_at,
      },
    });
  } catch (e) {
    next(e);
  }
});

// ---- GET /api/v1/invites —— admin：邀请码列表（只回状态，绝不回码明文/哈希） ----
type InviteRow = {
  id: string;
  username: string;
  display_name: string | null;
  role: string;
  created_by: string | null;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

/** 状态派生：已用 > 已作废 > 已过期 > 有效（与 redeem 校验顺序同口径）。 */
function inviteStatus(row: Pick<InviteRow, 'used_at' | 'revoked_at' | 'expires_at'>): 'active' | 'used' | 'revoked' | 'expired' {
  if (row.used_at) return 'used';
  if (row.revoked_at) return 'revoked';
  if (new Date(row.expires_at).getTime() <= Date.now()) return 'expired';
  return 'active';
}

router.get('/invites', async (req, res, next) => {
  try {
    const auth = requireAdminAuth(res);
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 200) : 50;
    const rows = await withTenantClient(auth.tenantId, (client) =>
      client.query<InviteRow>(
        `SELECT id, username, display_name, role, created_by, expires_at, used_at, revoked_at, created_at
         FROM invite_codes WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [auth.tenantId, limit],
      ),
    );
    return res.json({
      ok: true,
      code: 0,
      items: rows.rows.map((r) => ({ ...r, status: inviteStatus(r) })),
    });
  } catch (e) {
    next(e);
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- DELETE /api/v1/invites/:id —— admin：作废邀请码（置 revoked_at；已用/已作废幂等视作 404） ----
router.delete('/invites/:id', async (req, res, next) => {
  try {
    const auth = requireAdminAuth(res);
    const id = String(req.params.id ?? '');
    // 非法 uuid 直接按不存在处理（避免 22P02 冒 500/400 误导「码还在」）
    if (!UUID_RE.test(id)) throw new AppError('INVITE_404', '邀请码不存在', 404);
    const r = await withTenantClient(auth.tenantId, (client) =>
      client.query(
        `UPDATE invite_codes SET revoked_at = now()
         WHERE id = $1 AND tenant_id = $2 AND used_at IS NULL AND revoked_at IS NULL
         RETURNING id, username`,
        [id, auth.tenantId],
      ),
    );
    if (r.rowCount === 0) throw new AppError('INVITE_404', '邀请码不存在或已失效', 404);
    await audit(auth.username ?? 'admin', 'invite.revoke', id, auth.tenantId, {
      username: r.rows[0].username,
    });
    return res.json({ ok: true, code: 0, item: r.rows[0] });
  } catch (e) {
    next(e);
  }
});

const redeemSchema = z.object({
  code: z.string().min(4).max(64),
  password: z.string().min(6, '密码至少 6 位').max(200),
});

// ---- POST /api/v1/invites/redeem —— 公开激活：凭码 + 设密码 → 建号 + 签发 JWT ----
// 防枚举：码不存在/已过期/已使用/已作废 → 一律 400 INVITE_INVALID + 统一文案；
// 建号 + 置 used_at 在同租户单连接事务内完成（并发双花由 UPDATE 行锁 + 守卫条件兜底）。
router.post('/invites/redeem', loginRateLimit(10), async (req, res, next) => {
  try {
    const b = redeemSchema.parse(req.body);
    const codeHash = hmacInviteCode(b.code);
    // 第一步（pool 直连，跨租户）：凭哈希定位码；查不到即统一 INVITE_INVALID
    const found = await pool.query(
      `SELECT id, tenant_id, username, display_name, role, expires_at, used_at, revoked_at
       FROM invite_codes WHERE code_hash = $1`,
      [codeHash],
    );
    const invite = found.rows[0] as
      | { id: string; tenant_id: string; username: string; display_name: string | null; role: string; expires_at: string; used_at: string | null; revoked_at: string | null }
      | undefined;
    if (
      !invite ||
      invite.used_at ||
      invite.revoked_at ||
      new Date(invite.expires_at).getTime() <= Date.now()
    ) {
      throw new AppError('INVITE_INVALID', INVITE_INVALID_MESSAGE, 400);
    }
    const tenantId = invite.tenant_id;
    const result = await withTenantClient(tenantId, async (client) => {
      // 🔴 P2 修复（R4 深测实锤）：租户 status 守卫——suspended/pending 租户的在途邀请码
      //    不得激活建号+发 JWT（与 /auth/login 的 TENANT_SUSPENDED/TENANT_PENDING 门同口径）。
      //    缺记录（未登记 registry 的存量租户）→ 放行，与 login 行为一致。
      const reg = await client.query(
        `SELECT status FROM tenant_registry WHERE tenant_id = $1`,
        [tenantId],
      );
      const regStatus = reg.rows[0]?.status as string | undefined;
      if (regStatus === 'suspended') {
        throw new AppError('TENANT_SUSPENDED', 'tenant suspended by platform', 403);
      }
      if (regStatus === 'pending') {
        throw new AppError('TENANT_PENDING', '租户待激活，请联系平台管理员', 403);
      }
      // 账号名冲突（生成后又被手工建号）：语义化 409，与 POST /auth/users 同口径
      const existing = await findUserByUsername(client, tenantId, invite.username);
      if (existing) throw new AppError('USER_EXISTS', '该用户名在本机构已存在', 409);
      // 一次性守卫：仅未用/未作废/未过期的行可置 used_at（并发双花在此收敛为 INVITE_INVALID）
      const claim = await client.query(
        `UPDATE invite_codes SET used_at = now()
         WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
        [invite.id],
      );
      if ((claim.rowCount ?? 0) === 0) throw new AppError('INVITE_INVALID', INVITE_INVALID_MESSAGE, 400);
      const user = await createUser(client, tenantId, {
        username: invite.username,
        password: b.password,
        display_name: invite.display_name,
        role: (ROLES as readonly string[]).includes(invite.role) ? (invite.role as AccountRole) : 'operator',
      });
      const permissions = await listPerms(
        { tenantId, requestId: '', role: user.role, authMode: 'prod' },
        client,
      );
      return { user, permissions };
    });
    const secret = resolveJwtSecret();
    if (!secret) throw new AppError('AUTH_CFG', 'JWT_SECRET not configured on server', 500);
    const token = signLoginToken(
      { sub: result.user.id, tid: tenantId, role: result.user.role, username: result.user.username },
      secret,
    );
    await audit(invite.username, 'invite.redeem', invite.id, tenantId, { username: invite.username });
    return res.status(201).json({
      ok: true,
      code: 0,
      token,
      user: toPublic(result.user),
      permissions: result.permissions,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
