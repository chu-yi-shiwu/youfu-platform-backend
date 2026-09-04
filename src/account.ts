// 生产化④「自建账号」账户模块：密码哈希（scrypt，零依赖）、登录令牌签发、账户 DB 读写。
//
// 设计要点：
//  - 密码哈希用 Node 内置 crypto.scryptSync（零新增依赖，与 JWT 同思路），
//    存储格式 `scrypt$<saltHex>$<hashHex>`，验证走 timingSafeEqual 防时序攻击。
//  - 登录令牌复用 middleware/auth.ts 的 signJwt（HS256），并补 exp 过期；
//    令牌载荷含 sub(用户)/tid(租户)/role(角色)/username，与 authMiddleware 读取字段对齐。
//  - 账户按租户隔离（RLS 经 withTenantClient 注入 tenant_id 生效）。
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { signJwt } from './middleware/auth.js';
import { ROLES } from './middleware/role.js';
import { withTenantClient } from './db/pool.js';

// 账户角色派生自 middleware/role.ts 的 ROLES 单一事实源（AL-002：含 reviewer/service_desk，
// 与 stateMachine allowedRoles / workflow_def 对齐；DB 侧 CHECK 由 069 迁移同步放宽）。
export type AccountRole = (typeof ROLES)[number];

export interface AccountUser {
  id: string;
  tenant_id: string;
  username: string;
  password_hash: string; // 内部字段，toPublic 不外露
  display_name: string | null;
  role: AccountRole;
  active: boolean;
  wx_openid?: string | null; // v5.0 P0：微信 openid（绑定后非空，toPublic 只暴露 wx_bound）
}

export interface AccountUserPublic {
  id: string;
  username: string;
  display_name: string | null;
  role: AccountRole;
  tenant_id: string;
  active: boolean;
  wx_bound: boolean; // v5.0 P0：是否已绑定微信（不暴露 openid 本身）
}

function toPublic(u: AccountUser): AccountUserPublic {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    tenant_id: u.tenant_id,
    active: u.active,
    wx_bound: Boolean(u.wx_openid),
  };
}

// ---- 密码哈希（scrypt） ----

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = crypto.scryptSync(password, salt, expected.length);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// ---- 登录令牌 ----

const DEFAULT_TTL_SECONDS = 60 * 60 * 24; // 24h

export function signLoginToken(
  user: { sub: string; tid: string; role: AccountRole; username: string },
  secret: string,
): string {
  const ttl = Number(process.env.JWT_TTL_SECONDS ?? DEFAULT_TTL_SECONDS);
  const exp = Math.floor(Date.now() / 1000) + (Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_SECONDS);
  return signJwt(
    { sub: user.sub, tid: user.tid, role: user.role, username: user.username, exp },
    secret,
  );
}

// ---- 账户 DB 读写（租户经 withTenantClient 注入） ----

export interface CreateUserInput {
  username: string;
  password: string;
  display_name?: string | null;
  role?: AccountRole;
}

export async function createUser(
  client: PoolClient,
  tenantId: string,
  input: CreateUserInput,
): Promise<AccountUser> {
  const r = await client.query<AccountUser>(
    `INSERT INTO account_user (tenant_id, username, password_hash, display_name, role, active)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING id, tenant_id, username, display_name, role, active`,
    [tenantId, input.username, hashPassword(input.password), input.display_name ?? null, input.role ?? 'operator'],
  );
  return r.rows[0];
}

export async function findUserByUsername(
  client: PoolClient,
  tenantId: string,
  username: string,
): Promise<AccountUser | undefined> {
  const r = await client.query<AccountUser>(
    `SELECT id, tenant_id, username, password_hash, display_name, role, active, wx_openid
     FROM account_user WHERE tenant_id = $1 AND username = $2`,
    [tenantId, username],
  );
  return r.rows[0];
}

export async function findUserById(
  client: PoolClient,
  tenantId: string,
  id: string,
): Promise<AccountUser | undefined> {
  const r = await client.query<AccountUser>(
    `SELECT id, tenant_id, username, password_hash, display_name, role, active, wx_openid
     FROM account_user WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  return r.rows[0];
}

// 仅更新密码哈希（改密/重置）。调用方须已通过鉴权与旧密码校验，且传入正确的租户与用户。
export async function updateUserPassword(
  client: PoolClient,
  tenantId: string,
  userId: string,
  newPassword: string,
): Promise<void> {
  await client.query(
    `UPDATE account_user SET password_hash = $1, updated_at = now()
     WHERE tenant_id = $2 AND id = $3`,
    [hashPassword(newPassword), tenantId, userId],
  );
}

export async function listUsers(client: PoolClient, tenantId: string): Promise<AccountUser[]> {
  const r = await client.query<AccountUser>(
    `SELECT id, tenant_id, username, password_hash, display_name, role, active, wx_openid
     FROM account_user WHERE tenant_id = $1 ORDER BY username`,
    [tenantId],
  );
  return r.rows;
}

export { toPublic, withTenantClient };
