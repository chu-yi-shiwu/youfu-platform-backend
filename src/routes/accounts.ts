// ② 主数据补全：账号(account_user) 管理 CRUD。
// account_user 表由 007_account.sql 建好（登录账户体系，含密码哈希）；此前仅 auth.ts 内部登录/读取，
// 缺「管理员维护账户」的路由。本文件补齐 list/get/create/update/delete，
// 复用 src/account.ts 的 hashPassword（scrypt，零依赖）与 toPublic（不外泄 password_hash）。
//
// 账号权限一期（20260913《优服家_账号权限体系一期设计》）收口：
//   G1+G2  last-admin 保护事务化 + 覆盖"降级"边（SELECT ... FOR UPDATE 与 UPDATE 同闭包=同事务）；
//   G3     SELF_GUARD 补全：改自己角色/停用自己 → 403（改自己 display_name/phone 放行=自服务）；
//   G4     守卫统一 requirePermission('role.manage')（替代 requireConfigRole/assertAdmin 散落）；
//          H1 有意收紧：operator 默认矩阵无 role.manage，租户可经 role_permission 显式授予；
//   G5     PUT permissions 白名单校验（非法权限点 400 BAD_PERM，禁静默落库）；
//   G6     GET perm-catalog：权限点全集+中文 label 单一事实源（前端不再硬编码）；
//   G7     phone 档案字段（082 迁移同租户唯一部分索引；23505 由 errorMiddleware 透出 409 CONFLICT）；
//   G8     重置密码独立端点：服务端随机 12 位临时密码，明文仅响应一次（管理员不经手密码）。
// 说明：设计稿表述"17 权限点"，PERMS 实际 16 点——perm-catalog 数量断言锚定 PERMS.length
// （单一事实源自洽，防硬编码漂移；新增权限点自动进 catalog）。
import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { ROLES, PERMS, DEFAULT_PERM_MATRIX, canAssignRole, requirePermission, type Role, type Perm } from '../middleware/role.js';
import type { AuthLocals } from '../middleware/auth.js';
import { hashPassword, toPublic } from '../account.js';

const router = Router();

const COLS = 'id, tenant_id, username, display_name, role, active, phone';

const accountCreateSchema = z.object({
  username: z.string().min(2),
  password: z.string().min(6),
  display_name: z.string().optional(),
  // AL-002：枚举改引 ROLES 单一事实源（含 reviewer/service_desk，与 stateMachine 对齐）
  role: z.enum(ROLES).optional(),
});

