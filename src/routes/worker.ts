// ② 主数据补全：人员(worker) CRUD。
// worker 表已在 001_init.sql 建好（text 主键 id=业务工号，RLS 已建），此前仅有内部种子与派单读取，
// 缺管理路由。本文件补齐 list/create/update/delete，风格对齐 asset.ts/material.ts：
//   withTenantClient 注入租户/RLS；写操作 requireConfigRole；占位符防注入。
// 技能匹配派单依赖 skill_tags / load / active，故暴露这些字段供管理员维护候选池。
// 注册制批次一（卡2）：新增 POST /workers/with-account —— 员工一键入驻：
//   单事务内同时建 account_user（登录账号，role=worker）+ worker（业务档案），密码一次性透出。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requireConfigRole, canAssignRole, type Role } from '../middleware/role.js';
import { hashPassword } from '../account.js';
import { generateAdminPassword } from '../repo/tenantProvision.js';

const router = Router();

const workerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  skill_tags: z.array(z.string()).optional(),
  load: z.number().int().nonnegative().optional(),
  active: z.boolean().optional(),
  // AL-001 修复（2026-09-04 对齐审查）：046 已建 worker.account_id 列+唯一索引，me/summary 按
  // 它反查工人（读路径在用），但本 schema 此前未暴露该字段——新建 worker 账号后无 API 关联
  // 档案，工作台 me/summary 404，只能 DB 手工 UPDATE。补齐读写透传（uuid，可选）。
  account_id: z.string().uuid().optional(),
});

// ============ 人员列表 ============
router.get('/workers', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const { name, skill, active } = req.query as Record<string, string>;
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      clauses.push(sql.replace(/\?/g, `$${params.length}`));
    };
    if (name) add('name ILIKE ?', `%${name}%`);
    if (skill) add('? = ANY(skill_tags)', skill);
    if (active === '0' || active === '1') add('active = ?', active === '1');
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT * FROM worker WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`, params)
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// ============ 人员详情 ============
router.get('/workers/:id', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, (client) =>
      client
        .query(`SELECT * FROM worker WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId])
        .then((r) => r.rows[0] ?? null),
    );
    if (!item) throw new AppError('NOT_FOUND', 'worker not found', 404);
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// ============ 新建人员 ============
router.post('/workers', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = workerSchema.parse(req.body);
    const item = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `INSERT INTO worker (id, tenant_id, name, skill_tags, load, active, account_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [b.id, tenantId, b.name, b.skill_tags ?? [], b.load ?? 0, b.active ?? true, b.account_id ?? null],
        )
        .then((r) => r.rows[0]),
    );
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// ============ 更新人员 ============
router.put('/workers/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const b = workerSchema.partial().parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const cur = await client.query(`SELECT * FROM worker WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'worker not found', 404);
      const sets: string[] = [];
      const params: unknown[] = [req.params.id, tenantId];
      const set = (col: string, v: unknown) => {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      };
      if (b.name !== undefined) set('name', b.name);
      if (b.skill_tags !== undefined) set('skill_tags', b.skill_tags);
      if (b.load !== undefined) set('load', b.load);
      if (b.active !== undefined) set('active', b.active);
      if (b.account_id !== undefined) set('account_id', b.account_id); // AL-001：档案↔账号关联可 API 维护
      if (sets.length === 0) return cur.rows[0];
      const r = await client.query(
        `UPDATE worker SET ${sets.join(', ')} WHERE id=$1 AND tenant_id=$2 RETURNING *`,
        params,
      );
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// ============ 删除人员（保护：在途工单孤儿引用） ============
router.delete('/workers/:id', async (req, res, next) => {
  try {
    requireConfigRole(req, res);
    const tenantId = res.locals.auth.tenantId;
    const n = await withTenantClient(tenantId, async (client) => {
      // 在途工单（已派单且未完成）仍指向该人员时拒绝删除，避免孤儿引用
      const inFlight = await client.query(
        `SELECT 1 FROM work_orders WHERE tenant_id=$1 AND assignee_id=$2 AND status <> 'completed' LIMIT 1`,
        [tenantId, req.params.id],
      );
      if (inFlight.rowCount && inFlight.rowCount > 0) {
        throw new AppError('CONFLICT', '该人员仍关联在途工单，无法删除', 409);
      }
      const r = await client.query(`DELETE FROM worker WHERE id=$1 AND tenant_id=$2`, [req.params.id, tenantId]);
      return r.rowCount ?? 0;
    });
    if (n === 0) throw new AppError('NOT_FOUND', 'worker not found', 404);
    return res.json({ ok: true, code: 0 });
  } catch (e) {
    next(e);
  }
});

