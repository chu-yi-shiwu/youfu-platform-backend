// 志愿者模块（批次 B · PRD §6.5）：活动 + 报名记录（状态机 + 服务时长 + 积分）。
// 风格对齐 config.ts；V1 批次（20260911）收口：
//   ① 守卫迁移：管理/读守卫改 requirePermission（volunteer.view / volunteer.manage / volunteer.audit），
//      因需查 role_permission 表（async），守卫调用一律在 withTenantClient 闭包内 await（RLS 纪律）；
//      GET /activities 保持仅登录（mp 报名入口依赖）；
//   ② signup 新增去重守卫：同 (activity_id, user_name) 命中 → 409 DUPLICATE「您已报名过该活动，无需重复报名」；
//   ③ GET /activities 补 signup_count（COUNT 子查询，供 mp/FE 展示"已报 X / 名额 Y"）；
//   ④ serving 死状态移除：报名记录状态机四态 registered → checked_in → checked_out → approved
//      （无任何 API 可置入 serving；FE/mp 的 serving 映射键保留为只读兼容，历史脏数据展示不炸）。
// B1 统一事件总线：关键业务动作 emit domain_event（过程挖掘统一数据源）。
import { Router } from 'express';
import { z } from 'zod';
import { withTenantClient } from '../db/pool.js';
import { AppError } from '../middleware/error.js';
import { requirePermission } from '../middleware/role.js';
import { emitDomainEvent } from '../db/eventBus.js';

const router = Router();

// ============ 活动 ============
const activitySchema = z.object({
  title: z.string().min(1),
  batch: z.string().optional(),
  location: z.string().optional(),
  start_at: z.string().optional(),
  end_at: z.string().optional(),
  slots: z.number().int().min(0).default(0),
});

// V2-UX D8（20260912）：服务端时间区间兜底校验——API 直调可绕过 mp/FE 前端校验，
// end_at ≤ start_at 一律 422 INVALID_RANGE。与 mp 前端 S1 校验同文案口径「结束时间必须晚于开始时间」。
function assertValidRange(startAt?: string, endAt?: string): void {
  if (startAt && endAt && new Date(endAt) <= new Date(startAt)) {
    throw new AppError('INVALID_RANGE', '结束时间必须晚于开始时间', 422);
  }
}

