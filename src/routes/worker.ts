// ② 主数据补全：人员(worker) CRUD。
// worker 表已在 001_init.sql 建好（text 主键 id=业务工号，RLS 已建），此前仅有内部种子与派单读取，
// 缺管理路由。本文件补齐 list/create/update/delete，风格对齐 asset.ts/material.ts：
//   withTenantClient 注入租户/RLS；写操作 requireConfigRole；占位符防注入。
// 技能匹配派单依赖 skill_tags / load / active，故暴露这些字段供管理员维护候选池。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requireConfigRole } from '../middleware/role.js';

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

export default router;