// ============ 一键开通：账号 + 人员档案 单事务建档（注册制批次一 卡2） ============
// 契约：POST /workers/with-account
//   body: { username(>=2)*, display_name(>=1)*, phone?(/^1\d{10}$/), skill_tags?[], worker_id? }
//   201: { ok, code:0, item:<worker档案>, account:{id,username,display_name,role}, one_time_password }
//   409: 租户内用户名已存在 / 工号已存在；任一步失败整体回滚（withTenantClient 单连接事务）。
// R15-005 口径：callerRole 经 canAssignRole(callerRole,'worker') 校验（当前矩阵恒真，保持统一门禁）。
const withAccountSchema = z.object({
  username: z.string().min(2),
  display_name: z.string().min(1),
  phone: z.string().regex(/^1\d{10}$/).optional(),
  skill_tags: z.array(z.string()).optional(),
  worker_id: z.string().min(1).optional(),
});

// 工号自动生成：W + 4 位序号（按当前租户 worker 数 +1），预检撞号最多重试 3 次。
async function generateWorkerId(client: { query: Function }, tenantId: string): Promise<string> {
  const r = await client.query(`SELECT count(*)::int AS n FROM worker WHERE tenant_id=$1`, [tenantId]);
  const base = (r.rows[0]?.n ?? 0) + 1;
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = `W${String(base + attempt).padStart(4, '0')}`;
    const dup = await client.query(`SELECT 1 FROM worker WHERE tenant_id=$1 AND id=$2 LIMIT 1`, [tenantId, candidate]);
    if (!dup.rowCount || dup.rowCount === 0) return candidate;
  }
  throw new AppError('CONFLICT', '工号自动生成撞号，请手动指定工号', 409);
}

router.post('/workers/with-account', async (req, res, next) => {
  try {
    requireConfigRole(req, res); // 写操作同款门禁：仅 admin/operator
    const auth = res.locals.auth;
    // R15-005 统一口径：管理角色铸 worker 档案也过角色分配门禁
    if (!canAssignRole(auth.role as Role | undefined, 'worker')) {
      throw new AppError('FORBIDDEN', '无权创建人员账号', 403);
    }
    const tenantId = auth.tenantId;
    const b = withAccountSchema.parse(req.body);
    // 一次性密码（明文仅本次响应透出，与平台登记新机构同口径；DB 只存 scrypt 哈希）
    const oneTimePassword = generateAdminPassword();
    const result = await withTenantClient(tenantId, async (client) => {
      // ① 查重（先账号名后工号，均租户内唯一）
      const dupAcc = await client.query(
        `SELECT 1 FROM account_user WHERE tenant_id=$1 AND username=$2 LIMIT 1`,
        [tenantId, b.username],
      );
      if (dupAcc.rowCount && dupAcc.rowCount > 0) throw new AppError('CONFLICT', '该租户下用户名已存在', 409);
      const workerId = b.worker_id ?? (await generateWorkerId(client, tenantId));
      const dupWorker = await client.query(
        `SELECT 1 FROM worker WHERE tenant_id=$1 AND id=$2 LIMIT 1`,
        [tenantId, workerId],
      );
      if (dupWorker.rowCount && dupWorker.rowCount > 0) throw new AppError('CONFLICT', '该工号已存在', 409);
      // ② 建登录账号（role=worker；账号 id 由 DB uuid 默认生成，accounts.ts:152 同款插入形态）
      const acc = await client.query(
        `INSERT INTO account_user (tenant_id, username, password_hash, display_name, role, active)
         VALUES ($1,$2,$3,$4,'worker',true)
         RETURNING id, username, display_name, role`,
        [tenantId, b.username, hashPassword(oneTimePassword), b.display_name],
      );
      const account = acc.rows[0];
      // ③ 建业务档案（phone 直写 worker.phone 列，057 迁移已建）
      const w = await client.query(
        `INSERT INTO worker (id, tenant_id, name, skill_tags, load, active, phone, account_id)
         VALUES ($1,$2,$3,$4,0,true,$5,$6) RETURNING *`,
        [workerId, tenantId, b.display_name, b.skill_tags ?? [], b.phone ?? null, account.id],
      );
      return { worker: w.rows[0] as Record<string, unknown>, account: account as Record<string, unknown> };
    });
    return res.status(201).json({
      ok: true,
      code: 0,
      item: result.worker,
      account: {
        id: result.account.id,
        username: result.account.username,
        display_name: result.account.display_name,
        role: result.account.role,
      },
      one_time_password: oneTimePassword,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