router.get('/activities', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    // V1：补 signup_count 子查询（不暴露 records 明细，仅人数），mp/FE 展示"已报 X / 名额 Y"。
    const items = await withTenantClient(tenantId, (client) =>
      client
        .query(
          `SELECT a.id, a.title, a.batch, a.location, a.start_at, a.end_at, a.slots, a.status, a.created_at,
                  (SELECT COUNT(*)::int FROM volunteer_record vr WHERE vr.tenant_id = a.tenant_id AND vr.activity_id = a.id) AS signup_count
           FROM volunteer_activity a WHERE a.tenant_id = $1 ORDER BY a.created_at DESC`,
          [tenantId],
        )
        .then((r) => r.rows),
    );
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.post('/activities', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = activitySchema.parse(req.body);
    // V2-UX D8：parse 后、入库前兜底（行为等价 zod refine）
    assertValidRange(b.start_at, b.end_at);
    const item = await withTenantClient(tenantId, async (client) => {
      // V1 守卫迁移：requirePermission 需查 role_permission 表（async），必须用闭包内 client。
      await requirePermission(res.locals.auth, client, 'volunteer.manage');
      const r = await client.query(
        `INSERT INTO volunteer_activity (tenant_id, title, batch, location, start_at, end_at, slots, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'open') RETURNING *`,
        [tenantId, b.title, b.batch ?? null, b.location ?? null, b.start_at ?? null, b.end_at ?? null, b.slots],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'volunteer_activity', entityId: row.id, type: 'create', actor: 'config_role' });
      return row;
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// P1：活动关闭/重开端点（审查报告 20260908 P1 项）。status 仅 open|closed 双态；
// 关闭后 signup 端点既有守卫（status!=='open' → 409"活动已关闭"）自然生效，无需重复校验。
// 幂等：对同值重放直接 UPDATE 成功（不 409，管理端按钮可重复点）。
router.put('/activities/:id/status', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ status: z.enum(['open', 'closed']) }).parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      // V1 守卫迁移：闭包内权限判定（role_permission 表查询）。
      await requirePermission(res.locals.auth, client, 'volunteer.manage');
      const r = await client.query(
        `UPDATE volunteer_activity SET status = $3 WHERE id = $1 AND tenant_id = $2 RETURNING id, title, status`,
        [req.params.id, tenantId, b.status],
      );
      if (r.rowCount === 0) throw new AppError('NOT_FOUND', 'activity not found', 404);
      await emitDomainEvent(client, {
        tenantId,
        entityType: 'volunteer_activity',
        entityId: req.params.id,
        type: b.status === 'closed' ? 'close' : 'reopen',
        actor: 'config_role',
      });
      return r.rows[0];
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.get('/activities/:id/records', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, async (client) => {
      // V1：报名明细属管理面数据，收口 volunteer.view（原仅登录）。
      await requirePermission(res.locals.auth, client, 'volunteer.view');
      return client
        .query(
          `SELECT id, activity_id, user_name, status, check_in_at, check_out_at, duration_min, points, created_at
           FROM volunteer_record WHERE tenant_id = $1 AND activity_id = $2 ORDER BY created_at ASC`,
          [tenantId, req.params.id],
        )
        .then((r) => r.rows);
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

// 报名（普通用户即可，仅登录；V1 新增去重守卫）
router.post('/activities/:id/signup', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const b = z.object({ user_name: z.string().min(1) }).parse(req.body);
    const item = await withTenantClient(tenantId, async (client) => {
      const act = await client.query(
        `SELECT id, status, slots, end_at FROM volunteer_activity WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [req.params.id, tenantId],
      );
      if (act.rowCount === 0) throw new AppError('NOT_FOUND', 'activity not found', 404);
      if (act.rows[0].status !== 'open') throw new AppError('BAD_STATE', '活动已关闭，无法报名', 409);
      // V2-UX F6/D5（20260912）：end_at 过期守卫——置于 status 检查之后、去重之前。
      // D5 顺序成文：status 优先于 end_at（closed 活动对外永远提示"已截止"，与 V1 口径一致；
      // 即使 end_at 同时已过，也只提示"已关闭"），后续守卫（去重/名额）在其之后。
      // end_at 为 null 放行（S7 存量兼容：历史活动从未填过结束时间，不得一刀切误杀）。
      const endAt = act.rows[0].end_at;
      if (endAt !== null && endAt !== undefined && new Date(endAt) < new Date()) {
        throw new AppError('ACTIVITY_ENDED', '该活动已结束，无法报名', 409);
      }
      // V1 去重守卫（置于状态检查之后：closed 活动对外永远提示"已截止"，口径唯一；
      // 已报名者优先收"已报名"语义——比"名额已满"更准确）。判重键 user_name 文本为 V1 接受项（V2 挂 user_id 列）。
      const dup = await client.query(
        `SELECT id FROM volunteer_record WHERE tenant_id = $1 AND activity_id = $2 AND user_name = $3 LIMIT 1`,
        [tenantId, req.params.id, b.user_name],
      );
      if (dup.rowCount && dup.rowCount > 0) {
        throw new AppError('DUPLICATE', '您已报名过该活动，无需重复报名', 409);
      }
      const cnt = await client.query(
        `SELECT count(*)::int AS n FROM volunteer_record WHERE activity_id = $1 AND tenant_id = $2`,
        [req.params.id, tenantId],
      );
      if (cnt.rows[0].n >= act.rows[0].slots) throw new AppError('BAD_STATE', '报名名额已满', 409);
      const r = await client.query(
        `INSERT INTO volunteer_record (tenant_id, activity_id, user_name, status) VALUES ($1,$2,$3,'registered') RETURNING *`,
        [tenantId, req.params.id, b.user_name],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'volunteer_record', entityId: row.id, type: 'signup', actor: 'user' });
      return row;
    });
    return res.status(201).json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// 签退时长/积分计算（纯函数便于单测）：时长向下取整到分钟，积分 = floor(分钟/60)
export function computeCheckout(checkInAt: string | Date, checkOutAt: string | Date): { duration_min: number; points: number } {
  const ms = new Date(checkOutAt).getTime() - new Date(checkInAt).getTime();
  const durationMin = ms > 0 ? Math.floor(ms / 60000) : 0;
  return { duration_min: durationMin, points: Math.floor(durationMin / 60) };
}

router.post('/records/:id/checkin', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      // V1 守卫迁移：现场执行动作收口 volunteer.audit（原 requireConfigRole / basicdata.edit）。
      await requirePermission(res.locals.auth, client, 'volunteer.audit');
      const cur = await client.query(`SELECT * FROM volunteer_record WHERE id = $1 AND tenant_id = $2`, [
        req.params.id,
        tenantId,
      ]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'record not found', 404);
      // V1 serving 死状态移除：状态机仅认 registered（serving 无任何 API 可置入，历史脏数据走数据卫生清洗）。
      if (cur.rows[0].status !== 'registered') {
        throw new AppError('BAD_STATE', '只能对已报名的记录签到', 409);
      }
      const r = await client.query(
        `UPDATE volunteer_record SET status = 'checked_in', check_in_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [req.params.id, tenantId],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'volunteer_record', entityId: row.id, type: 'checkin', actor: 'config_role' });
      return row;
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.post('/records/:id/checkout', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      // V1 守卫迁移：volunteer.audit（闭包内）。
      await requirePermission(res.locals.auth, client, 'volunteer.audit');
      const cur = await client.query(`SELECT * FROM volunteer_record WHERE id = $1 AND tenant_id = $2`, [
        req.params.id,
        tenantId,
      ]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'record not found', 404);
      const rec = cur.rows[0];
      if (!rec.check_in_at) throw new AppError('BAD_STATE', 'must check in before checkout', 409);
      if (rec.status !== 'checked_in') throw new AppError('BAD_STATE', '仅 checked_in 状态可签退', 409);
      const { duration_min, points } = computeCheckout(rec.check_in_at, new Date());
      const r = await client.query(
        `UPDATE volunteer_record SET status = 'checked_out', check_out_at = now(), duration_min = $3, points = $4 WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [req.params.id, tenantId, duration_min, points],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'volunteer_record', entityId: row.id, type: 'checkout', actor: 'config_role' });
      return row;
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

router.post('/records/:id/approve', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const item = await withTenantClient(tenantId, async (client) => {
      // V1 守卫迁移：volunteer.audit（闭包内）。
      await requirePermission(res.locals.auth, client, 'volunteer.audit');
      const cur = await client.query(`SELECT * FROM volunteer_record WHERE id = $1 AND tenant_id = $2`, [
        req.params.id,
        tenantId,
      ]);
      if (cur.rowCount === 0) throw new AppError('NOT_FOUND', 'record not found', 404);
      if (cur.rows[0].status !== 'checked_out') {
        throw new AppError('BAD_STATE', '只能对已签退的记录审批（先完成签到/签退）', 409);
      }
      const r = await client.query(
        `UPDATE volunteer_record SET status = 'approved' WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [req.params.id, tenantId],
      );
      const row = r.rows[0];
      await emitDomainEvent(client, { tenantId, entityType: 'volunteer_record', entityId: row.id, type: 'approve', actor: 'config_role' });
      return row;
    });
    return res.json({ ok: true, code: 0, item });
  } catch (e) {
    next(e);
  }
});

// P1：志愿者人员档案维度（审查报告 P2 项提级）。只读聚合：按 user_name 归并全部报名记录，
// 产出报名数/审批数/累计时长/累计积分/最近动态——人员级视图，activity 级明细不动、零 DDL。
// V1：守卫迁移 → volunteer.view（闭包内）。
router.get('/people', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const items = await withTenantClient(tenantId, async (client) => {
      await requirePermission(res.locals.auth, client, 'volunteer.view');
      return client
        .query(
          `SELECT user_name,
                  COUNT(*)::int AS signup_count,
                  COUNT(*) FILTER (WHERE status = 'approved')::int AS approved_count,
                  COALESCE(SUM(duration_min), 0)::int AS total_duration_min,
                  COALESCE(SUM(points), 0)::int AS total_points,
                  MAX(created_at) AS last_activity_at
           FROM volunteer_record WHERE tenant_id = $1
           GROUP BY user_name ORDER BY total_points DESC, user_name ASC`,
          [tenantId],
        )
        .then((r) => r.rows);
    });
    return res.json({ ok: true, code: 0, items });
  } catch (e) {
    next(e);
  }
});

router.get('/stats', async (req, res, next) => {
  try {
    const tenantId = res.locals.auth.tenantId;
    const stats = await withTenantClient(tenantId, async (client) => {
      // V1：守卫迁移 → volunteer.view（闭包内）。
      await requirePermission(res.locals.auth, client, 'volunteer.view');
      return client
        .query(
          `SELECT
             COUNT(*) FILTER (WHERE status = 'registered') AS registered_count,
             -- V1 四态口径：serving 死状态已移除，不再参与 served_count 统计
             COUNT(*) FILTER (WHERE status IN ('checked_in','checked_out','approved')) AS served_count,
             COALESCE(SUM(duration_min), 0) AS total_duration_min,
             COALESCE(SUM(points), 0) AS total_points
           FROM volunteer_record WHERE tenant_id = $1`,
          [tenantId],
        )
        .then((r) => r.rows[0]);
    });
    return res.json({ ok: true, code: 0, stats });
  } catch (e) {
    next(e);
  }
});

export default router;