// G7/G8：PUT 不再收 password（重置走 POST /:id/reset-password，管理员不经手密码）；
// phone：11 位大陆手机号，或空串=清空（落库置 NULL）。格式校验在路由内手动做——
// 抛 400 BAD_PARAM（设计稿口径；zod 解析失败会被 errorMiddleware 统一映成 422，语义不符）。
const accountUpdateSchema = z.object({
  display_name: z.string().optional(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
  phone: z.string().max(11).optional(),
});

// ============ RBAC：租户角色权限（批次 A2） ============

// 权限点中文标签（G6 单一事实源）：新增 PERMS 项时必须同步登记 label，
// perm-catalog 数量断言（PERMS vs labels）会在测试里拦漏登记。
const PERM_LABELS: Record<Perm, string> = {
  'dashboard.view': '总览看板',
  'intake.create': '建单录入',
  'ticket.manage': '工单管理',
  'workflow.edit': '流程配置',
  'workflow.approve': '流程审批',
  'basicdata.edit': '基础数据',
  'dispatch.override': '派单覆盖',
  'role.manage': '账号权限',
  'inspect.execute': '巡检执行',
  'asset.scan': '资产扫码',
  'optimize.tune': '优化调参',
  'settlement.read': '结算查看',
  'settlement.edit': '结算操作',
  'volunteer.view': '志愿者查看',
  'volunteer.manage': '志愿者管理',
  'volunteer.audit': '志愿者核销',
};

// GET /api/v1/accounts/roles/perm-catalog —— G6：权限点全集 + 中文名（role.manage）。
// FE 权限矩阵 tab 以此渲染列头，不再硬编码权限点清单。
router.get('/accounts/roles/perm-catalog', async (req, res, next) => {
  try {
    const auth = res.locals.auth as AuthLocals;
    const items = await withTenantClient(auth.tenantId, async (client) => {
      await requirePermission(auth, client, 'role.manage');
      return PERMS.map((perm) => ({ perm, label: PERM_LABELS[perm] ?? perm }));
    });
    // 防漏登记：label 缺失回退 perm 名，但数量必须与 PERMS 全集一致
    if (items.length !== PERMS.length) {
      throw new AppError('INTERNAL', 'perm-catalog 数量与 PERMS 全集不一致（新权限点漏登记 label）', 500);
    }
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// GET /api/v1/accounts/roles/permissions —— 列出本租户全部 6 角色的权限。
// 语义（修正 2026-09-05）：role_permission 表有该租户该角色的行 → **覆盖替换**（只用覆盖集合，非并集）；
// 无覆盖行 → 回退官方推荐默认矩阵（overridden:false，随平台升级自动更新）。
// 账号权限一期：守卫统一切 role.manage（G4）；响应补 default_perms（§3.5，矩阵"默认值参考列"）。
router.get('/accounts/roles/permissions', async (req, res, next) => {
  try {
    const auth = res.locals.auth as AuthLocals;
    const items = await withTenantClient(auth.tenantId, async (client) => {
      await requirePermission(auth, client, 'role.manage');
      const rows = await client.query(`SELECT role, perm FROM role_permission WHERE tenant_id=$1`, [auth.tenantId]);
      const overrides: Record<string, Set<string>> = {};
      for (const r of rows.rows) {
        (overrides[r.role] ??= new Set()).add(r.perm);
      }
      return ROLES.map((role: Role) => ({
        role,
        perms: [...(overrides[role] ?? DEFAULT_PERM_MATRIX[role])].sort(),
        default_perms: [...DEFAULT_PERM_MATRIX[role]].sort(),
        overridden: overrides[role] != null,
      }));
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// PUT /api/v1/accounts/roles/:role/permissions —— 覆盖某角色的权限点（先删后插，事务）。
// G5：perms 逐项白名单校验（∈ PERMS），非法点 400 BAD_PERM 列出全部——禁错字静默落库
// （hasPerm 恒 false 难排查教训）。
router.put('/accounts/roles/:role/permissions', async (req, res, next) => {
  try {
    const auth = res.locals.auth as AuthLocals;
    const role = req.params.role as Role;
    if (!ROLES.includes(role)) throw new AppError('BAD_PARAM', `unknown role: ${role}`, 400);
    const body = z.object({ perms: z.array(z.string().min(1).max(64)) }).parse(req.body);
    const permSet = new Set<string>(PERMS);
    const illegal = body.perms.filter((p) => !permSet.has(p));
    if (illegal.length > 0) {
      throw new AppError('BAD_PERM', `非法权限点：${illegal.join('、')}（可用清单见 GET /accounts/roles/perm-catalog）`, 400);
    }
    if (role === 'admin') {
      throw new AppError('BAD_PARAM', 'admin 权限不可修改（恒全放行）', 400);
    }
    await withTenantClient(auth.tenantId, async (client) => {
      await requirePermission(auth, client, 'role.manage');
      await client.query(`DELETE FROM role_permission WHERE tenant_id=$1 AND role=$2`, [auth.tenantId, role]);
      for (const p of body.perms) {
        await client.query(
          `INSERT INTO role_permission (tenant_id, role, perm) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [auth.tenantId, role, p],
        );
      }
    });
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

// ============ 账户列表（不外泄密码哈希） ============
// R38-R3-F1 修复：GET /accounts 此前无角色守卫，operator/reporter 均可枚举本租户
// 全部账号（username/role/active）。账号权限一期：统一收口 role.manage（G4）——
// 租户可显式授予非 admin 管理面；默认矩阵下仅 admin 可读，无默认行为放宽。
router.get('/accounts', async (req, res, next) => {
  try {
    const auth = res.locals.auth as AuthLocals;
    const items = await withTenantClient(auth.tenantId, async (client) => {
      await requirePermission(auth, client, 'role.manage');
      return client
        .query(`SELECT ${COLS} FROM account_user WHERE tenant_id=$1 ORDER BY username`, [auth.tenantId])
        .then((r) => r.rows.map(toPublic));
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// ============ 账户详情 ============
router.get('/accounts/:id', async (req, res, next) => {
  try {
    // 与列表同口径：role.manage（G4 统一；详情含角色/账号结构）
    const auth = res.locals.auth as AuthLocals;
    const item = await withTenantClient(auth.tenantId, async (client) => {
      await requirePermission(auth, client, 'role.manage');
      return client
        .query(`SELECT ${COLS} FROM account_user WHERE id=$1 AND tenant_id=$2`, [req.params.id, auth.tenantId])
        .then((r) => (r.rowCount ? toPublic(r.rows[0]) : null));
    });
    if (!item) throw new AppError('NOT_FOUND', 'account not found', 404);
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// ============ 新建账户 ============
router.post('/accounts', async (req, res, next) => {
  try {
    const auth = res.locals.auth as AuthLocals;
    const tenantId = auth.tenantId;
    const b = accountCreateSchema.parse(req.body);
    // R15-005 修复：角色分配门禁——operator 不得铸造 admin 或越级分配。
    const callerRole = auth.role as Role;
    if (b.role && !canAssignRole(callerRole, b.role)) {
      throw new AppError('FORBIDDEN', '无权分配该角色（不可越级或授予 admin）', 403);
    }
    const item = await withTenantClient(tenantId, async (client) => {
      // G4/H1：建号守卫统一切 role.manage（默认矩阵仅 admin；operator 需租户显式授予——
      // breaking 已报备初一，存量依赖 operator 建号的租户由平台代授 role_permission）。
      await requirePermission(auth, client, 'role.manage');
      const dup = await client.query(
        `SELECT 1 FROM account_user WHERE tenant_id=$1 AND username=$2 LIMIT 1`,
        [tenantId, b.username],
      );
      if (dup.rowCount && dup.rowCount > 0) {
        throw new AppError('CONFLICT', '该租户下用户名已存在', 409);
      }
      const r = await client.query(
        `INSERT INTO account_user (tenant_id, username, password_hash, display_name, role, active)
         VALUES ($1,$2,$3,$4,$5,true) RETURNING ${COLS}`,
        [tenantId, b.username, hashPassword(b.password), b.display_name ?? null, b.role ?? 'operator'],
      );
      return toPublic(r.rows[0]);
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// ============ 更新账户（显示名/角色/启用/手机号；重置密码走独立端点） ============
router.put('/accounts/:id', async (req, res, next) => {
  try {
    const auth = res.locals.auth as AuthLocals;
    const tenantId = auth.tenantId;
    const b = accountUpdateSchema.parse(req.body);
    // G7：phone 格式守卫（400 BAD_PARAM，设计稿口径；空串=清空合法）
    if (b.phone !== undefined && b.phone !== '' && !/^1\d{10}$/.test(b.phone)) {
      throw new AppError('BAD_PARAM', '手机号格式无效（需 1 开头的 11 位大陆手机号，空串=清空）', 400);
    }
    const callerRole = auth.role as Role;
    const item = await withTenantClient(tenantId, async (client) => {
      // G4：管理守卫统一 role.manage（async，闭包内查 role_permission）。
      await requirePermission(auth, client, 'role.manage');
      const cur = await client.query(`SELECT ${COLS} FROM account_user WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'account not found', 404);
      const target = cur.rows[0];
      const roleChange = b.role !== undefined && b.role !== target.role;
      const isSelf = String(req.params.id) === String(auth.userId);
      // canAssignRole（R15-005）：角色变更先过越级/铸 admin 门禁（设计稿状态机 C 层）
      if (roleChange && !canAssignRole(callerRole, b.role as Role)) {
        throw new AppError('FORBIDDEN', '无权分配该角色（不可越级或授予 admin）', 403);
      }
      // G3 SELF_GUARD：改自己角色 或 停用自己 → 403（设计稿状态机 D 层）。
      // 例外：改自己 display_name/phone 放行=合理自服务；把自己改成同角色属无操作不拦。
      if (isSelf && (roleChange || b.active === false)) {
        throw new AppError('SELF_GUARD', '不能变更自己的角色或停用自己——请由其他管理员操作', 403);
      }
      // G1+G2：last-admin 保护事务化 + 覆盖"降级"边。FOR UPDATE 锁全部 active admin 行，
      // 与下方 UPDATE 同闭包（withTenantClient BEGIN/COMMIT）→ 并发互停恰好一过一 409。
      const willLoseAdmin =
        target.role === 'admin' && target.active &&
        (b.active === false || roleChange);
      if (willLoseAdmin) {
        const admins = await client.query(
          `SELECT id FROM account_user WHERE tenant_id=$1 AND role='admin' AND active=true FOR UPDATE`,
          [tenantId],
        );
        if (!admins.rowCount || admins.rowCount <= 1) {
          throw new AppError('LAST_ADMIN', '至少需保留一个活跃管理员，该操作会锁死机构管理入口', 409);
        }
      }
      const sets: string[] = [];
      const params: unknown[] = [req.params.id, tenantId];
      const set = (col: string, v: unknown) => {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      };
      if (b.display_name !== undefined) set('display_name', b.display_name);
      if (b.role !== undefined) set('role', b.role);
      if (b.active !== undefined) set('active', b.active);
      if (b.phone !== undefined) set('phone', b.phone === '' ? null : b.phone); // 空串=清空（G7）
      if (sets.length === 0) return toPublic(target);
      sets.push('updated_at = now()');
      const r = await client.query(
        `UPDATE account_user SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING ${COLS}`,
        params,
      );
      return toPublic(r.rows[0]);
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// ============ 重置密码（G8，独立端点=二次确认语义） ============
// 服务端生成 12 位随机临时密码（去歧义字符集，无 0O1lI），hashPassword 落库，
// 明文仅本次响应返回一次（管理员不经手密码；用户侧引导经 PATCH /auth/change-password 自改）。
// 不触发 last-admin（重置密码不禁用账号）；SELF_GUARD：不可重置自己（自己有 change-password 链路）。
const TEMP_PWD_CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function generateTempPassword(length = 12): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += TEMP_PWD_CHARS[crypto.randomInt(0, TEMP_PWD_CHARS.length)];
  }
  return out;
}

router.post('/accounts/:id/reset-password', async (req, res, next) => {
  try {
    const auth = res.locals.auth as AuthLocals;
    const tenantId = auth.tenantId;
    const temp = generateTempPassword();
    await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'role.manage');
      const cur = await client.query(`SELECT id FROM account_user WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'account not found', 404);
      if (String(req.params.id) === String(auth.userId)) {
        throw new AppError('SELF_GUARD', '不能重置自己的密码——请使用「修改密码」功能', 403);
      }
      await client.query(
        `UPDATE account_user SET password_hash=$1, updated_at=now() WHERE id=$2 AND tenant_id=$3`,
        [hashPassword(temp), req.params.id, tenantId],
      );
    });
    return res.json({ ok: true, code: 0, temp_password: temp, once: true });
  } catch (e) {
    next(e);
  }
});

// ============ 删除账户（保护：至少保留一个活跃管理员，避免锁死登录） ============
router.delete('/accounts/:id', async (req, res, next) => {
  try {
    const auth = res.locals.auth as AuthLocals;
    const tenantId = auth.tenantId;
    // SELF_GUARD 同 PUT 口径：不能删除自己（防误操作自伤，G3 语义延伸）
    const n = await withTenantClient(tenantId, async (client) => {
      await requirePermission(auth, client, 'role.manage');
      const cur = await client.query(`SELECT id, role, active FROM account_user WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'account not found', 404);
      const target = cur.rows[0];
      if (String(req.params.id) === String(auth.userId)) {
        throw new AppError('SELF_GUARD', '不能删除自己的账号——请由其他管理员操作', 403);
      }
      if (target.role === 'admin' && target.active) {
        // G2 同口径：FOR UPDATE 事务化行锁
        const admins = await client.query(
          `SELECT id FROM account_user WHERE tenant_id=$1 AND role='admin' AND active=true FOR UPDATE`,
          [tenantId],
        );
        if (!admins.rowCount || admins.rowCount <= 1) {
          throw new AppError('LAST_ADMIN', '至少需保留一个活跃管理员，无法删除', 409);
        }
      }
      const r = await client.query(`DELETE FROM account_user WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      return r.rowCount ?? 0;
    });
    if (n === 0) throw new AppError('NOT_FOUND', 'account not found', 404);
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

export default router;
